import './style.css';
import { createEncryptedBackup, decryptBackup } from './crypto.js';
import { MockBackupServer } from './mock-server.js';

const server = new MockBackupServer();
const datasetId = 'poc-dataset-' + crypto.randomUUID();
let lastBackup;
let localRestoredData = null;
const $ = (id) => document.getElementById(id);
const show = (value) => $('output').textContent = JSON.stringify(value, null, 2);
$('backup').addEventListener('click', async () => {
  try {
    const payload = JSON.parse($('payload').value);
    const encrypted = await createEncryptedBackup({ datasetId, sequence: 1, payload });
    const session = server.init(encrypted.manifest, 'init-' + encrypted.manifest.backupId);
    for (const chunk of encrypted.chunks) server.putPart(encrypted.manifest.backupId, chunk);
    await server.complete(encrypted.manifest.backupId);
    lastBackup = { ...encrypted, state: 'committed' };
    $('status').textContent = '备份完成：服务端仅保存密文与 Manifest。';
    show({ datasetId, backupId: encrypted.manifest.backupId, chunks: encrypted.manifest.chunkCount, recoveryKey: encrypted.recoveryKey, serverCanDecrypt: false, state: session.state });
  } catch (error) { $('status').textContent = '备份失败'; show({ error: error.message }); }
});
$('restore').addEventListener('click', async () => {
  if (!lastBackup) { $('status').textContent = '请先创建备份'; return; }
  try {
    const remote = server.get(lastBackup.manifest.backupId);
    const restored = await decryptBackup({ ...remote, recoveryKey: lastBackup.recoveryKey });
    localRestoredData = restored;
    $('status').textContent = '恢复成功；本地数据已在解密校验后替换。';
    show({ restored, serverCanDecrypt: false });
  } catch (error) { $('status').textContent = '恢复失败；原本地数据未修改。'; show({ error: error.message, existingLocalDataPreserved: true }); }
});
$('tamper').addEventListener('click', async () => {
  if (!lastBackup) { $('status').textContent = '请先创建备份'; return; }
  const remote = server.get(lastBackup.manifest.backupId);
  const first = remote.chunks[0];
  const bytes = Uint8Array.from(atob(first.ciphertext), (char) => char.charCodeAt(0));
  bytes[0] ^= 1;
  first.ciphertext = btoa(String.fromCharCode(...bytes));
  try {
    await decryptBackup({ ...remote, recoveryKey: lastBackup.recoveryKey });
    $('status').textContent = '错误：篡改未被发现';
  } catch (error) {
    $('status').textContent = '篡改检测成功；恢复未提交，原本地数据不变。';
    show({ detected: true, error: error.message, existingLocalDataPreserved: true, localDataPresent: localRestoredData !== null });
  }
});
$('clear').addEventListener('click', () => {
  server.clearDataset(datasetId);
  try { server.get(lastBackup?.manifest.backupId); }
  catch (error) { $('status').textContent = '清除墓碑已生效；旧备份不可访问。'; show({ cleared: server.isCleared(datasetId), oldAccessRejected: true, error: error.message }); }
});
