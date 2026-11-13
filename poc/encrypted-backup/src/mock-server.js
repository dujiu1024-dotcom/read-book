function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
async function sha256Base64(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class MockBackupServer {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.sessions = new Map();
    this.backups = new Map();
    this.tombstones = new Set();
    this.idempotency = new Map();
    this.authorizations = new Map();
    this.downloadTickets = new Map();
  }
  issueAuthorization(datasetId, { scopes = ['upload', 'download'], ttlMs = 60_000 } = {}) {
    if (typeof datasetId !== 'string' || !datasetId) throw new Error('数据集 ID 非法');
    if (this.tombstones.has(datasetId)) throw new Error('数据集已清除');
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => !['upload', 'download'].includes(scope))) {
      throw new Error('授权范围非法');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('授权有效期非法');
    const token = crypto.randomUUID();
    const authorization = { token, datasetId, scopes: [...new Set(scopes)], expiresAt: this.now() + ttlMs };
    this.authorizations.set(token, authorization);
    return { token, expiresAt: authorization.expiresAt };
  }
  assertAuthorization(token, datasetId, scope) {
    const authorization = this.authorizations.get(token);
    if (!authorization || authorization.datasetId !== datasetId ||
        authorization.expiresAt <= this.now() || !authorization.scopes.includes(scope) ||
        this.tombstones.has(datasetId)) {
      throw new Error('授权无效、过期、范围不足或数据集已清除');
    }
    return authorization;
  }
  revokeAuthorization(token) { return this.authorizations.delete(token); }
  authorizedInit(token, manifest, idempotencyKey) {
    this.assertAuthorization(token, manifest.datasetId, 'upload');
    return this.init(manifest, idempotencyKey);
  }
  authorizedPutPart(token, backupId, chunk) {
    const session = this.sessions.get(backupId);
    if (!session) throw new Error('上传会话不存在');
    this.assertAuthorization(token, session.manifest.datasetId, 'upload');
    return this.putPart(backupId, chunk);
  }
  authorizedMissingParts(token, backupId) {
    const session = this.sessions.get(backupId);
    if (!session) throw new Error('上传会话不存在');
    this.assertAuthorization(token, session.manifest.datasetId, 'upload');
    return this.missingParts(backupId);
  }
  async authorizedComplete(token, backupId) {
    const session = this.sessions.get(backupId);
    if (!session) throw new Error('上传会话不存在');
    this.assertAuthorization(token, session.manifest.datasetId, 'upload');
    return this.complete(backupId);
  }
  issueDownloadTicket(token, backupId, ttlMs = 30_000) {
    const backup = this.backups.get(backupId);
    if (!backup) throw new Error('备份不存在');
    this.assertAuthorization(token, backup.manifest.datasetId, 'download');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('下载票据有效期非法');
    const ticket = crypto.randomUUID();
    const expiresAt = this.now() + ttlMs;
    this.downloadTickets.set(ticket, {
      ticket, backupId, datasetId: backup.manifest.datasetId, expiresAt
    });
    return { ticket, expiresAt };
  }
  downloadByTicket(ticket) {
    const record = this.downloadTickets.get(ticket);
    if (!record || record.expiresAt <= this.now() || this.tombstones.has(record.datasetId)) {
      throw new Error('下载票据无效、过期或已撤销');
    }
    return this.get(record.backupId);
  }
  init(manifest, idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) throw new Error('幂等键不能为空');
    if (this.tombstones.has(manifest.datasetId)) throw new Error('数据集已清除');
    if (typeof manifest.backupId !== 'string' || !manifest.backupId || typeof manifest.datasetId !== 'string' || !manifest.datasetId) throw new Error('数据集或备份 ID 非法');
    if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence < 1) throw new Error('备份序号非法');
    if (!['full', 'incremental'].includes(manifest.backupType)) throw new Error('备份类型非法');
    if (!Array.isArray(manifest.chunks) || !Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 1 || manifest.chunks.length !== manifest.chunkCount) {
      throw new Error('Manifest 分块数量与清单不一致');
    }
    const chunkIndexes = manifest.chunks.map((chunk) => chunk.chunkIndex);
    const nonces = manifest.chunks.map((chunk) => chunk.nonce);
    if (chunkIndexes.some((index, position) => index !== position)) throw new Error('Manifest 分块序号必须从 0 连续排列');
    if (nonces.some((nonce) => typeof nonce !== 'string' || !nonce) || new Set(nonces).size !== nonces.length) {
      throw new Error('同一备份内分块 nonce 必须唯一');
    }
    if (manifest.backupType === 'full' && manifest.parentBackupId) throw new Error('全量备份不能指定父备份');
    if (manifest.backupType === 'incremental' && !manifest.parentBackupId) throw new Error('增量备份必须指定父备份');
    const prior = this.idempotency.get(idempotencyKey);
    if (prior) {
      if (prior.backupId !== manifest.backupId) throw new Error('幂等键已被其他备份请求使用');
      return prior;
    }
    if (manifest.parentBackupId) {
      const parent = this.backups.get(manifest.parentBackupId);
      if (!parent) throw new Error('父备份不存在');
      if (parent.manifest.datasetId !== manifest.datasetId) throw new Error('父备份不属于同一数据集');
      if (manifest.sequence !== parent.manifest.sequence + 1) throw new Error('备份序号必须紧邻父备份');
      if (parent.manifest.backupType === 'incremental' && !parent.manifest.parentBackupId) throw new Error('父备份链不完整');
    }
    const session = { backupId: manifest.backupId, manifest: structuredClone(manifest), parts: new Map(), state: 'uploading' };
    this.sessions.set(manifest.backupId, session);
    this.idempotency.set(idempotencyKey, session);
    return session;
  }
  putPart(backupId, chunk) {
    const session = this.sessions.get(backupId);
    if (!session || session.state !== 'uploading') throw new Error('上传会话不存在或已结束');
    if (this.tombstones.has(session.manifest.datasetId)) throw new Error('数据集已清除，拒绝上传');
    if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= session.manifest.chunkCount) throw new Error('分块序号非法');
    const existing = session.parts.get(chunk.chunkIndex);
    if (existing && existing.ciphertext !== chunk.ciphertext) {
      throw new Error('同一分块序号不能上传不同密文');
    }
    // Repeating the exact same part is safe and idempotent after a lost response.
    if (!existing) session.parts.set(chunk.chunkIndex, chunk);
  }
  missingParts(backupId) {
    const session = this.sessions.get(backupId);
    if (!session || session.state !== 'uploading') throw new Error('上传会话不存在或已结束');
    return Array.from({ length: session.manifest.chunkCount }, (_, index) => index)
      .filter((index) => !session.parts.has(index));
  }
  async complete(backupId) {
    const session = this.sessions.get(backupId);
    if (!session) throw new Error('上传会话不存在');
    if (this.tombstones.has(session.manifest.datasetId)) throw new Error('清除墓碑优先，拒绝完成上传');
    if (session.parts.size !== session.manifest.chunkCount) throw new Error('分块不完整');
    const ordered = [...session.parts.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
    for (let i = 0; i < ordered.length; i++) {
      const chunk = ordered[i];
      const metadata = session.manifest.chunks.find((item) => item.chunkIndex === i);
      if (!metadata || chunk.chunkIndex !== i) throw new Error('分块序号或 Manifest 不匹配');
      if (await sha256Base64(base64ToBytes(chunk.ciphertext)) !== metadata.ciphertextHash) throw new Error('服务端密文哈希校验失败');
    }
    if (this.tombstones.has(session.manifest.datasetId)) throw new Error('清除墓碑优先，拒绝完成上传');
    session.state = 'committed';
    this.backups.set(backupId, { manifest: session.manifest, chunks: ordered });
    return { backupId, state: 'committed' };
  }
  get(backupId) {
    const backup = this.backups.get(backupId);
    if (!backup || this.tombstones.has(backup.manifest.datasetId)) throw new Error('备份不可访问');
    return structuredClone(backup);
  }
  clearDataset(datasetId) {
    this.tombstones.add(datasetId);
    for (const [id, backup] of this.backups) {
      if (backup.manifest.datasetId === datasetId) this.backups.delete(id);
    }
    for (const [id, session] of this.sessions) {
      if (session.manifest.datasetId === datasetId) {
        session.state = 'cleared';
        session.parts.clear();
        this.sessions.delete(id);
      }
    }
    // Drop idempotency references too; otherwise they retain manifests and
    // ciphertext parts in memory after the dataset has been tombstoned.
    for (const [key, session] of this.idempotency) {
      if (session.manifest.datasetId === datasetId) this.idempotency.delete(key);
    }
    for (const [token, authorization] of this.authorizations) {
      if (authorization.datasetId === datasetId) this.authorizations.delete(token);
    }
    for (const [ticket, record] of this.downloadTickets) {
      if (record.datasetId === datasetId) this.downloadTickets.delete(ticket);
    }
  }
  isCleared(datasetId) { return this.tombstones.has(datasetId); }
}
