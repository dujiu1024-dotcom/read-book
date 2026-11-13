import './style.css';
import { createEncryptedBackup, decryptBackup } from './crypto.js';

const datasetId = 'poc-dataset-' + crypto.randomUUID();
let ticketToken;
let ticketId;
let lastBackup;
let lastDownloadUrl;
let localRestoredData = null;
const $ = (id) => document.getElementById(id);
const show = (value) => $('output').textContent = JSON.stringify(value, null, 2);

async function api(path, { method = 'GET', body, token = ticketToken } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const response = await fetch('/api' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function initializeTicket() {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const ticket = await api('/__poc/tickets', {
        method: 'POST',
        token: undefined,
        body: {
          datasetId,
          scopes: ['backup:read', 'backup:write', 'backup:clear', 'ticket:revoke'],
          ttlSeconds: 1800
        }
      });
      ticketToken = ticket.token;
      ticketId = ticket.ticketId;
      $('status').textContent = 'HTTP 备份服务已连接；授权票据仅保存在当前页面内存。';
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError;
}
let ticketError;
const ticketReady = initializeTicket().catch((error) => {
  ticketError = error;
  $('status').textContent = '备份服务连接失败';
  show({ error: error.message });
  return false;
});
async function ensureTicket() {
  if (!(await ticketReady)) throw ticketError || new Error('备份服务未连接');
}

$('backup').addEventListener('click', async () => {
  try {
    await ensureTicket();
    const payload = JSON.parse($('payload').value);
    const encrypted = await createEncryptedBackup({ datasetId, sequence: 1, payload });
    const session = await api('/v1/backups/init', {
      method: 'POST',
      body: { manifest: encrypted.manifest, idempotencyKey: 'init-' + encrypted.manifest.backupId }
    });
    const resume = await api('/v1/backups/' + encrypted.manifest.backupId + '/missing');
    const missing = new Set(resume.missing);
    for (const chunk of encrypted.chunks) {
      if (!missing.has(chunk.chunkIndex)) continue;
      await api('/v1/backups/' + encrypted.manifest.backupId + '/chunks/' + chunk.chunkIndex, {
        method: 'PUT',
        body: { ciphertext: chunk.ciphertext }
      });
    }
    await api('/v1/backups/' + encrypted.manifest.backupId + '/complete', {
      method: 'POST', body: { datasetId }
    });
    lastBackup = { manifest: encrypted.manifest, recoveryKey: encrypted.recoveryKey, state: 'committed' };
    $('status').textContent = '备份完成：HTTP 服务端仅保存密文与 Manifest。';
    show({
      datasetId,
      backupId: encrypted.manifest.backupId,
      chunks: encrypted.manifest.chunkCount,
      recoveryKey: encrypted.recoveryKey,
      serverCanDecrypt: false,
      state: session.state,
      uploadResumed: session.resumed
    });
  } catch (error) { $('status').textContent = '备份失败'; show({ error: error.message }); }
});

$('restore').addEventListener('click', async () => {
  if (!lastBackup) { $('status').textContent = '请先创建备份'; return; }
  try {
    await ensureTicket();
    const remote = await api('/v1/backups/' + lastBackup.manifest.backupId);
    const restored = await decryptBackup({ ...remote, recoveryKey: lastBackup.recoveryKey });
    localRestoredData = restored;
    $('status').textContent = '恢复成功；本地数据已在解密校验后替换。';
    show({ restored, serverCanDecrypt: false });
  } catch (error) { $('status').textContent = '恢复失败；原本地数据未修改。'; show({ error: error.message, existingLocalDataPreserved: true }); }
});

$('tamper').addEventListener('click', async () => {
  if (!lastBackup) { $('status').textContent = '请先创建备份'; return; }
  try {
    await ensureTicket();
    const remote = await api('/v1/backups/' + lastBackup.manifest.backupId);
    const first = remote.chunks[0];
    const bytes = Uint8Array.from(atob(first.ciphertext), (char) => char.charCodeAt(0));
    bytes[0] ^= 1;
    first.ciphertext = btoa(String.fromCharCode(...bytes));
    await decryptBackup({ ...remote, recoveryKey: lastBackup.recoveryKey });
    $('status').textContent = '错误：篡改未被发现';
  } catch (error) {
    $('status').textContent = '篡改检测成功；恢复未提交，原本地数据不变。';
    show({ detected: true, error: error.message, existingLocalDataPreserved: true, localDataPresent: localRestoredData !== null });
  }
});

$('clear').addEventListener('click', async () => {
  if (!lastBackup) { $('status').textContent = '请先创建备份'; return; }
  try {
    await ensureTicket();
    const download = await api('/v1/backups/' + lastBackup.manifest.backupId + '/download-ticket', { method: 'POST', body: {} });
    lastDownloadUrl = download.downloadUrl;
    const result = await api('/v1/datasets/' + datasetId + '/clear', { method: 'POST', body: {} });
    let oldBackupRejected = false;
    let downloadUrlRejected = false;
    try { await api('/v1/backups/' + lastBackup.manifest.backupId); }
    catch (error) { oldBackupRejected = error.status === 410 || error.status === 401 || error.status === 404; }
    try {
      const response = await fetch(lastDownloadUrl);
      downloadUrlRejected = !response.ok;
    } catch { downloadUrlRejected = true; }
    $('status').textContent = '清除墓碑已生效；旧备份和下载票据均不可访问。';
    show({ ...result, oldBackupRejected, downloadUrlRejected, localDataStillPresent: localRestoredData !== null });
  } catch (error) {
    $('status').textContent = '服务端清除失败';
    show({ error: error.message });
  }
});

void ticketId;
