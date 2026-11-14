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
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function aadForChunk({ datasetId, backupId, parentBackupId, backupSequence, lineageId, forkId, schemaVersion, chunkIndex }) {
  return encoder.encode(canonicalJson({
    formatVersion: FORMAT_VERSION,
    datasetId,
    backupId,
    parentBackupId,
    backupSequence,
    lineageId,
    forkId,
    schemaVersion,
    chunkIndex,
  }));
}
const ENTITY_COLLECTIONS = Object.freeze({
  thread: "threads",
  message: "messages",
  readingRound: "readingRounds",
  readingPosition: "readingPositions",
  readingRoundState: "readingRoundStates",
  readingUnitProgress: "readingUnitProgress",
  presentedSource: "presentedSources",
  citation: "citations",
  note: "notes",
  memory: "memories",
  memoryVersion: "memoryVersions",
  memoryRelation: "memoryRelations",
  memoryCandidate: "memoryCandidates",
  generationDelivery: "generationDeliveries",
});
function recordKey(collection, record) {
  const keys = {
    threads: "id",
    messages: "message.id",
    readingRounds: "id",
    readingPositions: "threadId",
    readingRoundStates: "readingRoundId",
    readingUnitProgress: "readingRoundId",
    presentedSources: "id",
    citations: "id",
    notes: "id",
    memories: "id",
    memoryVersions: "id",
    memoryRelations: "id",
    memoryCandidates: "id",
    generationDeliveries: "clientGenerationId",
  };
  const path = keys[collection];
  if (!path) throw new Error("Unknown snapshot collection: " + collection);
  if (collection === "readingUnitProgress") {
    return record.readingRoundId + ":" + record.structureNodeId;
  }
  return path.split(".").reduce((value, key) => value?.[key], record);
}
const COLLECTIONS = [
  "threads", "messages", "readingRounds", "readingPositions", "readingRoundStates",
  "readingUnitProgress", "presentedSources", "citations", "notes", "memories",
  "memoryVersions", "memoryRelations", "memoryCandidates", "generationDeliveries",
];

function requireIdentity(identity) {
  for (const field of ["deviceId", "lineageId", "forkId"]) {
    if (typeof identity?.[field] !== "string" || !identity[field].trim()) {
      throw new TypeError("snapshot.identity." + field + " is required");
    }
  }
  return { deviceId: identity.deviceId, lineageId: identity.lineageId, forkId: identity.forkId };
}

async function importMasterKey(material) {
  if (material && material.type === "secret" && material.algorithm?.name === "HKDF") return material;
  return crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
}


export async function createRecoveryBundle(datasetId, recoveryCredential = toBase64(randomBytes(32)), options = {}) {
  requireValue(datasetId, "datasetId");
  const iterations = options.iterations ?? DEFAULT_KDF_ITERATIONS;
  if (!Number.isSafeInteger(iterations) || iterations < 100_000) throw new RangeError("PBKDF2 iterations must be >= 100000");
  const credentialBytes = fromBase64(recoveryCredential);
  if (credentialBytes.length < 32) throw new TypeError("Recovery credential must contain at least 256 bits");
  const rawDataKey = randomBytes(32);
  const dataKey = await importMasterKey(rawDataKey);
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
  return importMasterKey(new Uint8Array(raw));
}

export function createBackupPayload(snapshot, previousSnapshot = null) {
  requireValue(snapshot?.datasetId, "snapshot.datasetId");
  if (!Number.isSafeInteger(snapshot.schemaVersion) || !Number.isSafeInteger(snapshot.dirtySequence)) {
    throw new TypeError("Snapshot schemaVersion and dirtySequence must be integers");
  }
  const identity = requireIdentity(snapshot.identity);
  if (!previousSnapshot) {
    return { kind: "full", snapshot: canonicalize(snapshot), identity };
  }
  if (previousSnapshot.datasetId !== snapshot.datasetId) throw new Error("Incremental backup cannot cross datasets");
  if (requireIdentity(previousSnapshot.identity).lineageId !== identity.lineageId) {
    throw new Error("Incremental backup cannot cross dataset lineage");
  }
  if (snapshot.dirtySequence <= previousSnapshot.dirtySequence) throw new Error("Snapshot has no unacknowledged sequence advance");
  if (!Array.isArray(snapshot.backupJournal)) throw new Error("Incremental backup requires snapshot.backupJournal");

  const entries = snapshot.backupJournal
    .filter((entry) => entry && Number.isSafeInteger(entry.sequence) && entry.sequence > previousSnapshot.dirtySequence)
    .sort((left, right) => left.sequence - right.sequence);
  if (entries.length === 0 || entries[entries.length - 1].sequence !== snapshot.dirtySequence) {
    throw new Error("BackupJournal does not cover the snapshot dirtySequence");
  }

  const latestByEntity = new Map();
  for (const entry of entries) {
    const collection = ENTITY_COLLECTIONS[entry.entityType];
    if (!collection) throw new Error("Unknown backup journal entity type: " + entry.entityType);
    if (!["upsert", "delete"].includes(entry.operation)) throw new Error("Unknown backup journal operation: " + entry.operation);
    latestByEntity.set(collection + ":" + entry.entityId, entry);
  }

  const upserts = Object.fromEntries(COLLECTIONS.map((collection) => [collection, []]));
  const removals = Object.fromEntries(COLLECTIONS.map((collection) => [collection, []]));
  const touched = new Set();
  for (const entry of latestByEntity.values()) {
    const collection = ENTITY_COLLECTIONS[entry.entityType];
    const record = (snapshot[collection] || []).find((item) => String(recordKey(collection, item)) === String(entry.entityId));
    const key = collection + ":" + entry.entityId;
    touched.add(key);
    if (entry.operation === "delete" || !record) {
      removals[collection].push(entry.entityId);
    } else {
      upserts[collection].push(canonicalize(record));
    }
  }

  // Journal is an optimization only if it fully covers the snapshot diff; fail closed otherwise.
  for (const collection of COLLECTIONS) {
    const previous = new Map((previousSnapshot[collection] || []).map((item) => [recordKey(collection, item), item]));
    const current = new Map((snapshot[collection] || []).map((item) => [recordKey(collection, item), item]));
    for (const [key, value] of current.entries()) {
      if (previous.has(key) && canonicalJson(previous.get(key)) === canonicalJson(value)) continue;
      if (!touched.has(collection + ":" + key)) throw new Error("BackupJournal is missing an entry for " + collection + ":" + key);
    }
    for (const key of previous.keys()) {
      if (!current.has(key) && !touched.has(collection + ":" + key)) {
        throw new Error("BackupJournal is missing a delete for " + collection + ":" + key);
      }
    }
  }

  return {
    kind: "delta",
    datasetId: snapshot.datasetId,
    schemaVersion: snapshot.schemaVersion,
    dirtySequence: snapshot.dirtySequence,
    identity,
    journal: entries.map((entry) => canonicalize(entry)),
    upserts,
    removals,
  };
}

async function deriveBackupChunkKey(masterKey, datasetId, backupId) {
  const material = await importMasterKey(masterKey);
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
  const backupSequence = options.backupSequence;
  if (!Number.isSafeInteger(backupSequence) || backupSequence < 1) {
    throw new Error("backupSequence must be a positive integer, independent from dirtySequence");
  }
  if (options.previousBackupSequence !== undefined && backupSequence !== options.previousBackupSequence + 1) {
    throw new Error("backupSequence must increment by exactly one within a fork");
  }
  const identity = requireIdentity(options.identity ?? snapshot.identity);
  const normalizedSnapshot = { ...snapshot, identity };
  if (options.forceFull && options.parentBackupId) throw new Error("A full checkpoint cannot have a parent backup");
  const payload = options.forceFull ? createBackupPayload(normalizedSnapshot, null) : createBackupPayload(normalizedSnapshot, options.previousSnapshot ?? null);
  if (!Number.isSafeInteger(snapshot.dirtySequence) || snapshot.dirtySequence < 1) throw new Error("Backup sequence must be a positive integer");
  if (payload.kind === "delta" && !parentBackupId) throw new Error("Incremental backup requires a parent backup ID");
  if (payload.kind === "full" && parentBackupId) throw new Error("Full backup cannot have a parent backup ID");
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
          backupSequence,
          lineageId: identity.lineageId,
          forkId: identity.forkId,
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
  const ciphertextSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const ciphertext = new Uint8Array(ciphertextSize);
  let ciphertextOffset = 0;
  for (const chunk of chunks) { ciphertext.set(chunk, ciphertextOffset); ciphertextOffset += chunk.length; }
  return {
    manifest: {
      format: "read-book-encrypted-backup",
      formatVersion: FORMAT_VERSION,
      datasetId: snapshot.datasetId,
      backupId,
      backupSequence,
      deviceId: identity.deviceId,
      lineageId: identity.lineageId,
      forkId: identity.forkId,
      parentBackupId,
      backupType: payload.kind === "full" ? "full" : "incremental",
      kind: payload.kind,
      schemaVersion: snapshot.schemaVersion,
      cipherSuite: "AES-256-GCM",
      keyVersion: options.keyVersion ?? 1,
      ciphertextHash: await sha256(ciphertext),
      ciphertextSize,
      partCount: chunks.length,
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
          backupSequence: manifest.backupSequence,
          lineageId: manifest.lineageId,
          forkId: manifest.forkId,
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
  return { manifest, payload: JSON.parse(decoder.decode(plaintext)), dataKey: masterKey };
}

async function restoreBackupChainInternal(backups, recoveryCredential) {
  if (!Array.isArray(backups) || backups.length === 0) throw new Error("Backup chain is empty");
  let snapshot = null;
  let previousBackupId = null;
  let previousSequence = null;
  let datasetId = null;
  let lineageId = null;
  let latest = null;
  let backupsSinceFull = 0;
  for (let index = 0; index < backups.length; index += 1) {
    const decoded = await decryptBackup(backups[index], recoveryCredential);
    const { manifest, payload } = decoded;
    const identity = requireIdentity(manifest);
    if (payload.identity && canonicalJson(payload.identity) !== canonicalJson(identity)) {
      throw new Error("Backup payload identity does not match the manifest");
    }
    if (index === 0 && (manifest.kind !== "full" || manifest.parentBackupId !== null || payload.kind !== "full")) {
      throw new Error("Backup chain must start with a full backup");
    }
    if (index > 0 && (manifest.parentBackupId !== previousBackupId || manifest.kind !== "delta" || payload.kind !== "delta")) {
      throw new Error("Backup parent chain is broken");
    }
    if (index > 0 && manifest.backupSequence !== previousSequence + 1) {
      throw new Error("Backup sequence must increment by exactly one within a chain");
    }
    if (datasetId && manifest.datasetId !== datasetId) throw new Error("Backup chain crosses datasets");
    if (lineageId && identity.lineageId !== lineageId) throw new Error("Backup chain crosses dataset lineages");
    datasetId = manifest.datasetId;
    lineageId = identity.lineageId;
    if (payload.kind === "full") {
      if (index !== 0) throw new Error("A full backup cannot appear inside an incremental chain");
      snapshot = payload.snapshot;
      backupsSinceFull = 0;
    } else {
      if (!snapshot || payload.datasetId !== datasetId) throw new Error("Incremental backup has no matching full parent");
      snapshot = { ...snapshot, schemaVersion: payload.schemaVersion, dirtySequence: payload.dirtySequence };
      for (const collection of COLLECTIONS) {
        const map = new Map((snapshot[collection] || []).map((item) => [recordKey(collection, item), item]));
        for (const key of payload.removals[collection] || []) map.delete(key);
        for (const item of payload.upserts[collection] || []) map.set(recordKey(collection, item), item);
        snapshot[collection] = [...map.values()];
      }
      const journal = [...(snapshot.backupJournal || [])];
      const seen = new Set(journal.map((entry) => entry.sequence));
      for (const entry of payload.journal || []) {
        if (!seen.has(entry.sequence)) { journal.push(entry); seen.add(entry.sequence); }
      }
      snapshot.backupJournal = journal.sort((left, right) => left.sequence - right.sequence);
      backupsSinceFull += 1;
    }
    snapshot.identity = identity;
    if (snapshot.datasetId !== datasetId || snapshot.schemaVersion !== manifest.schemaVersion ||
        snapshot.dirtySequence !== manifest.dirtySequence) {
      throw new Error("Restored snapshot does not match the encrypted manifest");
    }
    latest = { manifest, dataKey: decoded.dataKey };
    previousBackupId = manifest.backupId;
    previousSequence = manifest.backupSequence;
  }
  return {
    snapshot,
    backupId: latest.manifest.backupId,
    dataKey: latest.dataKey,
    keyEnvelope: latest.manifest.keyEnvelope,
    keyVersion: latest.manifest.keyVersion,
    identity: {
      deviceId: latest.manifest.deviceId,
      lineageId: latest.manifest.lineageId,
      forkId: latest.manifest.forkId,
    },
    backupsSinceFull,
  };
}

export async function restoreBackupChain(backups, recoveryCredential) {
  return (await restoreBackupChainInternal(backups, recoveryCredential)).snapshot;
}

export async function restoreBackupChainWithKey(backups, recoveryCredential) {
  return restoreBackupChainInternal(backups, recoveryCredential);
}

/**
 * Identity for backups created after restoring onto another device.
 * A restore always starts a new fork so local unique constraints never collide with the source fork,
 * while lineageId keeps the logical dataset and its restore history connected.
 */
export function createRestoredForkIdentity(manifest, deviceId, forkId = crypto.randomUUID()) {
  requireValue(manifest?.lineageId, "manifest.lineageId");
  requireValue(deviceId, "deviceId");
  requireValue(forkId, "forkId");
  if (forkId === manifest.forkId && deviceId === manifest.deviceId) {
    throw new Error("A restored fork must use a new forkId or deviceId");
  }
  return { deviceId, lineageId: manifest.lineageId, forkId };
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
      const key = [manifest.lineageId, manifest.forkId, manifest.backupId].join(":");
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
    listBackupsForFork(lineageId, forkId) {
      return [...backups.values()].filter((backup) =>
        backup.manifest.lineageId === lineageId && backup.manifest.forkId === forkId)
        .map((backup) => structuredClone(backup.manifest))
        .sort((left, right) => left.backupSequence - right.backupSequence);
    },
    getBackupChain(datasetId, latestBackupId) {
      if (tombstones.has(datasetId)) throw new Error("Dataset is cleared");
      const chain = [];
      let currentId = latestBackupId;
      while (currentId) {
        const item = [...backups.values()].find((backup) =>
          backup.manifest.datasetId === datasetId && backup.manifest.backupId === currentId);
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
