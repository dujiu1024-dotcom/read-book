import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ALLOWED_SCOPES = new Set(['backup:read', 'backup:write', 'backup:clear', 'ticket:revoke']);

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}
function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) fail(400, label + ' 非法');
  return value;
}
function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}
function sha256Base64(bytes) {
  return createHash('sha256').update(bytes).digest('base64');
}
function decodeBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(400, '分块密文必须是合法 Base64');
  }
  return Buffer.from(value, 'base64');
}
function json(res, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(payload);
}
async function readJson(req) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY_BYTES) fail(413, '请求体超过 PoC 限制');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { fail(400, '请求 JSON 格式非法'); }
}
async function atomicWrite(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.' + randomBytes(8).toString('hex') + '.tmp';
  await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
  await rename(temp, filePath);
}
async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, JSON.stringify(value));
}
function emptyState() {
  return {
    version: 1,
    tombstones: {},
    tickets: {},
    sessions: {},
    backups: {},
    idempotency: {},
    downloadTickets: {}
  };
}
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') fail(400, 'Manifest 缺失');
  safeId(manifest.datasetId, 'datasetId');
  safeId(manifest.backupId, 'backupId');
  if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence < 1) fail(400, '备份序号非法');
  if (manifest.schemaVersion !== 1 || manifest.cipherSuite !== 'AES-256-GCM') fail(400, '不支持的 Schema 或算法套件');
  if (!['full', 'incremental'].includes(manifest.backupType)) fail(400, '备份类型非法');
  if (manifest.backupType === 'full' && manifest.parentBackupId) fail(400, '全量备份不能指定父备份');
  if (manifest.backupType === 'incremental' && !manifest.parentBackupId) fail(400, '增量备份必须指定父备份');
  if (typeof manifest.wrappedDek !== 'string' || typeof manifest.wrapNonce !== 'string') fail(400, 'DEK 包装信息缺失');
  if (!Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 1 ||
      !Array.isArray(manifest.chunks) || manifest.chunks.length !== manifest.chunkCount) {
    fail(400, 'Manifest 分块数量与清单不一致');
  }
  const indexes = manifest.chunks.map((chunk) => chunk?.chunkIndex);
  const nonces = manifest.chunks.map((chunk) => chunk?.nonce);
  if (indexes.some((index, position) => index !== position)) fail(400, 'Manifest 分块序号必须从 0 连续排列');
  if (nonces.some((nonce) => typeof nonce !== 'string' || !nonce) || new Set(nonces).size !== nonces.length) {
    fail(400, '同一备份内分块 nonce 必须唯一');
  }
  for (const chunk of manifest.chunks) {
    if (typeof chunk.ciphertextHash !== 'string' || !Number.isSafeInteger(chunk.plaintextSize) ||
        !Number.isSafeInteger(chunk.ciphertextSize) || chunk.plaintextSize < 0 || chunk.ciphertextSize < 16) {
      fail(400, 'Manifest 分块元数据非法');
    }
  }
}
function createLock() {
  let tail = Promise.resolve();
  return async (operation) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  };
}

export async function createBackupHttpServer({ dataDir }) {
  if (!dataDir) throw new Error('必须提供持久化数据目录');
  const root = path.resolve(dataDir);
  const stateFile = path.join(root, 'state.json');
  const chunksRoot = path.join(root, 'chunks');
  await mkdir(chunksRoot, { recursive: true });
  let state;
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.version !== 1) throw new Error('不支持的服务端状态版本');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = emptyState();
    await atomicWriteJson(stateFile, state);
  }
  const withMutationLock = createLock();

  async function save() { await atomicWriteJson(stateFile, state); }
  function chunkPath(backupId, index) {
    return path.join(chunksRoot, safeId(backupId, 'backupId'), String(index) + '.b64');
  }
  function assertNotCleared(datasetId) {
    if (state.tombstones[datasetId]) fail(410, '数据集已清除');
  }
  function assertBackupNotCleared(backupId) {
    if (Object.values(state.tombstones).some((item) => (item.backupIds || []).includes(backupId))) {
      fail(410, '备份所属数据集已清除');
    }
  }
  function requireTicket(req, datasetId, scope) {
    const authorization = req.headers.authorization || '';
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match) fail(401, '缺少有效授权票据');
    const record = state.tickets[tokenHash(match[1])];
    if (!record || record.revokedAt) fail(401, '授权票据无效或已撤销');
    if (record.expiresAt <= Date.now()) fail(401, '授权票据已过期');
    if (record.datasetId !== datasetId) fail(403, '授权票据不属于该数据集');
    if (!record.scopes.includes(scope)) fail(403, '授权票据缺少所需权限');
    assertNotCleared(datasetId);
    return record;
  }
  function validateParentChain(manifest) {
    if (!manifest.parentBackupId) return;
    let parentId = manifest.parentBackupId;
    let expectedSequence = manifest.sequence - 1;
    const visited = new Set([manifest.backupId]);
    while (parentId) {
      if (visited.has(parentId)) fail(409, '备份父链存在循环');
      visited.add(parentId);
      const parent = state.backups[parentId];
      if (!parent) fail(409, '父备份不存在或未提交');
      if (parent.manifest.datasetId !== manifest.datasetId) fail(409, '父备份不属于同一数据集');
      if (parent.manifest.sequence !== expectedSequence) fail(409, '父备份链序号不连续');
      if (parent.manifest.backupType === 'full') {
        if (parent.manifest.parentBackupId) fail(409, '全量根备份不能有父备份');
        return;
      }
      if (!parent.manifest.parentBackupId) fail(409, '父备份链缺少全量根节点');
      expectedSequence -= 1;
      parentId = parent.manifest.parentBackupId;
    }
    fail(409, '父备份链缺少全量根节点');
  }
  function getSession(backupId) {
    const session = state.sessions[backupId];
    if (!session) {
      assertBackupNotCleared(backupId);
      fail(404, '上传会话不存在');
    }
    if (session.expiresAt <= Date.now()) fail(410, '上传会话已过期');
    assertNotCleared(session.datasetId);
    return session;
  }
  async function readBackup(backupId) {
    const backup = state.backups[backupId];
    if (!backup) fail(404, '备份不存在');
    assertNotCleared(backup.manifest.datasetId);
    const chunks = [];
    for (let index = 0; index < backup.manifest.chunkCount; index++) {
      const ciphertext = await readFile(chunkPath(backupId, index), 'utf8');
      chunks.push({ chunkIndex: index, ciphertext });
    }
    return { manifest: structuredClone(backup.manifest), chunks };
  }
  async function purgePendingTombstones() {
    let changed = false;
    for (const [datasetId, tombstone] of Object.entries(state.tombstones)) {
      for (const backupId of tombstone.pendingBackupIds || []) {
        await rm(path.join(chunksRoot, safeId(backupId, 'backupId')), { recursive: true, force: true });
      }
      if (tombstone.pendingBackupIds?.length) {
        tombstone.pendingBackupIds = [];
        tombstone.purged = true;
        changed = true;
      }
    }
    if (changed) await save();
  }
  await purgePendingTombstones();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = req.method || 'GET';
    if (method === 'GET' && url.pathname === '/__poc/health') return json(res, 200, { ok: true, service: 'encrypted-backup-poc' });

    if (method === 'POST' && url.pathname === '/__poc/tickets') {
      const body = await readJson(req);
      return withMutationLock(async () => {
        const datasetId = safeId(body.datasetId, 'datasetId');
        assertNotCleared(datasetId);
        const scopes = [...new Set(body.scopes || [])];
        if (!scopes.length || scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) fail(400, '票据权限范围非法');
        const ttlSeconds = Math.min(3600, Math.max(1, Number(body.ttlSeconds) || 600));
        const token = randomBytes(32).toString('base64url');
        const ticketId = randomBytes(16).toString('hex');
        const record = {
          ticketId, datasetId, scopes,
          issuedAt: Date.now(), expiresAt: Date.now() + ttlSeconds * 1000,
          revokedAt: null
        };
        state.tickets[tokenHash(token)] = record;
        await save();
        return json(res, 201, { ticketId, token, expiresAt: record.expiresAt });
      });
    }

    const revokeMatch = /^\/__poc\/tickets\/([A-Za-z0-9._-]+)\/revoke$/.exec(url.pathname);
    if (method === 'POST' && revokeMatch) {
      const body = await readJson(req);
      return withMutationLock(async () => {
        const datasetId = safeId(body.datasetId, 'datasetId');
        requireTicket(req, datasetId, 'ticket:revoke');
        const target = Object.entries(state.tickets).find(([, item]) => item.ticketId === revokeMatch[1] && item.datasetId === datasetId);
        if (!target) return json(res, 404, { error: '票据不存在' });
        delete state.tickets[target[0]];
        await save();
        return json(res, 200, { revoked: true, ticketId: revokeMatch[1] });
      });
    }

    const initMatch = method === 'POST' && url.pathname === '/v1/backups/init';
    if (initMatch) {
      const body = await readJson(req);
      const manifest = body.manifest;
      validateManifest(manifest);
      const datasetId = manifest.datasetId;
      requireTicket(req, datasetId, 'backup:write');
      const idempotencyKey = body.idempotencyKey;
      if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200) fail(400, '幂等键非法');
      return withMutationLock(async () => {
        assertNotCleared(datasetId);
        const key = datasetId + ':' + idempotencyKey;
        const priorBackupId = state.idempotency[key];
        if (priorBackupId) {
          if (priorBackupId !== manifest.backupId) fail(409, '幂等键已被其他备份请求使用');
          if (state.backups[priorBackupId]) return json(res, 200, { backupId: priorBackupId, state: 'committed', resumed: true });
          const priorSession = state.sessions[priorBackupId];
          if (priorSession) return json(res, 200, { backupId: priorBackupId, state: 'uploading', resumed: true });
        }
        if (state.sessions[manifest.backupId] || state.backups[manifest.backupId]) fail(409, '备份 ID 已存在');
        validateParentChain(manifest);
        const session = {
          backupId: manifest.backupId,
          datasetId,
          manifest: structuredClone(manifest),
          parts: {},
          state: 'uploading',
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * 60 * 1000,
          idempotencyKey
        };
        state.sessions[manifest.backupId] = session;
        state.idempotency[key] = manifest.backupId;
        await save();
        return json(res, 201, { backupId: manifest.backupId, state: 'uploading', resumed: false });
      });
    }

    const partMatch = /^\/v1\/backups\/([A-Za-z0-9._-]+)\/chunks\/(\d+)$/.exec(url.pathname);
    if (method === 'PUT' && partMatch) {
      const backupId = safeId(partMatch[1], 'backupId');
      const index = Number(partMatch[2]);
      const body = await readJson(req);
      return withMutationLock(async () => {
        const session = getSession(backupId);
        requireTicket(req, session.datasetId, 'backup:write');
        if (!Number.isSafeInteger(index) || index < 0 || index >= session.manifest.chunkCount) fail(400, '分块序号非法');
        const metadata = session.manifest.chunks[index];
        const bytes = decodeBase64(body.ciphertext);
        if (bytes.length !== metadata.ciphertextSize || sha256Base64(bytes) !== metadata.ciphertextHash) fail(400, '分块大小或密文哈希不匹配');
        const existingHash = session.parts[String(index)];
        if (existingHash && existingHash !== metadata.ciphertextHash) fail(409, '同一分块序号不能上传不同密文');
        if (!existingHash) {
          await atomicWrite(chunkPath(backupId, index), body.ciphertext);
          session.parts[String(index)] = metadata.ciphertextHash;
          await save();
        }
        return json(res, existingHash ? 200 : 201, { backupId, chunkIndex: index, stored: true, idempotent: Boolean(existingHash) });
      });
    }

    const missingMatch = /^\/v1\/backups\/([A-Za-z0-9._-]+)\/missing$/.exec(url.pathname);
    if (method === 'GET' && missingMatch) {
      const backupId = safeId(missingMatch[1], 'backupId');
      const session = getSession(backupId);
      requireTicket(req, session.datasetId, 'backup:write');
      const missing = Array.from({ length: session.manifest.chunkCount }, (_, index) => index)
        .filter((index) => !session.parts[String(index)]);
      return json(res, 200, { backupId, missing });
    }

    const completeMatch = /^\/v1\/backups\/([A-Za-z0-9._-]+)\/complete$/.exec(url.pathname);
    if (method === 'POST' && completeMatch) {
      const backupId = safeId(completeMatch[1], 'backupId');
      const body = await readJson(req);
      return withMutationLock(async () => {
        const session = getSession(backupId);
        requireTicket(req, session.datasetId, 'backup:write');
        if (body.datasetId !== session.datasetId) fail(403, '数据集不匹配');
        const missing = Array.from({ length: session.manifest.chunkCount }, (_, index) => index)
          .filter((index) => !session.parts[String(index)]);
        if (missing.length) fail(409, '分块不完整');
        assertNotCleared(session.datasetId);
        for (let index = 0; index < session.manifest.chunkCount; index++) {
          const ciphertext = await readFile(chunkPath(backupId, index), 'utf8');
          const metadata = session.manifest.chunks[index];
          if (sha256Base64(decodeBase64(ciphertext)) !== metadata.ciphertextHash) fail(400, '服务端密文哈希校验失败');
        }
        assertNotCleared(session.datasetId);
        state.backups[backupId] = {
          manifest: session.manifest,
          committedAt: Date.now(),
          chunkCount: session.manifest.chunkCount
        };
        delete state.sessions[backupId];
        await save();
        return json(res, 200, { backupId, state: 'committed' });
      });
    }

    const backupMatch = /^\/v1\/backups\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (method === 'GET' && backupMatch) {
      const backupId = safeId(backupMatch[1], 'backupId');
      return withMutationLock(async () => {
        const backup = state.backups[backupId];
        if (!backup) {
          assertBackupNotCleared(backupId);
          fail(404, '备份不存在');
        }
        requireTicket(req, backup.manifest.datasetId, 'backup:read');
        return json(res, 200, await readBackup(backupId));
      });
    }

    const downloadTicketMatch = method === 'POST' && /^\/v1\/backups\/([A-Za-z0-9._-]+)\/download-ticket$/.exec(url.pathname);
    if (downloadTicketMatch) {
      const backupId = safeId(downloadTicketMatch[1], 'backupId');
      return withMutationLock(async () => {
        const backup = state.backups[backupId];
        if (!backup) fail(404, '备份不存在');
        requireTicket(req, backup.manifest.datasetId, 'backup:read');
        const token = randomBytes(32).toString('base64url');
        const ticketId = randomBytes(16).toString('hex');
        const expiresAt = Date.now() + 5 * 60 * 1000;
        state.downloadTickets[tokenHash(token)] = { ticketId, tokenHash: tokenHash(token), datasetId: backup.manifest.datasetId, backupId, expiresAt };
        await save();
        return json(res, 201, { ticketId, downloadUrl: '/api/v1/download/' + token, expiresAt });
      });
    }

    const downloadMatch = /^\/v1\/download\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (method === 'GET' && downloadMatch) {
      const token = downloadMatch[1];
      const downloadHash = tokenHash(token);
      const ticket = state.downloadTickets[downloadHash];
      if (!ticket) {
        if (Object.values(state.tombstones).some((item) => (item.downloadTicketHashes || []).includes(downloadHash))) {
          fail(410, '下载备份所属数据集已清除');
        }
        fail(401, '下载票据无效或已过期');
      }
      if (ticket.expiresAt <= Date.now()) fail(401, '下载票据无效或已过期');
      return withMutationLock(async () => {
        assertNotCleared(ticket.datasetId);
        if (!state.backups[ticket.backupId]) fail(404, '备份不存在');
        return json(res, 200, await readBackup(ticket.backupId));
      });
    }

    const clearMatch = method === 'POST' && /^\/v1\/datasets\/([A-Za-z0-9._-]+)\/clear$/.exec(url.pathname);
    if (clearMatch) {
      const datasetId = safeId(clearMatch[1], 'datasetId');
      return withMutationLock(async () => {
        requireTicket(req, datasetId, 'backup:clear');
        const backupIds = [
          ...Object.values(state.backups).filter((item) => item.manifest.datasetId === datasetId).map((item) => item.manifest.backupId),
          ...Object.values(state.sessions).filter((item) => item.datasetId === datasetId).map((item) => item.backupId)
        ];
        const downloadTicketHashes = Object.entries(state.downloadTickets)
          .filter(([, item]) => item.datasetId === datasetId)
          .map(([hash]) => hash);
        state.tombstones[datasetId] = {
          clearedAt: Date.now(),
          backupIds: [...new Set(backupIds)],
          downloadTicketHashes,
          pendingBackupIds: [...new Set(backupIds)],
          purged: false
        };
        for (const [id, item] of Object.entries(state.backups)) if (item.manifest.datasetId === datasetId) delete state.backups[id];
        for (const [id, item] of Object.entries(state.sessions)) if (item.datasetId === datasetId) delete state.sessions[id];
        for (const [key, backupId] of Object.entries(state.idempotency)) if (backupIds.includes(backupId)) delete state.idempotency[key];
        for (const [hash, item] of Object.entries(state.tickets)) if (item.datasetId === datasetId) delete state.tickets[hash];
        for (const [hash, item] of Object.entries(state.downloadTickets)) if (item.datasetId === datasetId) delete state.downloadTickets[hash];
        await save(); // Tombstone is durable before encrypted files are purged.
        for (const backupId of backupIds) await rm(path.join(chunksRoot, backupId), { recursive: true, force: true });
        state.tombstones[datasetId].pendingBackupIds = [];
        state.tombstones[datasetId].purged = true;
        await save();
        return json(res, 200, { cleared: true, purgedBackupCount: backupIds.length });
      });
    }

    return json(res, 404, { error: '接口不存在' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, error.statusCode || 500, { error: error.message || '服务端错误' });
      else res.destroy();
    });
  });
  return { server, dataDir: root, stateFile };
}

export async function listenBackupHttpServer(options) {
  const app = await createBackupHttpServer(options);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(options.port ?? 4180, options.host ?? '127.0.0.1', resolve);
  });
  return app;
}
