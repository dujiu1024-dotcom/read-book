import { test, expect, chromium } from '@playwright/test';

test('IndexedDB 写入后刷新页面，仍可读取同一数据集', async ({ page }) => {
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  await expect(page.getByRole('heading', { name: '本地数据存储与浏览器可靠性' })).toBeVisible();
  console.log('Browser compatibility:', await page.evaluate(() => navigator.userAgent));
  await page.locator('#adapter').selectOption('indexeddb');
  await page.locator('#count').selectOption('1000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText('完成', { timeout: 60_000 });
  const first = JSON.parse(await page.locator('#output').textContent());
  expect(first.count).toBe(1000);
  expect(first.integrity).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '完整性检查' }).click();
  await expect(page.locator('#status')).toContainText('完整性检查通过', { timeout: 60_000 });
  const afterReload = JSON.parse(await page.locator('#output').textContent());
  expect(afterReload.count).toBe(1000);
  expect(afterReload.integrity).toBe(true);
  expect(afterReload.longTextIntegrity).toBe(true);
  const context = page.context();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  const afterClose = await reopened.evaluate(async (datasetId) => {
    const { checkIndexedDb } = await import('/src/indexeddb.js');
    return checkIndexedDb(datasetId);
  }, first.datasetId);
  expect(afterClose.count).toBe(1000);
  expect(afterClose.integrity).toBe(true);
  await reopened.close();
});

test('关闭浏览器进程后重新打开，恢复 IndexedDB 与 SQLite OPFS 数据', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '浏览器进程重启使用 Playwright Chromium 持久化配置目录');
  const userDataDir = testInfo.outputPath('browser-restart-profile');
  const firstContext = await chromium.launchPersistentContext(userDataDir, { headless: true });
  let sqliteSupported = false;
  let sqliteError;
  const datasetIds = {
    indexeddb: 'browser-restart-indexeddb',
    sqlite: 'browser-restart-sqlite'
  };
  try {
    const firstPage = await firstContext.newPage();
    await firstPage.goto('http://127.0.0.1:4173');
    await firstPage.evaluate(async (datasetId) => {
      const { runIndexedDb } = await import('/src/indexeddb.js');
      await runIndexedDb(10, datasetId);
    }, datasetIds.indexeddb);
    const sqlite = await firstPage.evaluate(async (datasetId) => {
      const { runSqlite } = await import('/src/sqlite.js');
      try {
        await runSqlite(10, datasetId);
        return { supported: true };
      } catch (error) { return { supported: false, error: error.message }; }
    }, datasetIds.sqlite);
    sqliteSupported = sqlite.supported;
    sqliteError = sqlite.error;
  } finally {
    await firstContext.close();
  }

  const secondContext = await chromium.launchPersistentContext(userDataDir, { headless: true });
  try {
    const secondPage = await secondContext.newPage();
    await secondPage.goto('http://127.0.0.1:4173');
    const recovered = await secondPage.evaluate(async (ids) => {
      const { checkIndexedDb } = await import('/src/indexeddb.js');
      const indexeddb = await checkIndexedDb(ids.indexeddb);
      let sqlite;
      if (ids.sqliteSupported) {
        const { checkSqlite } = await import('/src/sqlite.js');
        sqlite = await checkSqlite(ids.sqlite);
      }
      return { indexeddb, sqlite };
    }, { ...datasetIds, sqliteSupported });
    expect(recovered.indexeddb.count).toBe(10);
    expect(recovered.indexeddb.integrity).toBe(true);
    if (sqliteSupported) {
      expect(recovered.sqlite.count).toBe(10);
      expect(recovered.sqlite.integrity).toBe(true);
    } else {
      console.log('SQLite OPFS browser-restart probe skipped:', sqliteError);
    }
  } finally {
    await secondContext.close();
  }
});

test('persist() 被拒绝时仍报告状态，不影响 IndexedDB 事务正确性', async ({ page }) => {
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  await page.evaluate(() => {
    Object.defineProperty(navigator.storage, 'persist', {
      configurable: true, value: async () => false
    });
  });
  await page.locator('#adapter').selectOption('indexeddb');
  await page.locator('#count').selectOption('1000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText('完成', { timeout: 60_000 });
  const result = JSON.parse(await page.locator('#output').textContent());
  expect(result.integrity).toBe(true);
  expect(result.storage.persistRequest).toBe('false');
});

test('IndexedDB v1 升级到 v3 后保留原数据并补齐六实体结构', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { runMigrationProbe } = await import('/src/indexeddb.js');
    return runMigrationProbe();
  });
  expect(result.migration).toBe('v1/v3-to-v4');
  expect(result.legacyThreadPreserved).toBe(true);
  expect(result.legacyMessagePreserved).toBe(true);
  expect(result.expectedStores).toBe(true);
  expect(result.expectedIndexes).toBe(true);
  expect(result.integrity).toBe(true);
});

test('批量替换事务中断时回滚，原数据集保持完整', async ({ page }) => {
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  const result = await page.evaluate(async () => {
    const { runIndexedDb, checkIndexedDb } = await import('/src/indexeddb.js');
    await runIndexedDb(1000, 'atomic-replacement-fixture');
    let failure;
    try {
      await runIndexedDb(100000, 'atomic-replacement-fixture', { failureInjection: 'abort-after-clear' });
    } catch (error) { failure = { name: error.name, message: error.message }; }
    return { failure, check: await checkIndexedDb('atomic-replacement-fixture') };
  });
  expect(result.failure).toBeTruthy();
  expect(result.check.count).toBe(1000);
  expect(result.check.integrity).toBe(true);
  expect(result.check.entityCounts).toEqual({
    threads: 10, messages: 1000, readingRounds: 10, notes: 10, memories: 10, sources: 1
  });
});

test('真实浏览器配额不足时中止事务并保留旧数据', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP 配额故障注入仅在 Chromium 系列执行');
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  const session = await page.context().newCDPSession(page);
  const origin = 'http://127.0.0.1:4173';
  try {
    try {
      await session.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 500000 });
    } catch {
      test.skip(true, '当前 Chromium CDP 不支持 Storage.overrideQuotaForOrigin');
    }
    const result = await page.evaluate(async () => {
      const { runIndexedDb, checkIndexedDb } = await import('/src/indexeddb.js');
      await runIndexedDb(10, 'quota-rollback-fixture');
      let failure;
      try { await runIndexedDb(10000, 'quota-rollback-fixture'); }
      catch (error) { failure = { name: error.name, message: error.message }; }
      return { failure, check: await checkIndexedDb('quota-rollback-fixture') };
    });
    expect(result.failure).toBeTruthy();
    expect(result.failure.name).toMatch(/QuotaExceededError|AbortError/);
    expect(result.check.count).toBe(10);
    expect(result.check.integrity).toBe(true);
  } finally {
    await session.send('Storage.resetQuotaForOrigin', { origin }).catch(() => {});
    await session.detach();
  }
});

test('清理站点数据后 IndexedDB 不残留原数据', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', '站点数据清理通过 Chromium CDP 验证');
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  const datasetId = 'site-data-clear-fixture';
  await page.evaluate(async (id) => {
    const { runIndexedDb } = await import('/src/indexeddb.js');
    await runIndexedDb(10, id);
  }, datasetId);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Storage.clearDataForOrigin', {
      origin: 'http://127.0.0.1:4173', storageTypes: 'all'
    });
    await page.reload();
    const result = await page.evaluate(async (id) => {
      const { checkIndexedDb } = await import('/src/indexeddb.js');
      return checkIndexedDb(id);
    }, datasetId);
    expect(result.count).toBe(0);
    expect(result.entityCounts).toEqual({
      threads: 0, messages: 0, readingRounds: 0, notes: 0, memories: 0, sources: 0
    });
  } finally {
    await session.detach();
  }
});

test('IndexedDB 检测缺失的关联记录，不静默修复或误报完整', async ({ page }) => {
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  const result = await page.evaluate(async () => {
    const { runIndexedDb, checkIndexedDb } = await import('/src/indexeddb.js');
    const datasetId = 'indexeddb-corruption-fixture';
    await runIndexedDb(10, datasetId);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('read-book-poc-a', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('memories', 'readwrite');
      tx.objectStore('memories').delete(datasetId + ':memory:0');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('损坏样本注入事务中止'));
    });
    db.close();
    return checkIndexedDb(datasetId);
  });
  expect(result.integrity).toBe(false);
  expect(result.relatedThreadCount).toBe(9);
  expect(result.entityCounts.memories).toBe(9);
});

test('Web Locks 不可用时 fail-closed，不能创建或写入数据集', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
  const outcome = await page.evaluate(async () => {
    const { runIndexedDb, checkIndexedDb } = await import('/src/indexeddb.js');
    let error;
    try { await runIndexedDb(10, 'no-lock-must-not-write'); }
    catch (caught) { error = caught.message; }
    const check = await checkIndexedDb('no-lock-must-not-write');
    return { error, check };
  });
  expect(outcome.error).toContain('已阻止写入并降级只读');
  expect(outcome.check.count).toBe(0);
  expect(outcome.check.entityCounts).toEqual({
    threads: 0, messages: 0, readingRounds: 0, notes: 0, memories: 0, sources: 0
  });
});

test('SQLite OPFS 可用时执行写入与刷新恢复；不可用时明确失败', async ({ page, browserName }) => {
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  test.skip(browserName !== 'chromium', 'SQLite OPFS 先在 Chromium 主测，Firefox/WebKit 兼容性另行记录');
  await page.locator('#adapter').selectOption('sqlite');
  await page.locator('#count').selectOption('1000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText(/完成|执行失败/, { timeout: 60_000 });
  const output = JSON.parse(await page.locator('#output').textContent());
  if (output.error) {
    expect(output.error).toMatch(/OPFS|Worker|SQLite|cross-origin|SharedArrayBuffer/i);
  } else {
    expect(output.count).toBe(1000);
    expect(output.integrity).toBe(true);
    expect(output.longTextIntegrity).toBe(true);
    const constraints = await page.evaluate(async (datasetId) => {
      const { checkSqliteConstraints } = await import('/src/sqlite.js');
      return checkSqliteConstraints(datasetId);
    }, output.datasetId);
    expect(constraints.integrity).toBe(true);
    expect(Object.values(constraints.rejected).every(Boolean)).toBe(true);
    await page.evaluate(async () => {
      const { terminateSqliteWorkerForTest } = await import('/src/sqlite.js');
      terminateSqliteWorkerForTest();
    });
    const recovered = await page.evaluate(async (datasetId) => {
      const { checkSqlite } = await import('/src/sqlite.js');
      return checkSqlite(datasetId);
    }, output.datasetId);
    expect(recovered.count).toBe(1000);
    expect(recovered.integrity).toBe(true);
    expect(recovered.longTextIntegrity).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: '完整性检查' }).click();
    await expect(page.locator('#status')).toContainText('完整性检查通过', { timeout: 60_000 });
  }
});

test('IndexedDB 1k 消息基准输出 P50/P95 与完整关系校验', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '1k 性能基准仅在 Playwright Chromium 主测');
  test.setTimeout(120_000);
  await page.goto('/');
  await page.locator('#adapter').selectOption('indexeddb');
  await page.locator('#count').selectOption('1000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText('完成', { timeout: 100_000 });
  const result = JSON.parse(await page.locator('#output').textContent());
  console.log('IndexedDB 1k benchmark:', JSON.stringify({
    writeMs: result.writeMs, queryMs: result.queryMs, relationQueryMs: result.relationQueryMs,
    memory: result.memory, storage: result.storage
  }));
  expect(result.count).toBe(1000);
  expect(result.integrity).toBe(true);
  expect(result.longTextIntegrity).toBe(true);
  expect(result.runs).toBe(5);
  expect(result.relatedThreadCount).toBe(10);
});

test('IndexedDB 10k 消息基准输出 P50/P95 与完整关系校验', async ({ page, browserName }, testInfo) => {
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  test.skip(testInfo.project.name !== 'chromium', '10k 性能基准仅在 Playwright Chromium 主测');
  test.setTimeout(180_000);
  await page.locator('#adapter').selectOption('indexeddb');
  await page.locator('#count').selectOption('10000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText('完成', { timeout: 160_000 });
  const result = JSON.parse(await page.locator('#output').textContent());
  console.log('IndexedDB 10k benchmark:', JSON.stringify({
    writeMs: result.writeMs, queryMs: result.queryMs, relationQueryMs: result.relationQueryMs,
    memory: result.memory, storage: result.storage
  }));
  expect(result.count).toBe(10000);
  expect(result.integrity).toBe(true);
  expect(result.longTextIntegrity).toBe(true);
  expect(result.runs).toBe(5);
  expect(result.relatedThreadCount).toBe(10);
});

test('IndexedDB 100k 消息基准输出多轮 P50/P95 与 Thread 关联查询', async ({ page, browserName }, testInfo) => {
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  test.skip(testInfo.project.name !== 'chromium', '100k 性能基准仅在 Playwright Chromium 主测，避免 Chrome/Edge 稳定版重复压测');
  test.setTimeout(300_000);
  await page.locator('#adapter').selectOption('indexeddb');
  await page.locator('#count').selectOption('100000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText(/完成|执行失败/, { timeout: 280_000 });
  const result = JSON.parse(await page.locator('#output').textContent());
  expect(result.error, JSON.stringify(result)).toBeUndefined();
  console.log('IndexedDB 100k benchmark:', JSON.stringify({
    writeMs: result.writeMs, queryMs: result.queryMs,
    relationQueryMs: result.relationQueryMs, memory: result.memory,
    storage: result.storage, writerCoordination: result.writerCoordination
  }));
  expect(result.count).toBe(100000);
  expect(result.integrity).toBe(true);
  expect(result.runs).toBe(5);
  expect(result.writeMs.samples).toHaveLength(5);
  expect(result.queryMs.p50).toBeGreaterThan(0);
  expect(result.queryMs.p95).toBeGreaterThanOrEqual(result.queryMs.p50);
  expect(result.relationCount).toBe(10000);
  expect(result.relatedThreadCount).toBe(10);
  expect(result.relationQueryMs.p95).toBeGreaterThan(0);
});

test('SQLite OPFS 1k 消息基准输出 P50/P95 与完整关系校验', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'SQLite OPFS 1k 性能基准仅在 Playwright Chromium 主测');
  test.setTimeout(120_000);
  await page.goto('/');
  const capability = await page.evaluate(async () => {
    const { runSqlite } = await import('/src/sqlite.js');
    try { await runSqlite(1, 'sqlite-opfs-1k-capability'); return { supported: true }; }
    catch (error) { return { supported: false, error: error.message }; }
  });
  test.skip(!capability.supported, 'SQLite OPFS VFS 不可用：' + capability.error);
  await page.locator('#adapter').selectOption('sqlite');
  await page.locator('#count').selectOption('1000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText('完成', { timeout: 100_000 });
  const result = JSON.parse(await page.locator('#output').textContent());
  console.log('SQLite OPFS 1k benchmark:', JSON.stringify({
    writeMs: result.writeMs, queryMs: result.queryMs, relationQueryMs: result.relationQueryMs,
    memory: result.memory, storage: result.storage
  }));
  expect(result.count).toBe(1000);
  expect(result.integrity).toBe(true);
  expect(result.longTextIntegrity).toBe(true);
  expect(result.runs).toBe(5);
  expect(result.relatedThreadCount).toBe(10);
});

test('SQLite OPFS 10k 消息基准输出 P50/P95 与完整关系校验', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'SQLite OPFS 10k 性能基准仅在 Playwright Chromium 主测');
  test.setTimeout(180_000);
  await page.goto('/');
  const capability = await page.evaluate(async () => {
    const { runSqlite } = await import('/src/sqlite.js');
    try { await runSqlite(1, 'sqlite-opfs-10k-capability'); return { supported: true }; }
    catch (error) { return { supported: false, error: error.message }; }
  });
  test.skip(!capability.supported, 'SQLite OPFS VFS 不可用：' + capability.error);
  await page.locator('#adapter').selectOption('sqlite');
  await page.locator('#count').selectOption('10000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText('完成', { timeout: 160_000 });
  const result = JSON.parse(await page.locator('#output').textContent());
  console.log('SQLite OPFS 10k benchmark:', JSON.stringify({
    writeMs: result.writeMs, queryMs: result.queryMs, relationQueryMs: result.relationQueryMs,
    memory: result.memory, storage: result.storage
  }));
  expect(result.count).toBe(10000);
  expect(result.integrity).toBe(true);
  expect(result.longTextIntegrity).toBe(true);
  expect(result.runs).toBe(5);
  expect(result.relatedThreadCount).toBe(10);
});

test('SQLite OPFS 100k 消息基准输出多轮 P50/P95 与 JOIN 查询', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'SQLite OPFS 100k 性能基准仅在 Playwright Chromium 主测，稳定版 Chrome/Edge 只执行 1k 兼容验证');
  test.setTimeout(300_000);
  await page.goto('/');
  const capability = await page.evaluate(async () => {
    const { runSqlite } = await import('/src/sqlite.js');
    try {
      await runSqlite(1, 'sqlite-opfs-capability-probe');
      return { supported: true };
    } catch (error) { return { supported: false, error: error.message }; }
  });
  test.skip(!capability.supported, '当前 CI Worker 未暴露 SQLite OPFS VFS：' + capability.error);
  await page.locator('#adapter').selectOption('sqlite');
  await page.locator('#count').selectOption('100000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText(/完成|执行失败/, { timeout: 280_000 });
  const result = JSON.parse(await page.locator('#output').textContent());
  expect(result.error, JSON.stringify(result)).toBeUndefined();
  console.log('SQLite OPFS 100k benchmark:', JSON.stringify({
    writeMs: result.writeMs, queryMs: result.queryMs,
    relationQueryMs: result.relationQueryMs, memory: result.memory,
    storage: result.storage, writerCoordination: result.writerCoordination
  }));
  expect(result.count).toBe(100000);
  expect(result.integrity).toBe(true);
  expect(result.longTextIntegrity).toBe(true);
  expect(result.runs).toBe(5);
  expect(result.writeMs.samples).toHaveLength(5);
  expect(result.queryMs.p50).toBeGreaterThan(0);
  expect(result.queryMs.p95).toBeGreaterThanOrEqual(result.queryMs.p50);
  expect(result.relationCount).toBe(10000);
  expect(result.relatedThreadCount).toBe(10);
  expect(result.relationQueryMs.p95).toBeGreaterThan(0);
});

test('SQLite OPFS 检测缺失的关系记录，不静默修复或误报完整', async ({ page }, testInfo) => {
  test.skip(!['chromium', 'chrome-stable', 'edge-stable'].includes(testInfo.project.name),
    'SQLite OPFS 损坏检测仅在 Chromium 系列执行');
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  const result = await page.evaluate(async () => {
    const { runSqlite, corruptSqliteDatasetForTest } = await import('/src/sqlite.js');
    const datasetId = 'sqlite-corruption-fixture';
    try { await runSqlite(10, datasetId); }
    catch (error) { return { supported: false, error: error.message }; }
    return { supported: true, check: await corruptSqliteDatasetForTest(datasetId) };
  });
  test.skip(!result.supported, 'SQLite OPFS VFS 不可用：' + result.error);
  expect(result.check.integrity).toBe(false);
  expect(result.check.relatedThreadCount).toBe(9);
  expect(result.check.relationCount).toBe(9);
});

test('SQLite OPFS 多标签页串行打开同一数据库并受 Web Locks 写入协调', async ({ page }, testInfo) => {
  test.skip(!['chromium', 'chrome-stable', 'edge-stable'].includes(testInfo.project.name),
    'SQLite OPFS 多标签页主测在 Chromium 系列');
  await page.goto('/');
  const lockSupported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!lockSupported, '缺少 Web Locks 时必须只读，不执行写入测试');
  const capability = await page.evaluate(async () => {
    const { runSqlite } = await import('/src/sqlite.js');
    try { await runSqlite(1, 'sqlite-multitab-capability'); return { supported: true }; }
    catch (error) { return { supported: false, error: error.message }; }
  });
  test.skip(!capability.supported, 'SQLite OPFS VFS 不可用：' + capability.error);
  const second = await page.context().newPage();
  await second.goto('/');
  const firstResult = await page.evaluate(async () => {
    const { runSqlite } = await import('/src/sqlite.js');
    return runSqlite(10, 'sqlite-multitab-shared-dataset');
  });
  const secondResult = await second.evaluate(async () => {
    const { runSqlite } = await import('/src/sqlite.js');
    return runSqlite(10, 'sqlite-multitab-shared-dataset');
  });
  expect(firstResult.count).toBe(10);
  expect(secondResult.count).toBe(10);
  expect(secondResult.integrity).toBe(true);
  await second.close();
});

test('多标签页通过 Web Locks 单写者与只读降级，并支持锁交接', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Web Locks 跨标签页主测在 Chromium');
  await page.goto('/');
  const supported = await page.evaluate(() => Boolean(navigator.locks?.request));
  test.skip(!supported, '当前浏览器未提供 Web Locks API');
  const firstMode = await page.evaluate(async () => {
    const { acquireDatasetWriter } = await import('/src/coordination.js');
    window.firstWriter = await acquireDatasetWriter('lock-handoff-fixture');
    return window.firstWriter.mode;
  });
  expect(firstMode).toBe('writer');

  const second = await page.context().newPage();
  await second.goto('/');
  const blockedMode = await second.evaluate(async () => {
    const { acquireDatasetWriter } = await import('/src/coordination.js');
    window.blockedWriter = await acquireDatasetWriter('lock-handoff-fixture');
    return window.blockedWriter.mode;
  });
  expect(blockedMode).toBe('readonly');
  const blockedWrite = await second.evaluate(async () => {
    const { runIndexedDb } = await import('/src/indexeddb.js');
    try {
      await runIndexedDb(10, 'lock-handoff-fixture');
      return { rejected: false };
    } catch (error) { return { rejected: true, message: error.message }; }
  });
  expect(blockedWrite.rejected).toBe(true);
  expect(blockedWrite.message).toContain('已阻止写入');
  await page.evaluate(() => { window.firstWriter.release(); window.firstWriter.close(); });
  const handedOff = await second.evaluate(async () => {
    window.blockedWriter.close();
    const { runIndexedDb } = await import('/src/indexeddb.js');
    const result = await runIndexedDb(10, 'lock-handoff-fixture');
    return { count: result.count, writerCoordination: result.writerCoordination };
  });
  expect(handedOff.count).toBe(10);
  expect(handedOff.writerCoordination).toBe('web-locks-single-writer');
  await second.close();
});
