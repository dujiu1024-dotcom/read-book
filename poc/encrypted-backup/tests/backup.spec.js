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
