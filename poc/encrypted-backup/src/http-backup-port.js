import {
  createRecoveryBundle,
  encryptBackup,
  shouldCreateFullCheckpoint,
  restoreBackupChain,
  restoreBackupChainWithKey,
} from "./index.js";
import { createBrowserBackupKeyStore } from "./browser-key-store.js";

function uuid() { return crypto.randomUUID(); }
function endpoint(baseUrl, path) { return baseUrl.replace(/\/+$/, "") + path; }

export function createHttpEncryptedBackupPort({
  baseUrl,
  datasetId,
  getAccessToken,
  onRecoveryCredential,
  keyStore = createBrowserBackupKeyStore(),
  fetchImpl = globalThis.fetch,
  kdfIterations = 600_000,
  chunkBytes = 256 * 1024,
  checkpointInterval = 10,
  keyVersion = 1,
} = {}) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new TypeError("baseUrl is required");
  if (typeof datasetId !== "string" || !datasetId.trim()) throw new TypeError("datasetId is required");
  if (typeof getAccessToken !== "function") throw new TypeError("getAccessToken is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is unavailable");

  async function request(path, { method = "GET", body, bytes, headers = {}, expect = "json" } = {}) {
    const token = await getAccessToken();
    if (typeof token !== "string" || !token.trim()) throw new Error("Backup API access token is unavailable");
    const requestHeaders = { Authorization: "Bearer " + token, ...headers };
    let requestBody = bytes;
    if (body !== undefined) {
      requestHeaders["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
    const response = await fetchImpl(endpoint(baseUrl, path), { method, headers: requestHeaders, body: requestBody });
    if (!response.ok) {
      let detail = "Backup API request failed (" + response.status + ")";
      try {
        const payload = await response.json();
        detail = payload.error?.message || payload.message || detail;
      } catch {}
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204 || expect === "none") return null;
    if (expect === "bytes") return new Uint8Array(await response.arrayBuffer());
    return response.json();
  }

  async function createOrLoadKeyState() {
    let state = await keyStore.get(datasetId);
    if (state?.dataKey && state.keyEnvelope) return state;
    if (typeof onRecoveryCredential !== "function") {
      throw new Error("首次加密备份必须配置 onRecoveryCredential，并要求用户保存独立恢复凭证后确认。");
    }
    const bundle = await createRecoveryBundle(datasetId, undefined, { iterations: kdfIterations });
    const acknowledged = await onRecoveryCredential(bundle.recoveryCredential);
    if (acknowledged !== true) throw new Error("用户尚未确认保存独立恢复凭证，已停止上传。");
    state = {
      dataKey: bundle.dataKey,
      keyEnvelope: bundle.keyEnvelope,
      lastSnapshot: null,
      lastBackupId: null,
      backupCountSinceFull: 0,
      keyVersion,
      pendingUpload: null,
    };
    await keyStore.put(datasetId, state);
    return state;
  }

  async function preparePendingUpload(snapshot, state) {
    const forceFull = !state.lastSnapshot || !state.lastBackupId ||
      state.lastSnapshot.schemaVersion !== snapshot.schemaVersion ||
      shouldCreateFullCheckpoint(state.backupCountSinceFull || 0, checkpointInterval);
    const backup = await encryptBackup(snapshot, {
      dataKey: state.dataKey,
      keyEnvelope: state.keyEnvelope,
      parentBackupId: forceFull ? null : state.lastBackupId,
      previousSnapshot: forceFull ? null : state.lastSnapshot,
      forceFull,
      chunkBytes,
      keyVersion: state.keyVersion || keyVersion,
    });
    return {
      backup,
      snapshotSequence: snapshot.dirtySequence,
      initIdempotencyKey: uuid(),
      completeIdempotencyKey: uuid(),
      sessionExpiresAt: null,
    };
  }

  async function uploadSnapshot(snapshot) {
    if (snapshot.datasetId !== datasetId) throw new Error("Backup snapshot belongs to a different dataset");
    let state = await createOrLoadKeyState();
    if (state.lastSnapshot && snapshot.dirtySequence < state.lastSnapshot.dirtySequence) {
      throw new Error("Local snapshot sequence moved behind the last committed backup");
    }
    if (state.lastSnapshot && snapshot.dirtySequence === state.lastSnapshot.dirtySequence && state.lastBackupId) {
      return { backupId: state.lastBackupId, idempotent: true };
    }
    let pending = state.pendingUpload;
    if (!pending || pending.snapshotSequence !== snapshot.dirtySequence) {
      pending = await preparePendingUpload(snapshot, state);
      state = { ...state, pendingUpload: pending };
      await keyStore.put(datasetId, state);
    }

    const manifest = pending.backup.manifest;
    const initBody = {
      dataset_id: datasetId,
      backup_id: manifest.backupId,
      backup_sequence: manifest.backupSequence,
      parent_backup_id: manifest.parentBackupId,
      backup_type: manifest.backupType,
      schema_version: manifest.schemaVersion,
      cipher_suite: manifest.cipherSuite,
      key_version: manifest.keyVersion,
      ciphertext_size: manifest.ciphertextSize,
      ciphertext_hash: manifest.ciphertextHash,
      part_count: manifest.partCount,
      client_manifest: manifest,
    };
    let session;
    try {
      session = await request("/v1/backups/init", {
        method: "POST",
        body: initBody,
        headers: { "Idempotency-Key": pending.initIdempotencyKey },
      });
    } catch (error) {
      if (error.status === 410) {
        pending = { ...pending, initIdempotencyKey: uuid(), sessionExpiresAt: null };
        state = { ...state, pendingUpload: pending };
        await keyStore.put(datasetId, state);
        session = await request("/v1/backups/init", {
          method: "POST",
          body: initBody,
          headers: { "Idempotency-Key": pending.initIdempotencyKey },
        });
      } else {
        throw error;
      }
    }
    if (session.backup_id !== manifest.backupId || !Number.isSafeInteger(session.part_size_limit) ||
        !Array.isArray(session.received_parts)) {
      throw new Error("Backup API returned an invalid upload session");
    }
    if (pending.backup.chunks.some((part) => part.byteLength > session.part_size_limit)) {
      throw new Error("Encrypted part exceeds server part_size_limit; reduce backup chunkBytes and retry");
    }
    pending = { ...pending, sessionExpiresAt: session.upload_expires_at };
    state = { ...state, pendingUpload: pending };
    await keyStore.put(datasetId, state);

    const received = new Set(session.received_parts);
    for (let index = 0; index < pending.backup.chunks.length; index += 1) {
      if (received.has(index)) continue;
      const chunk = pending.backup.chunks[index];
      const descriptor = manifest.chunks[index];
      await request("/v1/backups/" + manifest.backupId + "/parts/" + index, {
        method: "PUT",
        bytes: chunk,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Part-SHA256": descriptor.sha256,
        },
        expect: "none",
      });
    }
    const committed = await request("/v1/backups/" + manifest.backupId + "/complete", {
      method: "POST",
      body: { part_count: manifest.partCount, ciphertext_hash: manifest.ciphertextHash },
      headers: { "Idempotency-Key": pending.completeIdempotencyKey },
    });
    if (committed.backup_id !== manifest.backupId || committed.status !== "committed") {
      throw new Error("Backup API did not confirm the encrypted backup");
    }
    const nextState = {
      ...state,
      lastSnapshot: snapshot,
      lastBackupId: manifest.backupId,
      backupCountSinceFull: manifest.backupType === "full" ? 0 : (state.backupCountSinceFull || 0) + 1,
      pendingUpload: null,
    };
    await keyStore.put(datasetId, nextState);
    return { backupId: manifest.backupId, idempotent: false };
  }

  async function listBackups() {
    const items = [];
    let cursor = null;
    do {
      const query = new URLSearchParams({ dataset_id: datasetId });
      if (cursor) query.set("cursor", cursor);
      const page = await request("/v1/backups?" + query.toString());
      if (!Array.isArray(page.items)) throw new Error("Backup API returned an invalid backup list");
      items.push(...page.items);
      cursor = page.next_cursor || null;
    } while (cursor);
    return items;
  }

  async function downloadBackup(record) {
    const response = await fetchImpl(endpoint(baseUrl, "/v1/backups/" + record.backup_id + "/download"), {
      method: "GET",
      headers: { Authorization: "Bearer " + await getAccessToken() },
    });
    if (!response.ok) throw new Error("Backup download failed (" + response.status + ")");
    let bytes;
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      const envelope = await response.json();
      if (envelope.client_manifest) record.client_manifest = envelope.client_manifest;
      const signed = await fetchImpl(envelope.download_url);
      if (!signed.ok) throw new Error("Signed backup download failed (" + signed.status + ")");
      bytes = new Uint8Array(await signed.arrayBuffer());
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    const manifest = record.client_manifest;
    if (!manifest || !Array.isArray(manifest.chunks)) throw new Error("Backup record has no client manifest");
    const chunks = [];
    let offset = 0;
    for (const descriptor of manifest.chunks) {
      const end = offset + descriptor.byteLength;
      if (end > bytes.length) throw new Error("Downloaded backup is missing encrypted bytes");
      chunks.push(bytes.slice(offset, end));
      offset = end;
    }
    if (offset !== bytes.length) throw new Error("Downloaded backup contains unexpected trailing bytes");
    return { manifest, chunks };
  }

  async function loadRestoreChain() {
    const records = await listBackups();
    if (!records.length) throw new Error("No committed backups are available for this dataset");
    const byId = new Map(records.map((record) => [record.backup_id, record]));
    const latest = [...records].sort((a, b) => b.backup_sequence - a.backup_sequence)[0];
    const chain = [];
    let current = latest;
    const seen = new Set();
    while (current) {
      if (seen.has(current.backup_id)) throw new Error("Backup parent chain contains a cycle");
      seen.add(current.backup_id);
      chain.unshift(await downloadBackup(current));
      current = current.parent_backup_id ? byId.get(current.parent_backup_id) : null;
      if (chain.length > records.length) throw new Error("Backup parent chain is invalid");
    }
    if (chain[0].manifest.backupType !== "full") throw new Error("Latest backup chain does not reach a full checkpoint");
    return chain;
  }

  async function restoreSnapshot(recoveryCredential) {
    const chain = await loadRestoreChain();
    return restoreBackupChain(chain, recoveryCredential);
  }

  async function restoreToRepository(repository, recoveryCredential) {
    const chain = await loadRestoreChain();
    const restored = await restoreBackupChainWithKey(chain, recoveryCredential);
    const previousKeyState = await keyStore.get(datasetId);
    await keyStore.put(datasetId, {
      dataKey: restored.dataKey,
      keyEnvelope: restored.keyEnvelope,
      lastSnapshot: restored.snapshot,
      lastBackupId: restored.backupId,
      backupCountSinceFull: restored.backupsSinceFull,
      keyVersion: restored.keyVersion || keyVersion,
      pendingUpload: null,
    });
    try {
      await repository.restoreSnapshot(datasetId, restored.snapshot, restored.backupId, new Date().toISOString());
      const migratedSnapshot = await repository.createConsistentSnapshot(datasetId);
      await keyStore.put(datasetId, {
        dataKey: restored.dataKey,
        keyEnvelope: restored.keyEnvelope,
        lastSnapshot: migratedSnapshot,
        lastBackupId: restored.backupId,
        backupCountSinceFull: restored.backupsSinceFull,
        keyVersion: restored.keyVersion || keyVersion,
        pendingUpload: null,
      });
    } catch (error) {
      if (previousKeyState) await keyStore.put(datasetId, previousKeyState);
      else await keyStore.delete(datasetId);
      throw error;
    }
    return { snapshot: restored.snapshot, backupId: restored.backupId };
  }

  async function clearDataSet() {
    return request("/v1/data-sets/" + datasetId + "/clear", {
      method: "POST",
      body: { confirmation: "CLEAR_DATASET" },
      headers: { "Idempotency-Key": uuid() },
    });
  }

  return Object.freeze({ uploadSnapshot, listBackups, restoreSnapshot, restoreToRepository, clearDataSet });
}
