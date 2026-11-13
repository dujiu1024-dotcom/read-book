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
  await expect(page.locator('#status')).toContainText('清除墓碑已生效');
  const output = JSON.parse(await page.locator('#output').textContent());
  console.log('HTTP clear result:', JSON.stringify(output));
  expect(output.cleared, JSON.stringify(output)).toBe(true);
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
    const { createDatasetKeyMaterial, createEncryptedBackup, decryptBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    const server = new MockBackupServer();
    const keyMaterial = createDatasetKeyMaterial('chain-dataset');
    const full = await createEncryptedBackup({ datasetId: 'chain-dataset', sequence: 1, payload: { version: 1, records: ['a'] }, keyMaterial });
    server.init(full.manifest, 'full-key');
    for (const chunk of full.chunks) server.putPart(full.manifest.backupId, chunk);
    await server.complete(full.manifest.backupId);
    const incremental = await createEncryptedBackup({ datasetId: 'chain-dataset', sequence: 2, parentBackupId: full.manifest.backupId, payload: { changes: [{ id: 'b', op: 'insert' }] }, keyMaterial });
    server.init(incremental.manifest, 'incremental-key');
    for (const chunk of incremental.chunks) server.putPart(incremental.manifest.backupId, chunk);
    await server.complete(incremental.manifest.backupId);
    const remote = server.get(incremental.manifest.backupId);
    const restored = await decryptBackup({ ...remote, recoveryKey: keyMaterial.recoveryKey });
    const restoredFull = await decryptBackup({ ...server.get(full.manifest.backupId), recoveryKey: keyMaterial.recoveryKey });
    return {
      type: remote.manifest.backupType, parent: remote.manifest.parentBackupId, restored,
      sameRecoveryCredential: full.recoveryKey === incremental.recoveryKey,
      restoredFull: restoredFull.records[0]
    };
  });
  expect(result.type).toBe('incremental');
  expect(result.parent).toBeTruthy();
  expect(result.restored.changes[0].id).toBe('b');
  expect(result.sameRecoveryCredential).toBe(true);
  expect(result.restoredFull).toBe('a');
});


test('数据集密钥材料不能跨数据集复用', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createDatasetKeyMaterial, createEncryptedBackup } = await import('/src/crypto.js');
    const keyMaterial = createDatasetKeyMaterial('dataset-a');
    try {
      await createEncryptedBackup({
        datasetId: 'dataset-b', sequence: 1, payload: { value: 'cross-dataset' }, keyMaterial
      });
      return false;
    } catch { return true; }
  });
  expect(result).toBe(true);
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


test('分块上传中断后可查询缺块并继续，重复上传相同分块幂等', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup, decryptBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    const server = new MockBackupServer();
    const backup = await createEncryptedBackup({
      datasetId: 'resume-upload-fixture', sequence: 1,
      payload: { text: 'resume-'.repeat(30_000) }
    });
    const key = 'resume-idempotency-key';
    server.init(backup.manifest, key);
    server.putPart(backup.manifest.backupId, backup.chunks[0]);
    server.putPart(backup.manifest.backupId, backup.chunks[0]);
    const missingBeforeResume = server.missingParts(backup.manifest.backupId);
    // Re-initializing with the same idempotency key returns the existing session.
    const resumed = server.init(backup.manifest, key);
    for (const chunk of backup.chunks.slice(1)) server.putPart(backup.manifest.backupId, chunk);
    const missingAfterResume = server.missingParts(backup.manifest.backupId);
    const committed = await server.complete(backup.manifest.backupId);
    const remote = server.get(backup.manifest.backupId);
    const restored = await decryptBackup({ ...remote, recoveryKey: backup.recoveryKey });
    return {
      chunkCount: backup.chunks.length, missingBeforeResume, missingAfterResume,
      sameSession: resumed.backupId === backup.manifest.backupId,
      committed: committed.state, restoredLength: restored.text.length
    };
  });
  expect(result.chunkCount).toBeGreaterThan(1);
  expect(result.missingBeforeResume).toEqual(Array.from({ length: result.chunkCount - 1 }, (_, i) => i + 1));
  expect(result.missingAfterResume).toEqual([]);
  expect(result.sameSession).toBe(true);
  expect(result.committed).toBe('committed');
  expect(result.restoredLength).toBe('resume-'.repeat(30_000).length);
});

test('分块重复上传不同密文时拒绝覆盖，缺块时拒绝提交', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    const server = new MockBackupServer();
    const backup = await createEncryptedBackup({
      datasetId: 'conflicting-part-fixture', sequence: 1,
      payload: { text: 'x'.repeat(100_000) }
    });
    server.init(backup.manifest, 'conflict-key');
    server.putPart(backup.manifest.backupId, backup.chunks[0]);
    let conflictingPartRejected = false;
    try {
      const changed = { ...backup.chunks[0], ciphertext: backup.chunks[0].ciphertext.slice(0, -4) + 'AAAA' };
      server.putPart(backup.manifest.backupId, changed);
    } catch { conflictingPartRejected = true; }
    let incompleteCommitRejected = false;
    try { await server.complete(backup.manifest.backupId); }
    catch { incompleteCommitRejected = true; }
    return { conflictingPartRejected, incompleteCommitRejected, missing: server.missingParts(backup.manifest.backupId) };
  });
  expect(result.conflictingPartRejected).toBe(true);
  expect(result.incompleteCommitRejected).toBe(true);
  expect(result.missing.length).toBeGreaterThan(0);
});


test('服务端拒绝 Manifest 分块数量/序号错误与 nonce 重用', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    const backup = await createEncryptedBackup({
      datasetId: 'manifest-validation', sequence: 1,
      payload: { text: 'm'.repeat(150_000) }
    });
    const server = new MockBackupServer();
    const badCount = structuredClone(backup.manifest);
    badCount.chunkCount += 1;
    let countRejected = false;
    try { server.init(badCount, 'bad-count'); } catch { countRejected = true; }
    const badNonce = structuredClone(backup.manifest);
    badNonce.chunks[1].nonce = badNonce.chunks[0].nonce;
    let nonceRejected = false;
    try { server.init(badNonce, 'bad-nonce'); } catch { nonceRejected = true; }
    const badIndex = structuredClone(backup.manifest);
    badIndex.chunks[1].chunkIndex = 9;
    let indexRejected = false;
    try { server.init(badIndex, 'bad-index'); } catch { indexRejected = true; }
    return { countRejected, nonceRejected, indexRejected };
  });
  expect(result).toEqual({ countRejected: true, nonceRejected: true, indexRejected: true });
});

test('上传会话固定 Manifest 快照，不受调用方后续对象修改影响', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    const backup = await createEncryptedBackup({
      datasetId: 'manifest-snapshot', sequence: 1, payload: { value: 'stable' }
    });
    const server = new MockBackupServer();
    const callerManifest = structuredClone(backup.manifest);
    server.init(callerManifest, 'snapshot-key');
    callerManifest.datasetId = 'attacker-changed-dataset';
    for (const chunk of backup.chunks) server.putPart(backup.manifest.backupId, chunk);
    await server.complete(backup.manifest.backupId);
    return server.get(backup.manifest.backupId).manifest.datasetId;
  });
  expect(result).toBe('manifest-snapshot');
});


test('清除墓碑同时清理备份、上传分块与幂等引用', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    const backup = await createEncryptedBackup({
      datasetId: 'tombstone-memory-purge', sequence: 1,
      payload: { text: 'sensitive ciphertext fixture' }
    });
    const server = new MockBackupServer();
    server.init(backup.manifest, 'tombstone-purge-key');
    server.putPart(backup.manifest.backupId, backup.chunks[0]);
    await server.complete(backup.manifest.backupId);
    server.clearDataset('tombstone-memory-purge');
    return {
      tombstone: server.isCleared('tombstone-memory-purge'),
      backups: server.backups.size,
      sessions: server.sessions.size,
      idempotency: server.idempotency.size
    };
  });
  expect(result).toEqual({ tombstone: true, backups: 0, sessions: 0, idempotency: 0 });
});

test('授权范围、过期时间和主动撤销均在上传入口生效', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    let now = 1_000;
    const server = new MockBackupServer({ now: () => now });
    const backup = await createEncryptedBackup({
      datasetId: 'authorization-lifecycle', sequence: 1, payload: { value: 'private' }
    });
    const downloadOnly = server.issueAuthorization(backup.manifest.datasetId, {
      scopes: ['download'], ttlMs: 1_000
    });
    let scopeRejected = false;
    try { server.authorizedInit(downloadOnly.token, backup.manifest, 'scope-key'); }
    catch { scopeRejected = true; }
    const expiring = server.issueAuthorization(backup.manifest.datasetId, {
      scopes: ['upload'], ttlMs: 100
    });
    server.authorizedInit(expiring.token, backup.manifest, 'expiring-key');
    now += 100;
    let expiredRejected = false;
    try { server.authorizedPutPart(expiring.token, backup.manifest.backupId, backup.chunks[0]); }
    catch { expiredRejected = true; }
    const revocable = server.issueAuthorization(backup.manifest.datasetId, {
      scopes: ['upload'], ttlMs: 10_000
    });
    const second = await createEncryptedBackup({
      datasetId: 'authorization-lifecycle', sequence: 1, payload: { value: 'second' }
    });
    server.authorizedInit(revocable.token, second.manifest, 'revocable-key');
    server.revokeAuthorization(revocable.token);
    let revokedRejected = false;
    try { server.authorizedPutPart(revocable.token, second.manifest.backupId, second.chunks[0]); }
    catch { revokedRejected = true; }
    return { scopeRejected, expiredRejected, revokedRejected };
  });
  expect(result).toEqual({ scopeRejected: true, expiredRejected: true, revokedRejected: true });
});

test('下载票据过期与清除墓碑均撤销旧下载能力', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createEncryptedBackup } = await import('/src/crypto.js');
    const { MockBackupServer } = await import('/src/mock-server.js');
    let now = 10_000;
    const server = new MockBackupServer({ now: () => now });
    const backup = await createEncryptedBackup({
      datasetId: 'download-ticket-lifecycle', sequence: 1, payload: { value: 'ticket-fixture' }
    });
    const authorization = server.issueAuthorization(backup.manifest.datasetId, {
      scopes: ['upload', 'download'], ttlMs: 10_000
    });
    server.authorizedInit(authorization.token, backup.manifest, 'ticket-upload');
    for (const chunk of backup.chunks) {
      server.authorizedPutPart(authorization.token, backup.manifest.backupId, chunk);
    }
    await server.authorizedComplete(authorization.token, backup.manifest.backupId);
    const ticket = server.issueDownloadTicket(authorization.token, backup.manifest.backupId, 100);
    const beforeExpiry = server.downloadByTicket(ticket.ticket).manifest.backupId;
    now += 100;
    let expiredTicketRejected = false;
    try { server.downloadByTicket(ticket.ticket); } catch { expiredTicketRejected = true; }
    const freshTicket = server.issueDownloadTicket(authorization.token, backup.manifest.backupId, 1_000);
    server.clearDataset(backup.manifest.datasetId);
    let tombstonedTicketRejected = false;
    try { server.downloadByTicket(freshTicket.ticket); } catch { tombstonedTicketRejected = true; }
    let oldAuthorizationRejected = false;
    try { server.issueDownloadTicket(authorization.token, backup.manifest.backupId); }
    catch { oldAuthorizationRejected = true; }
    return {
      beforeExpiry, expiredTicketRejected, tombstonedTicketRejected,
      oldAuthorizationRejected, remainingTickets: server.downloadTickets.size,
      remainingAuthorizations: server.authorizations.size
    };
  });
  expect(result.beforeExpiry).toBeTruthy();
  expect(result.expiredTicketRejected).toBe(true);
  expect(result.tombstonedTicketRejected).toBe(true);
  expect(result.oldAuthorizationRejected).toBe(true);
  expect(result.remainingTickets).toBe(0);
  expect(result.remainingAuthorizations).toBe(0);
});
