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
function aadFor({ datasetId, backupId, sequence, chunkIndex, schemaVersion }) {
  return encoder.encode([datasetId, backupId, sequence, chunkIndex, schemaVersion, SUITE].join('|'));
}

export async function createEncryptedBackup({ datasetId, sequence, parentBackupId = null, payload }) {
  const backupId = crypto.randomUUID();
  const dekRaw = randomBytes(32);
  const recoveryKeyRaw = randomBytes(32);
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
    const aad = aadFor({ datasetId, backupId, sequence, chunkIndex, schemaVersion: SCHEMA_VERSION });
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
    recoveryKey: bytesToBase64(recoveryKeyRaw),
    manifest: {
      datasetId, backupId, sequence, parentBackupId, schemaVersion: SCHEMA_VERSION,
      cipherSuite: SUITE, wrappedDek: bytesToBase64(wrappedDek), wrapNonce: bytesToBase64(wrapNonce),
      chunkCount: chunks.length, chunks: chunks.map(({ chunkIndex, nonce, ciphertextHash, plaintextSize, ciphertextSize }) =>
        ({ chunkIndex, nonce, ciphertextHash, plaintextSize, ciphertextSize }))
    },
    chunks
  };
}

export async function decryptBackup({ manifest, chunks, recoveryKey }) {
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.cipherSuite !== SUITE) throw new Error('不支持的备份协议版本或算法套件');
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
    const aad = aadFor({ datasetId: manifest.datasetId, backupId: manifest.backupId, sequence: manifest.sequence, chunkIndex: i, schemaVersion: manifest.schemaVersion });
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
