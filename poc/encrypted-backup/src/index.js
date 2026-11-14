const FORMAT_VERSION = 1;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_KDF_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requireValue(value, name) {
  if (value === undefined || value === null || value === "") throw new TypeError(name + " is required");
  return value;
}
function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toBase64(new Uint8Array(digest));
}
function aadForChunk({ datasetId, backupId, parentBackupId, schemaVersion, chunkIndex }) {
  return encoder.encode(canonicalJson({
    formatVersion: FORMAT_VERSION,
    datasetId,
    backupId,
    parentBackupId,
    schemaVersion,
    chunkIndex,
  }));
}
function recordKey(collection, record) {
  const keys = {
    threads: "id",
    messages: "message.id",
    readingRounds: "id",
    readingPositions: "threadId",
    citations: "id",
    notes: "id",
    memories: "id",
    memoryVersions: "id",
    memoryRelations: "id",
    generationDeliveries: "clientGenerationId",
  };
  const path = keys[collection];
  if (!path) throw new Error("Unknown snapshot collection: " + collection);
  return path.split(".").reduce((value, key) => value?.[key], record);
}
const COLLECTIONS = [
  "threads", "messages", "readingRounds", "readingPositions", "citations",
  "notes", "memories", "memoryVersions", "memoryRelations", "memoryCandidates", "generationDeliveries",
];

export async function createRecoveryBundle(datasetId, recoveryCredential = toBase64(randomBytes(32)), options = {}) {
  requireValue(datasetId, "datasetId");
  const iterations = options.iterations ?? DEFAULT_KDF_ITERATIONS;
  if (!Number.isSafeInteger(iterations) || iterations < 100_000) throw new RangeError("PBKDF2 iterations must be >= 100000");
  const credentialBytes = fromBase64(recoveryCredential);
  if (credentialBytes.length < 32) throw new TypeError("Recovery credential must contain at least 256 bits");
  const dataKey = randomBytes(32);
  const rawDataKey = dataKey;
  const salt = randomBytes(16);
  const wrappingMaterial = await crypto.subtle.importKey("raw", credentialBytes, "PBKDF2", false, ["deriveKey"]);
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    wrappingMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const nonce = randomBytes(12);
  const aad = encoder.encode(canonicalJson({ formatVersion: FORMAT_VERSION, datasetId, purpose: "wrap-dataset-key" }));
  const wrappedKey = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, wrappingKey, rawDataKey);
  return {
    dataKey,
    recoveryCredential,
    keyEnvelope: {
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2-SHA-256",
      iterations,
      salt: toBase64(salt),
      nonce: toBase64(nonce),
      wrappedKey: toBase64(new Uint8Array(wrappedKey)),
    },
  };
}

async function unwrapDataKey(datasetId, keyEnvelope, recoveryCredential) {
  if (keyEnvelope.algorithm !== "AES-256-GCM" || keyEnvelope.kdf !== "PBKDF2-SHA-256") {
    throw new Error("Unsupported backup key envelope");
  }
  const credentialBytes = fromBase64(recoveryCredential);
  const material = await crypto.subtle.importKey("raw", credentialBytes, "PBKDF2", false, ["deriveKey"]);
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromBase64(keyEnvelope.salt), iterations: keyEnvelope.iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const aad = encoder.encode(canonicalJson({ formatVersion: FORMAT_VERSION, datasetId, purpose: "wrap-dataset-key" }));
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(keyEnvelope.nonce), additionalData: aad, tagLength: 128 },
    wrappingKey,
    fromBase64(keyEnvelope.wrappedKey),
  );
  return new Uint8Array(raw);
}

export function createBackupPayload(snapshot, previousSnapshot = null) {
  requireValue(snapshot?.datasetId, "snapshot.datasetId");
  if (!Number.isSafeInteger(snapshot.schemaVersion) || !Number.isSafeInteger(snapshot.dirtySequence)) {
    throw new TypeError("Snapshot schemaVersion and dirtySequence must be integers");
  }
  if (!previousSnapshot) return { kind: "full", snapshot: canonicalize(snapshot) };
  if (previousSnapshot.datasetId !== snapshot.datasetId) throw new Error("Incremental backup cannot cross datasets");
  if (snapshot.dirtySequence <= previousSnapshot.dirtySequence) throw new Error("Snapshot has no unacknowledged sequence advance");
  const upserts = {};
  const removals = {};
  for (const collection of COLLECTIONS) {
    const previous = new Map((previousSnapshot[collection] || []).map((item) => [recordKey(collection, item), item]));
    const current = new Map((snapshot[collection] || []).map((item) => [recordKey(collection, item), item]));
    upserts[collection] = [...current.entries()]
      .filter(([key, value]) => !previous.has(key) || canonicalJson(previous.get(key)) !== canonicalJson(value))
      .map(([, value]) => canonicalize(value));
    removals[collection] = [...previous.keys()].filter((key) => !current.has(key));
  }
  return {
    kind: "delta",
    datasetId: snapshot.datasetId,
    schemaVersion: snapshot.schemaVersion,
    dirtySequence: snapshot.dirtySequence,
    upserts,
    removals,
  };
}

async function deriveBackupChunkKey(masterKey, datasetId, backupId) {
  const material = await crypto.subtle.importKey("raw", masterKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(datasetId + ":" + backupId), info: encoder.encode("read-book-backup-chunk-key-v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
function nonceForChunk(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) throw new RangeError("chunk index exceeds nonce counter range");
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(8, index, false);
  return nonce;
}

export function shouldCreateFullCheckpoint(backupsSinceFull, interval = 10) {
  if (!Number.isSafeInteger(backupsSinceFull) || backupsSinceFull < 0 ||
      !Number.isSafeInteger(interval) || interval < 1) throw new RangeError("Checkpoint counters must be non-negative and interval positive");
  return backupsSinceFull >= interval;
}

export async function encryptBackup(snapshot, options = {}) {
  const dataKey = requireValue(options?.dataKey, "dataKey");
  const keyEnvelope = requireValue(options?.keyEnvelope, "keyEnvelope");
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1024) throw new RangeError("chunkBytes must be >= 1024");
  const parentBackupId = options.forceFull ? null : options.parentBackupId ?? null;
  const backupId = options.backupId ?? crypto.randomUUID();
  if (options.forceFull && options.parentBackupId) throw new Error("A full checkpoint cannot have a parent backup");
  const payload = options.forceFull ? createBackupPayload(snapshot, null) : createBackupPayload(snapshot, options.previousSnapshot ?? null);
  const backupKey = await deriveBackupChunkKey(dataKey, snapshot.datasetId, backupId);
  const plaintext = encoder.encode(canonicalJson(payload));
  const chunks = [];
  const descriptors = [];
  for (let offset = 0, chunkIndex = 0; offset < plaintext.length; offset += chunkBytes, chunkIndex += 1) {
    const clear = plaintext.slice(offset, Math.min(offset + chunkBytes, plaintext.length));
    const nonce = nonceForChunk(chunkIndex);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: aadForChunk({
          datasetId: snapshot.datasetId,
          backupId,
          parentBackupId,
          schemaVersion: snapshot.schemaVersion,
          chunkIndex,
        }),
        tagLength: 128,
      },
      backupKey,
      clear,
    ));
    chunks.push(encrypted);
    descriptors.push({ index: chunkIndex, nonce: toBase64(nonce), sha256: await sha256(encrypted), byteLength: encrypted.length });
  }
  return {
    manifest: {
      format: "read-book-encrypted-backup",
      formatVersion: FORMAT_VERSION,
      datasetId: snapshot.datasetId,
      backupId,
      parentBackupId,
      kind: payload.kind,
      schemaVersion: snapshot.schemaVersion,
      dirtySequence: snapshot.dirtySequence,
      plaintextBytes: plaintext.length,
      chunkCount: chunks.length,
      chunks: descriptors,
      keyEnvelope: canonicalize(keyEnvelope),
      createdAt: new Date().toISOString(),
    },
    chunks,
  };
}

async function decryptBackup(backup, recoveryCredential) {
  const manifest = backup?.manifest;
  if (!manifest || manifest.format !== "read-book-encrypted-backup" || manifest.formatVersion !== FORMAT_VERSION) {
    throw new Error("Unsupported backup manifest");
  }
  if (!Array.isArray(backup.chunks) || backup.chunks.length !== manifest.chunkCount ||
      !Array.isArray(manifest.chunks) || manifest.chunks.length !== manifest.chunkCount) {
    throw new Error("Backup chunk set is incomplete");
  }
  const masterKey = await unwrapDataKey(manifest.datasetId, manifest.keyEnvelope, recoveryCredential);
  const backupKey = await deriveBackupChunkKey(masterKey, manifest.datasetId, manifest.backupId);
  const clearChunks = [];
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const descriptor = manifest.chunks[index];
    const encrypted = backup.chunks[index];
    if (!descriptor || descriptor.index !== index || !(encrypted instanceof Uint8Array)) {
      throw new Error("Backup chunk order or type is invalid");
    }
    if (await sha256(encrypted) !== descriptor.sha256 || encrypted.length !== descriptor.byteLength) {
      throw new Error("Backup chunk hash or length mismatch");
    }
    if (toBase64(nonceForChunk(index)) !== descriptor.nonce) throw new Error("Backup chunk nonce counter is invalid");
    const clear = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(descriptor.nonce),
        additionalData: aadForChunk({
          datasetId: manifest.datasetId,
          backupId: manifest.backupId,
          parentBackupId: manifest.parentBackupId,
          schemaVersion: manifest.schemaVersion,
          chunkIndex: index,
        }),
        tagLength: 128,
      },
      backupKey,
      encrypted,
    );
    clearChunks.push(new Uint8Array(clear));
  }
  const length = clearChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (length !== manifest.plaintextBytes) throw new Error("Backup plaintext length mismatch");
  const plaintext = new Uint8Array(length);
  let offset = 0;
  for (const chunk of clearChunks) { plaintext.set(chunk, offset); offset += chunk.length; }
  return { manifest, payload: JSON.parse(decoder.decode(plaintext)) };
}

export async function restoreBackupChain(backups, recoveryCredential) {
  if (!Array.isArray(backups) || backups.length === 0) throw new Error("Backup chain is empty");
  let snapshot = null;
  let previousBackupId = null;
  let datasetId = null;
  for (let index = 0; index < backups.length; index += 1) {
    const { manifest, payload } = await decryptBackup(backups[index], recoveryCredential);
    if (index === 0 && (manifest.kind !== "full" || manifest.parentBackupId !== null || payload.kind !== "full")) {
      throw new Error("Backup chain must start with a full backup");
    }
    if (index > 0 && (manifest.parentBackupId !== previousBackupId || manifest.kind !== "delta" || payload.kind !== "delta")) {
      throw new Error("Backup parent chain is broken");
    }
    if (datasetId && manifest.datasetId !== datasetId) throw new Error("Backup chain crosses datasets");
    datasetId = manifest.datasetId;
    if (payload.kind === "full") {
      if (index !== 0) throw new Error("A full backup cannot appear inside an incremental chain");
      snapshot = payload.snapshot;
    } else {
      if (!snapshot || payload.datasetId !== datasetId) throw new Error("Incremental backup has no matching full parent");
      snapshot = { ...snapshot, schemaVersion: payload.schemaVersion, dirtySequence: payload.dirtySequence };
      for (const collection of COLLECTIONS) {
        const map = new Map((snapshot[collection] || []).map((item) => [recordKey(collection, item), item]));
        for (const key of payload.removals[collection] || []) map.delete(key);
        for (const item of payload.upserts[collection] || []) map.set(recordKey(collection, item), item);
        snapshot[collection] = [...map.values()];
      }
    }
    if (snapshot.datasetId !== datasetId || snapshot.schemaVersion !== manifest.schemaVersion ||
        snapshot.dirtySequence !== manifest.dirtySequence) {
      throw new Error("Restored snapshot does not match the encrypted manifest");
    }
    previousBackupId = manifest.backupId;
  }
  return snapshot;
}

export async function uploadBackupResumable(server, backup, token = server.beginUpload(backup.manifest.datasetId)) {
  const uploaded = new Set(server.getUploadProgress(token));
  for (let index = 0; index < backup.chunks.length; index += 1) {
    if (!uploaded.has(index)) server.uploadChunk(token, index, backup.chunks[index]);
  }
  const receipt = await server.completeUpload(token, backup.manifest);
  return { ...receipt, uploadSessionToken: token };
}

/** Mock server stores ciphertext only and enforces the cleared-dataset tombstone at upload completion and download. */
export function createMockBackupServer() {
  const backups = new Map();
  const tombstones = new Map();
  const sessions = new Map();
  return Object.freeze({
    beginUpload(datasetId) {
      requireValue(datasetId, "datasetId");
      if (tombstones.has(datasetId)) throw new Error("Dataset is cleared");
      const token = crypto.randomUUID();
      sessions.set(token, { datasetId, chunks: new Map() });
      return token;
    },
    uploadChunk(token, index, chunk) {
      const session = sessions.get(token);
      if (!session) throw new Error("Upload session is missing or expired");
      if (tombstones.has(session.datasetId)) throw new Error("Dataset is cleared");
      if (!Number.isSafeInteger(index) || index < 0 || !(chunk instanceof Uint8Array)) throw new TypeError("Upload chunk is invalid");
      const previous = session.chunks.get(index);
      if (previous && toBase64(previous) !== toBase64(chunk)) throw new Error("Chunk retry conflicts with previously uploaded bytes");
      session.chunks.set(index, new Uint8Array(chunk));
      return { index, idempotent: Boolean(previous) };
    },
    getUploadProgress(token) {
      const session = sessions.get(token);
      if (!session) throw new Error("Upload session is missing or expired");
      return [...session.chunks.keys()].sort((a, b) => a - b);
    },
    async completeUpload(token, backupOrManifest) {
      const session = sessions.get(token);
      if (!session) throw new Error("Upload session is missing or expired");
      const datasetId = session.datasetId;
      if (tombstones.has(datasetId)) {
        sessions.delete(token);
        throw new Error("Dataset was cleared before upload completion");
      }
      const manifest = backupOrManifest.manifest || backupOrManifest;
      if (manifest.datasetId !== datasetId) throw new Error("Upload dataset does not match session");
      if (backupOrManifest.manifest) {
        backupOrManifest.chunks.forEach((chunk, index) => this.uploadChunk(token, index, chunk));
      }
      if (!Number.isSafeInteger(manifest.chunkCount) || session.chunks.size !== manifest.chunkCount) {
        throw new Error("Upload session is missing encrypted chunks");
      }
      const chunks = Array.from({ length: manifest.chunkCount }, (_, index) => session.chunks.get(index));
      if (chunks.some((chunk) => !chunk)) throw new Error("Upload session has a missing chunk index");
      sessions.delete(token);
      const key = datasetId + ":" + manifest.backupId;
      const existing = backups.get(key);
      if (existing) {
        if (existing.manifest.chunks.map((item) => item.sha256).join() !== manifest.chunks.map((item) => item.sha256).join()) {
          throw new Error("Backup ID idempotency conflict");
        }
        return { backupId: manifest.backupId, idempotent: true };
      }
      backups.set(key, { manifest: structuredClone(manifest), chunks: chunks.map((chunk) => new Uint8Array(chunk)) });
      return { backupId: manifest.backupId, idempotent: false };
    },
    listBackups(datasetId) {
      if (tombstones.has(datasetId)) throw new Error("Dataset is cleared");
      return [...backups.values()].filter((backup) => backup.manifest.datasetId === datasetId)
        .map((backup) => structuredClone(backup.manifest));
    },
    getBackupChain(datasetId, latestBackupId) {
      if (tombstones.has(datasetId)) throw new Error("Dataset is cleared");
      const chain = [];
      let currentId = latestBackupId;
      while (currentId) {
        const item = backups.get(datasetId + ":" + currentId);
        if (!item) throw new Error("Backup chain contains a missing parent");
        chain.unshift({
          manifest: structuredClone(item.manifest),
          chunks: item.chunks.map((chunk) => new Uint8Array(chunk)),
        });
        currentId = item.manifest.parentBackupId;
      }
      return chain;
    },
    clearDataset(datasetId, clearedAt = new Date().toISOString()) {
      if (tombstones.has(datasetId)) return tombstones.get(datasetId);
      const tombstone = { datasetId, status: "cleared", clearedAt };
      tombstones.set(datasetId, tombstone);
      return tombstone;
    },
    isCleared(datasetId) { return tombstones.has(datasetId); },
    inspectStoredCiphertextCount(datasetId) {
      return [...backups.values()].filter((backup) => backup.manifest.datasetId === datasetId).length;
    },
  });
}

export const backupPocParameters = Object.freeze({
  formatVersion: FORMAT_VERSION,
  chunkBytes: DEFAULT_CHUNK_BYTES,
  kdf: "PBKDF2-SHA-256",
  defaultIterations: DEFAULT_KDF_ITERATIONS,
  securityReview: "REQUIRED_BEFORE_PRODUCTION",
});
