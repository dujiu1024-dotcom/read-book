export class MockBackupServer {
  constructor() {
    this.sessions = new Map();
    this.backups = new Map();
    this.tombstones = new Set();
    this.idempotency = new Map();
  }
  init(manifest, idempotencyKey) {
    if (this.tombstones.has(manifest.datasetId)) throw new Error('数据集已清除');
    const prior = this.idempotency.get(idempotencyKey);
    if (prior) return prior;
    if (manifest.parentBackupId && !this.backups.has(manifest.parentBackupId)) throw new Error('父备份不存在');
    const session = { backupId: manifest.backupId, manifest, parts: new Map(), state: 'uploading' };
    this.sessions.set(manifest.backupId, session);
    this.idempotency.set(idempotencyKey, session);
    return session;
  }
  putPart(backupId, chunk) {
    const session = this.sessions.get(backupId);
    if (!session || session.state !== 'uploading') throw new Error('上传会话不存在或已结束');
    if (this.tombstones.has(session.manifest.datasetId)) throw new Error('数据集已清除，拒绝上传');
    session.parts.set(chunk.chunkIndex, chunk);
  }
  complete(backupId) {
    const session = this.sessions.get(backupId);
    if (!session) throw new Error('上传会话不存在');
    if (this.tombstones.has(session.manifest.datasetId)) throw new Error('清除墓碑优先，拒绝完成上传');
    if (session.parts.size !== session.manifest.chunkCount) throw new Error('分块不完整');
    session.state = 'committed';
    this.backups.set(backupId, { manifest: session.manifest, chunks: [...session.parts.values()] });
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
        this.sessions.delete(id);
      }
    }
  }
  isCleared(datasetId) { return this.tombstones.has(datasetId); }
}
