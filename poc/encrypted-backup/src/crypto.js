const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SCHEMA_VERSION = 1;
const CHUNK_SIZE = 64 * 1024;
const SUITE = 'AES-256-GCM';

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}
async function importAesKey(raw, usages) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
}
async function digest(bytes) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
function aadFor({ datasetId, backupId, sequence, parentBackupId, backupType, chunkIndex, schemaVersion }) {
  return encoder.encode([datasetId, backupId, sequence, parentBackupId || '', backupType, chunkIndex, schemaVersion, SUITE].join('|'));
}

export function createDatasetKeyMaterial(datasetId) {
  if (typeof datasetId !== 'string' || !datasetId) throw new Error('数据集 ID 非法');
  return {
    datasetId,
    dekRaw: randomBytes(32),
    recoveryKey: bytesToBase64(randomBytes(32))
  };
}

export async function createEncryptedBackup({ datasetId, sequence, parentBackupId = null, backupType = parentBackupId ? 'incremental' : 'full', payload, keyMaterial }) {
  if (!['full', 'incremental'].includes(backupType)) throw new Error('不支持的备份类型');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('备份序号非法');
  if (backupType === 'full' && parentBackupId) throw new Error('全量备份不能指定父备份');
  if (backupType === 'incremental' && !parentBackupId) throw new Error('增量备份必须指定父备份');
  if (!keyMaterial && (backupType !== 'full' || sequence !== 1)) {
    throw new Error('增量备份与后续全量检查点必须复用数据集密钥材料');
  }
  const backupId = crypto.randomUUID();
  const material = keyMaterial || createDatasetKeyMaterial(datasetId);
  if (material.datasetId !== datasetId || !(material.dekRaw instanceof Uint8Array) ||
      material.dekRaw.length !== 32 || typeof material.recoveryKey !== 'string') {
    throw new Error('备份密钥材料与数据集不匹配或格式非法');
  }
  const dekRaw = material.dekRaw;
  const recoveryKeyRaw = base64ToBytes(material.recoveryKey);
  if (recoveryKeyRaw.length !== 32) throw new Error('恢复凭证长度非法');
  const dek = await importAesKey(dekRaw, ['encrypt', 'decrypt']);
  const wrappingKey = await importAesKey(recoveryKeyRaw, ['encrypt', 'decrypt']);
  const wrapNonce = randomBytes(12);
  const wrappedDek = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapNonce, additionalData: encoder.encode(datasetId + '|' + backupId + '|DEK') },
    wrappingKey,
    dekRaw
  ));
  const plain = encoder.encode(JSON.stringify(payload));
  const chunks = [];
  const usedNonces = new Set();
  for (let offset = 0, chunkIndex = 0; offset < plain.length || (plain.length === 0 && chunkIndex === 0); offset += CHUNK_SIZE, chunkIndex++) {
    const part = plain.slice(offset, Math.min(offset + CHUNK_SIZE, plain.length));
    let nonce, nonceText;
    do {
      nonce = randomBytes(12);
      nonceText = bytesToBase64(nonce);
    } while (usedNonces.has(nonceText));
    usedNonces.add(nonceText);
    const aad = aadFor({ datasetId, backupId, sequence, parentBackupId, backupType, chunkIndex, schemaVersion: SCHEMA_VERSION });
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, dek, part));
    chunks.push({
      chunkIndex,
      nonce: nonceText,
      ciphertext: bytesToBase64(ciphertext),
      ciphertextHash: await digest(ciphertext),
      plaintextSize: part.length,
      ciphertextSize: ciphertext.length
    });
    if (plain.length === 0) break;
  }
  return {
    recoveryKey: material.recoveryKey,
    manifest: {
      datasetId, backupId, sequence, parentBackupId, backupType, schemaVersion: SCHEMA_VERSION,
      cipherSuite: SUITE, wrappedDek: bytesToBase64(wrappedDek), wrapNonce: bytesToBase64(wrapNonce),
      chunkCount: chunks.length, chunks: chunks.map(({ chunkIndex, nonce, ciphertextHash, plaintextSize, ciphertextSize }) =>
        ({ chunkIndex, nonce, ciphertextHash, plaintextSize, ciphertextSize }))
    },
    chunks
  };
}

export async function decryptBackup({ manifest, chunks, recoveryKey }) {
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.cipherSuite !== SUITE || !['full', 'incremental'].includes(manifest.backupType)) throw new Error('不支持的备份协议版本、备份类型或算法套件');
  if (manifest.backupType === 'full' && manifest.parentBackupId) throw new Error('全量备份父链非法');
  if (manifest.backupType === 'incremental' && !manifest.parentBackupId) throw new Error('增量备份缺少父备份');
  const recoveryKeyRaw = base64ToBytes(recoveryKey);
  const wrappingKey = await importAesKey(recoveryKeyRaw, ['decrypt']);
  const dekRaw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(manifest.wrapNonce), additionalData: encoder.encode(manifest.datasetId + '|' + manifest.backupId + '|DEK') },
    wrappingKey,
    base64ToBytes(manifest.wrappedDek)
  );
  const dek = await importAesKey(new Uint8Array(dekRaw), ['decrypt']);
  if (chunks.length !== manifest.chunkCount) throw new Error('备份分块缺失');
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const plaintextParts = [];
  for (let i = 0; i < ordered.length; i++) {
    const chunk = ordered[i];
    const metadata = manifest.chunks.find((item) => item.chunkIndex === chunk.chunkIndex);
    if (!metadata || metadata.ciphertextHash !== await digest(base64ToBytes(chunk.ciphertext))) throw new Error('密文哈希校验失败');
    if (chunk.chunkIndex !== i) throw new Error('分块序号不连续');
    const aad = aadFor({ datasetId: manifest.datasetId, backupId: manifest.backupId, sequence: manifest.sequence, parentBackupId: manifest.parentBackupId, backupType: manifest.backupType, chunkIndex: i, schemaVersion: manifest.schemaVersion });
    plaintextParts.push(new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(metadata.nonce), additionalData: aad },
      dek,
      base64ToBytes(chunk.ciphertext)
    )));
  }
  const length = plaintextParts.reduce((sum, part) => sum + part.length, 0);
  const plaintext = new Uint8Array(length);
  let offset = 0;
  for (const part of plaintextParts) { plaintext.set(part, offset); offset += part.length; }
  return JSON.parse(decoder.decode(plaintext));
}

export function applyIncremental(snapshot, incrementalPayload) {
  if (!snapshot || !Array.isArray(snapshot.records) ||
      !incrementalPayload || !Array.isArray(incrementalPayload.changes)) {
    throw new Error('全量快照或增量变更格式非法');
  }
  const records = new Map();
  for (const record of snapshot.records) {
    if (!record || typeof record.id !== 'string' || !record.id || records.has(record.id)) {
      throw new Error('全量快照记录 ID 非法或重复');
    }
    records.set(record.id, record);
  }
  for (const change of incrementalPayload.changes) {
    if (change?.op === 'upsert') {
      if (!change.record || typeof change.record.id !== 'string' || !change.record.id) {
        throw new Error('增量 upsert 记录非法');
      }
      records.set(change.record.id, change.record);
    } else if (change?.op === 'delete') {
      if (typeof change.id !== 'string' || !change.id) throw new Error('增量 delete 记录 ID 非法');
      records.delete(change.id);
    } else {
      throw new Error('不支持的增量操作');
    }
  }
  return { ...snapshot, records: [...records.values()] };
}

export async function restoreBackupChain({ backupId, fetchBackup, recoveryKey, maxDepth = 100 }) {
  if (typeof backupId !== 'string' || !backupId || typeof fetchBackup !== 'function') {
    throw new Error('恢复入口参数非法');
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new Error('最大恢复链深度非法');
  const visited = new Set();
  const chain = [];
  let currentId = backupId;
  let expectedDatasetId;
  let expectedSequence;
  while (currentId) {
    if (visited.has(currentId)) throw new Error('备份父链存在循环');
    if (chain.length >= maxDepth) throw new Error('备份父链超过最大恢复深度');
    visited.add(currentId);
    const backup = await fetchBackup(currentId);
    const manifest = backup?.manifest;
    if (!manifest || manifest.backupId !== currentId) throw new Error('恢复备份 ID 与请求不匹配');
    if (expectedDatasetId !== undefined && manifest.datasetId !== expectedDatasetId) {
      throw new Error('备份父链跨数据集');
    }
    if (expectedSequence !== undefined && manifest.sequence !== expectedSequence) {
      throw new Error('备份父链序号不连续');
    }
    if (expectedDatasetId === undefined) expectedDatasetId = manifest.datasetId;
    const payload = await decryptBackup({ ...backup, recoveryKey });
    chain.push({ manifest, payload });
    if (manifest.backupType === 'full') {
      if (manifest.parentBackupId) throw new Error('全量根备份不能有父备份');
      break;
    }
    if (manifest.backupType !== 'incremental' || !manifest.parentBackupId) {
      throw new Error('增量备份缺少合法父备份');
    }
    expectedSequence = manifest.sequence - 1;
    currentId = manifest.parentBackupId;
  }
  if (!chain.length || chain[chain.length - 1].manifest.backupType !== 'full') {
    throw new Error('备份父链缺少全量根节点');
  }
  let snapshot = chain[chain.length - 1].payload;
  for (let index = chain.length - 2; index >= 0; index--) {
    snapshot = applyIncremental(snapshot, chain[index].payload);
  }
  return {
    snapshot,
    backupIds: chain.map((item) => item.manifest.backupId),
    depth: chain.length,
    datasetId: expectedDatasetId
  };
}
