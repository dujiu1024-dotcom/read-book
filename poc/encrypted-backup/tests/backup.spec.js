import { test, expect } from '@playwright/test';

test('全量备份可加密上传并往返恢复', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '加密并上传' }).click();
  await expect(page.locator('#status')).toContainText('备份完成');
  await page.getByRole('button', { name: '下载并恢复' }).click();
  await expect(page.locator('#status')).toContainText('恢复成功');
  const output = JSON.parse(await page.locator('#output').textContent());
  expect(output.restored.messages[0].id).toBe('m1');
  expect(output.serverCanDecrypt).toBe(false);
});

test('密文篡改会被发现，且不覆盖本地数据', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '加密并上传' }).click();
  await expect(page.locator('#status')).toContainText('备份完成');
  await page.getByRole('button', { name: '下载并恢复' }).click();
  await expect(page.locator('#status')).toContainText('恢复成功');
  await page.getByRole('button', { name: '篡改密文后恢复' }).click();
  await expect(page.locator('#status')).toContainText('篡改检测成功');
  const output = JSON.parse(await page.locator('#output').textContent());
  expect(output.detected).toBe(true);
  expect(output.existingLocalDataPreserved).toBe(true);
});

test('清除墓碑阻止旧备份访问', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '加密并上传' }).click();
  await expect(page.locator('#status')).toContainText('备份完成');
  await page.getByRole('button', { name: '写入清除墓碑' }).click();
  const output = JSON.parse(await page.locator('#output').textContent());
  expect(output.cleared).toBe(true);
  expect(output.oldAccessRejected).toBe(true);
});

test('错误恢复密钥不能解密备份', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup, decryptBackup } = await import('/src/crypto.js');
    const backup = await createEncryptedBackup({ datasetId: 'wrong-key-test', sequence: 1, payload: { secret: 'fixture' } });
    const wrong = (backup.recoveryKey[0] === 'A' ? 'B' : 'A') + backup.recoveryKey.slice(1);
    try {
      await decryptBackup({ manifest: backup.manifest, chunks: backup.chunks, recoveryKey: wrong });
      return { rejected: false };
    } catch (error) { return { rejected: true, name: error.name }; }
  });
  expect(result.rejected).toBe(true);
});

test('大于单块的数据可分块加密并完整恢复', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup, decryptBackup } = await import('/src/crypto.js');
    const payload = { text: 'x'.repeat(150_000) };
    const backup = await createEncryptedBackup({ datasetId: 'multi-chunk-test', sequence: 1, payload });
    const restored = await decryptBackup({ manifest: backup.manifest, chunks: backup.chunks, recoveryKey: backup.recoveryKey });
    return { chunks: backup.chunks.length, restoredLength: restored.text.length };
  });
  expect(result.chunks).toBeGreaterThan(1);
  expect(result.restoredLength).toBe(150_000);
});

test('Mock 服务端在提交前拒绝被篡改的密文块', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    const backup = await createEncryptedBackup({ datasetId: 'server-hash-test', sequence: 1, payload: { text: 'fixture' } });
    const server = new MockBackupServer();
    server.init(backup.manifest, 'idempotency-test');
    const chunk = { ...backup.chunks[0] };
    const bytes = Uint8Array.from(atob(chunk.ciphertext), (char) => char.charCodeAt(0));
    bytes[0] ^= 1;
    chunk.ciphertext = btoa(String.fromCharCode(...bytes));
    server.putPart(backup.manifest.backupId, chunk);
    try {
      await server.complete(backup.manifest.backupId);
      return { rejected: false };
    } catch (error) { return { rejected: true, message: error.message }; }
  });
  expect(result.rejected).toBe(true);
  expect(result.message).toContain('哈希校验失败');
});

test('全量后可创建有序增量备份并验证父链', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup, decryptBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    const server = new MockBackupServer();
    const full = await createEncryptedBackup({ datasetId: 'chain-dataset', sequence: 1, payload: { version: 1, records: ['a'] } });
    server.init(full.manifest, 'full-key');
    for (const chunk of full.chunks) server.putPart(full.manifest.backupId, chunk);
    await server.complete(full.manifest.backupId);
    const incremental = await createEncryptedBackup({ datasetId: 'chain-dataset', sequence: 2, parentBackupId: full.manifest.backupId, payload: { changes: [{ id: 'b', op: 'insert' }] } });
    server.init(incremental.manifest, 'incremental-key');
    for (const chunk of incremental.chunks) server.putPart(incremental.manifest.backupId, chunk);
    await server.complete(incremental.manifest.backupId);
    const remote = server.get(incremental.manifest.backupId);
    const restored = await decryptBackup({ ...remote, recoveryKey: incremental.recoveryKey });
    return { type: remote.manifest.backupType, parent: remote.manifest.parentBackupId, restored };
  });
  expect(result.type).toBe('incremental');
  expect(result.parent).toBeTruthy();
  expect(result.restored.changes[0].id).toBe('b');
});

test('增量备份拒绝缺失父备份、跨数据集父备份和错误序号', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    const server = new MockBackupServer();
    const full = await createEncryptedBackup({ datasetId: 'parent-dataset', sequence: 1, payload: { v: 1 } });
    server.init(full.manifest, 'parent-key');
    for (const chunk of full.chunks) server.putPart(full.manifest.backupId, chunk);
    await server.complete(full.manifest.backupId);
    const missing = await createEncryptedBackup({ datasetId: 'parent-dataset', sequence: 2, parentBackupId: 'not-found', payload: { v: 2 } });
    let missingRejected = false;
    try { server.init(missing.manifest, 'missing-key'); } catch { missingRejected = true; }
    const crossDataset = await createEncryptedBackup({ datasetId: 'other-dataset', sequence: 2, parentBackupId: full.manifest.backupId, payload: { v: 2 } });
    let crossRejected = false;
    try { server.init(crossDataset.manifest, 'cross-key'); } catch { crossRejected = true; }
    const wrongSequence = await createEncryptedBackup({ datasetId: 'parent-dataset', sequence: 3, parentBackupId: full.manifest.backupId, payload: { v: 3 } });
    let sequenceRejected = false;
    try { server.init(wrongSequence.manifest, 'sequence-key'); } catch { sequenceRejected = true; }
    return { missingRejected, crossRejected, sequenceRejected };
  });
  expect(result).toEqual({ missingRejected: true, crossRejected: true, sequenceRejected: true });
});

test('增量父链元数据被篡改时 AEAD 校验失败', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup, decryptBackup } = await import('/src/crypto.js');
    const full = await createEncryptedBackup({ datasetId: 'aad-chain', sequence: 1, payload: { v: 1 } });
    const incremental = await createEncryptedBackup({ datasetId: 'aad-chain', sequence: 2, parentBackupId: full.manifest.backupId, payload: { v: 2 } });
    const altered = structuredClone(incremental.manifest);
    altered.parentBackupId = 'tampered-parent';
    try {
      await decryptBackup({ manifest: altered, chunks: incremental.chunks, recoveryKey: incremental.recoveryKey });
      return false;
    } catch { return true; }
  });
  expect(result).toBe(true);
});

test('清除墓碑与正在进行的上传完成竞争时墓碑优先', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    const backup = await createEncryptedBackup({ datasetId: 'clear-race', sequence: 1, payload: { v: 1 } });
    const server = new MockBackupServer();
    server.init(backup.manifest, 'clear-race-key');
    for (const chunk of backup.chunks) server.putPart(backup.manifest.backupId, chunk);
    const completing = server.complete(backup.manifest.backupId);
    server.clearDataset('clear-race');
    try { await completing; return { rejected: false, cleared: server.isCleared('clear-race') }; }
    catch { return { rejected: true, cleared: server.isCleared('clear-race') }; }
  });
  expect(result).toEqual({ rejected: true, cleared: true });
});
