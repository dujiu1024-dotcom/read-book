import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatasetKeyMaterial, createEncryptedBackup, decryptBackup, restoreBackupChain } from '../src/crypto.js';
import { listenBackupHttpServer } from '../server/http-server.js';

async function closeServer(app) {
  if (!app?.server?.listening) return;
  await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
}
async function startServer(dataDir, options = {}) {
  const app = await listenBackupHttpServer({ dataDir, port: 0, host: '127.0.0.1', ...options });
  return { app, base: 'http://127.0.0.1:' + app.server.address().port };
}
async function request(base, route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  return { status: response.status, body: result };
}
async function issueTicket(base, datasetId, scopes = ['backup:read', 'backup:write', 'backup:clear', 'ticket:revoke'], ttlSeconds = 600) {
  const result = await request(base, '/__poc/tickets', {
    method: 'POST', body: { datasetId, scopes, ttlSeconds }
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}
async function uploadBackup(base, ticket, encrypted, idempotencyKey = 'idem-' + encrypted.manifest.backupId) {
  const init = await request(base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: encrypted.manifest, idempotencyKey }
  });
  assert.ok([200, 201].includes(init.status), JSON.stringify(init.body));
  if (init.body.state === 'committed') return init.body;
  const missing = await request(base, '/v1/backups/' + encrypted.manifest.backupId + '/missing', { token: ticket.token });
  assert.equal(missing.status, 200, JSON.stringify(missing.body));
  for (const index of missing.body.missing) {
    const chunk = encrypted.chunks.find((item) => item.chunkIndex === index);
    const uploaded = await request(base, '/v1/backups/' + encrypted.manifest.backupId + '/chunks/' + index, {
      method: 'PUT', token: ticket.token, body: { ciphertext: chunk.ciphertext }
    });
    assert.ok([200, 201].includes(uploaded.status), JSON.stringify(uploaded.body));
  }
  const complete = await request(base, '/v1/backups/' + encrypted.manifest.backupId + '/complete', {
    method: 'POST', token: ticket.token, body: { datasetId: encrypted.manifest.datasetId }
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  return complete.body;
}
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'read-book-backup-http-'));
  let running = await startServer(dataDir, options);
  t.after(async () => {
    await closeServer(running.app);
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    get base() { return running.base; },
    async restart() {
      await closeServer(running.app);
      running = await startServer(dataDir, options);
    }
  };
}
const allScopes = ['backup:read', 'backup:write', 'backup:clear', 'ticket:revoke'];

test('HTTP 上传支持断点续传，服务重启后可继续并恢复密文', async (t) => {
  const env = await fixture(t);
  const datasetId = 'http-resume-dataset';
  const ticket = await issueTicket(env.base, datasetId);
  const payload = { marker: 'PLAINTEXT_MUST_NOT_REACH_SERVER', text: '长文本内容'.repeat(26000) };
  const encrypted = await createEncryptedBackup({ datasetId, sequence: 1, payload });
  assert.ok(encrypted.chunks.length >= 2);

  const init = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: encrypted.manifest, idempotencyKey: 'resume-full-1' }
  });
  assert.equal(init.status, 201);
  const first = encrypted.chunks[0];
  const firstUpload = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/chunks/0', {
    method: 'PUT', token: ticket.token, body: { ciphertext: first.ciphertext }
  });
  assert.equal(firstUpload.status, 201);
  const beforeRestart = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/missing', { token: ticket.token });
  assert.deepEqual(beforeRestart.body.missing, encrypted.chunks.slice(1).map((item) => item.chunkIndex));

  await env.restart();
  const afterRestart = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/missing', { token: ticket.token });
  assert.deepEqual(afterRestart.body.missing, beforeRestart.body.missing);
  for (const index of afterRestart.body.missing) {
    const chunk = encrypted.chunks[index];
    const result = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/chunks/' + index, {
      method: 'PUT', token: ticket.token, body: { ciphertext: chunk.ciphertext }
    });
    assert.equal(result.status, 201);
  }
  const committed = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/complete', {
    method: 'POST', token: ticket.token, body: { datasetId }
  });
  assert.equal(committed.status, 200);
  const remote = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId, { token: ticket.token });
  assert.equal(remote.status, 200);
  assert.deepEqual(await decryptBackup({ ...remote.body, recoveryKey: encrypted.recoveryKey }), payload);

  const persistedState = await readFile(path.join(env.dataDir, 'state.json'), 'utf8');
  assert.equal(persistedState.includes(payload.marker), false);
  assert.equal(persistedState.includes(encrypted.recoveryKey), false);
  assert.equal(persistedState.includes('PLAINTEXT_MUST_NOT_REACH_SERVER'), false);
  const persistedChunk = await readFile(path.join(env.dataDir, 'chunks', encrypted.manifest.backupId, '0.b64'), 'utf8');
  assert.equal(persistedChunk.includes(payload.marker), false);
  assert.equal(persistedChunk.includes(encrypted.recoveryKey), false);
});

test('HTTP 父链验证、幂等键和全量到多级增量备份', async (t) => {
  const env = await fixture(t);
  const datasetId = 'http-chain-dataset';
  const ticket = await issueTicket(env.base, datasetId);
  const keyMaterial = createDatasetKeyMaterial(datasetId);
  const full = await createEncryptedBackup({ datasetId, sequence: 1, payload: { records: [{ id: 'a', value: 'A' }] }, keyMaterial });
  await uploadBackup(env.base, ticket, full, 'same-idempotency-key');

  const repeated = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: full.manifest, idempotencyKey: 'same-idempotency-key' }
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.state, 'committed');
  assert.equal(repeated.body.resumed, true);

  const collision = await createEncryptedBackup({ datasetId, sequence: 1, payload: { value: 'different' } });
  const reusedKey = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: collision.manifest, idempotencyKey: 'same-idempotency-key' }
  });
  assert.equal(reusedKey.status, 409);

  const incremental = await createEncryptedBackup({
    datasetId, sequence: 2, parentBackupId: full.manifest.backupId, payload: { changes: [{ op: 'upsert', record: { id: 'b', value: 'B' } }] }, keyMaterial
  });
  await uploadBackup(env.base, ticket, incremental);
  const incremental2 = await createEncryptedBackup({
    datasetId, sequence: 3, parentBackupId: incremental.manifest.backupId, payload: { changes: [{ op: 'delete', id: 'a' }, { op: 'upsert', record: { id: 'c', value: 'C' } }] }, keyMaterial
  });
  await uploadBackup(env.base, ticket, incremental2);
  const restoredFull = await request(env.base, '/v1/backups/' + full.manifest.backupId, { token: ticket.token });
  const restoredIncremental2 = await request(env.base, '/v1/backups/' + incremental2.manifest.backupId, { token: ticket.token });
  assert.deepEqual(await decryptBackup({ ...restoredFull.body, recoveryKey: keyMaterial.recoveryKey }), { records: [{ id: 'a', value: 'A' }] });
  assert.deepEqual(await decryptBackup({ ...restoredIncremental2.body, recoveryKey: keyMaterial.recoveryKey }), {
    changes: [{ op: 'delete', id: 'a' }, { op: 'upsert', record: { id: 'c', value: 'C' } }]
  });
  const restoredChain = await restoreBackupChain({
    backupId: incremental2.manifest.backupId,
    fetchBackup: async (backupId) => {
      const response = await request(env.base, '/v1/backups/' + backupId, { token: ticket.token });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body;
    },
    recoveryKey: keyMaterial.recoveryKey
  });
  assert.deepEqual(restoredChain.snapshot, { records: [{ id: 'b', value: 'B' }, { id: 'c', value: 'C' }] });
  assert.equal(restoredChain.depth, 3);
  assert.equal(full.recoveryKey, incremental.recoveryKey);
  assert.equal(incremental.recoveryKey, incremental2.recoveryKey);

  const missingParent = await createEncryptedBackup({
    datasetId, sequence: 2, parentBackupId: 'missing-parent', payload: { value: 'bad-parent' }
  });
  const missingParentResult = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: missingParent.manifest, idempotencyKey: 'missing-parent' }
  });
  assert.equal(missingParentResult.status, 409);

  const sequenceGap = await createEncryptedBackup({
    datasetId, sequence: 4, parentBackupId: full.manifest.backupId, payload: { value: 'bad-sequence' }
  });
  const sequenceGapResult = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: sequenceGap.manifest, idempotencyKey: 'sequence-gap' }
  });
  assert.equal(sequenceGapResult.status, 409);

  const crossDataset = await createEncryptedBackup({
    datasetId: 'another-dataset', sequence: 2, parentBackupId: full.manifest.backupId, payload: { value: 'cross-dataset' }
  });
  const crossDatasetResult = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: (await issueTicket(env.base, 'another-dataset')).token,
    body: { manifest: crossDataset.manifest, idempotencyKey: 'cross-dataset' }
  });
  assert.equal(crossDatasetResult.status, 409);
});

test('HTTP 票据按数据集和权限隔离，支持撤销与过期', async (t) => {
  const env = await fixture(t);
  const datasetId = 'http-ticket-dataset';
  const revokeTicket = await issueTicket(env.base, datasetId, ['ticket:revoke'], 600);
  const readOnlyTicket = await issueTicket(env.base, datasetId, ['backup:read'], 600);
  const ticketState = JSON.parse(await readFile(path.join(env.dataDir, 'state.json'), 'utf8'));
  assert.equal((await readFile(path.join(env.dataDir, 'state.json'), 'utf8')).includes(readOnlyTicket.token), false);
  assert.ok(Object.keys(ticketState.tickets).every((hash) => /^[a-f0-9]{64}$/.test(hash)));
  const encrypted = await createEncryptedBackup({ datasetId, sequence: 1, payload: { value: 'ticket-scope' } });
  const denied = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: readOnlyTicket.token,
    body: { manifest: encrypted.manifest, idempotencyKey: 'read-only-write' }
  });
  assert.equal(denied.status, 403);

  const revoke = await request(env.base, '/__poc/tickets/' + readOnlyTicket.ticketId + '/revoke', {
    method: 'POST', token: revokeTicket.token, body: { datasetId }
  });
  assert.equal(revoke.status, 200);
  const revokedUse = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: readOnlyTicket.token,
    body: { manifest: encrypted.manifest, idempotencyKey: 'revoked-write' }
  });
  assert.equal(revokedUse.status, 401);

  const expiring = await issueTicket(env.base, datasetId, ['backup:write'], 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const expiredUse = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: expiring.token,
    body: { manifest: encrypted.manifest, idempotencyKey: 'expired-write' }
  });
  assert.equal(expiredUse.status, 401);
});

test('清除墓碑先持久化，再撤销票据、下载 URL、会话和密文文件', async (t) => {
  const env = await fixture(t);
  const datasetId = 'http-clear-dataset';
  const ticket = await issueTicket(env.base, datasetId, allScopes);
  const encrypted = await createEncryptedBackup({ datasetId, sequence: 1, payload: { value: 'clear-me' } });
  await uploadBackup(env.base, ticket, encrypted);
  const download = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/download-ticket', {
    method: 'POST', token: ticket.token, body: {}
  });
  assert.equal(download.status, 201);
  const downloadToken = download.body.downloadUrl.split('/').pop();
  const stateWithDownloadTicket = await readFile(path.join(env.dataDir, 'state.json'), 'utf8');
  assert.equal(stateWithDownloadTicket.includes(downloadToken), false);
  assert.ok(Object.keys(JSON.parse(stateWithDownloadTicket).downloadTickets)
    .every((hash) => /^[a-f0-9]{64}$/.test(hash)));

  const pending = await createEncryptedBackup({ datasetId, sequence: 2, parentBackupId: encrypted.manifest.backupId, payload: { value: 'pending' } });
  const pendingInit = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: pending.manifest, idempotencyKey: 'pending-before-clear' }
  });
  assert.equal(pendingInit.status, 201);

  const cleared = await request(env.base, '/v1/datasets/' + datasetId + '/clear', {
    method: 'POST', token: ticket.token, body: {}
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.purgedBackupCount, 2);

  const oldBackup = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId, { token: ticket.token });
  assert.equal(oldBackup.status, 410);
  const oldDownload = await fetch(env.base + download.body.downloadUrl.replace(/^\/api/, ''));
  assert.equal(oldDownload.status, 410);
  const oldSession = await request(env.base, '/v1/backups/' + pending.manifest.backupId + '/missing', { token: ticket.token });
  assert.equal(oldSession.status, 410);
  const lateUpload = await request(env.base, '/v1/backups/' + pending.manifest.backupId + '/chunks/0', {
    method: 'PUT', token: ticket.token,
    body: { ciphertext: pending.chunks[0].ciphertext }
  });
  assert.equal(lateUpload.status, 410);
  const newTicket = await request(env.base, '/__poc/tickets', {
    method: 'POST', body: { datasetId, scopes: allScopes, ttlSeconds: 600 }
  });
  assert.equal(newTicket.status, 410);

  await env.restart();
  const afterRestart = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId, { token: ticket.token });
  assert.equal(afterRestart.status, 410);
  const state = JSON.parse(await readFile(path.join(env.dataDir, 'state.json'), 'utf8'));
  assert.equal(state.tombstones[datasetId].purged, true);
  assert.ok((await readdir(path.join(env.dataDir, 'chunks'))).length === 0);
});

test('清除与完成并发竞态不能复活已清除的数据集', async (t) => {
  const env = await fixture(t);
  const datasetId = 'http-clear-race-dataset';
  const ticket = await issueTicket(env.base, datasetId, allScopes);
  const encrypted = await createEncryptedBackup({ datasetId, sequence: 1, payload: { value: 'race' } });
  const init = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: encrypted.manifest, idempotencyKey: 'race-init' }
  });
  assert.equal(init.status, 201);
  for (const chunk of encrypted.chunks) {
    const result = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/chunks/' + chunk.chunkIndex, {
      method: 'PUT', token: ticket.token, body: { ciphertext: chunk.ciphertext }
    });
    assert.equal(result.status, 201);
  }

  const [complete, clear] = await Promise.all([
    request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/complete', {
      method: 'POST', token: ticket.token, body: { datasetId }
    }),
    request(env.base, '/v1/datasets/' + datasetId + '/clear', {
      method: 'POST', token: ticket.token, body: {}
    })
  ]);
  assert.ok([200, 410].includes(complete.status));
  assert.equal(clear.status, 200);
  const afterRace = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId, { token: ticket.token });
  assert.equal(afterRace.status, 410);
});

test('上传会话过期后可用原幂等键重新初始化，不复用旧分块', async (t) => {
  const env = await fixture(t, { uploadSessionTtlMs: 20 });
  const datasetId = 'http-session-expiry';
  const ticket = await issueTicket(env.base, datasetId);
  const encrypted = await createEncryptedBackup({ datasetId, sequence: 1, payload: { value: 'session-expiry' } });
  const key = 'expired-session-key';
  const first = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: encrypted.manifest, idempotencyKey: key }
  });
  assert.equal(first.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 35));
  const expired = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/missing', { token: ticket.token });
  assert.equal(expired.status, 410);
  const restarted = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: encrypted.manifest, idempotencyKey: key }
  });
  assert.equal(restarted.status, 201);
  assert.equal(restarted.body.resumed, false);
  const missing = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/missing', { token: ticket.token });
  assert.deepEqual(missing.body.missing, encrypted.chunks.map((chunk) => chunk.chunkIndex));
});

test('服务端拒绝不完整分块和被篡改密文，重复上传同一密文幂等', async (t) => {
  const env = await fixture(t);
  const datasetId = 'http-integrity-dataset';
  const ticket = await issueTicket(env.base, datasetId);
  const encrypted = await createEncryptedBackup({ datasetId, sequence: 1, payload: { text: 'integrity'.repeat(20000) } });
  const init = await request(env.base, '/v1/backups/init', {
    method: 'POST', token: ticket.token,
    body: { manifest: encrypted.manifest, idempotencyKey: 'integrity-init' }
  });
  assert.equal(init.status, 201);

  const incomplete = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/complete', {
    method: 'POST', token: ticket.token, body: { datasetId }
  });
  assert.equal(incomplete.status, 409);

  const first = encrypted.chunks[0];
  const uploaded = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/chunks/0', {
    method: 'PUT', token: ticket.token, body: { ciphertext: first.ciphertext }
  });
  assert.equal(uploaded.status, 201);
  const repeated = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/chunks/0', {
    method: 'PUT', token: ticket.token, body: { ciphertext: first.ciphertext }
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.idempotent, true);

  const tampered = Uint8Array.from(Buffer.from(encrypted.chunks[1].ciphertext, 'base64'));
  tampered[0] ^= 1;
  const tamperedUpload = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/chunks/1', {
    method: 'PUT', token: ticket.token, body: { ciphertext: Buffer.from(tampered).toString('base64') }
  });
  assert.equal(tamperedUpload.status, 400);
});

test('HTTP 下载票据到期后不能继续访问密文', async (t) => {
  const env = await fixture(t, { downloadTicketTtlMs: 20 });
  const datasetId = 'http-download-expiry';
  const ticket = await issueTicket(env.base, datasetId);
  const encrypted = await createEncryptedBackup({ datasetId, sequence: 1, payload: { value: 'expires' } });
  await uploadBackup(env.base, ticket, encrypted);
  const issued = await request(env.base, '/v1/backups/' + encrypted.manifest.backupId + '/download-ticket', {
    method: 'POST', token: ticket.token, body: {}
  });
  assert.equal(issued.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 35));
  const expired = await fetch(env.base + issued.body.downloadUrl.replace(/^\/api/, ''));
  assert.equal(expired.status, 401);
});
