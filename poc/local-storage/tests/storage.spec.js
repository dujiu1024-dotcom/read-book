import { test, expect } from '@playwright/test';

test('IndexedDB 写入后刷新页面，仍可读取同一数据集', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '本地数据存储与浏览器可靠性' })).toBeVisible();
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
});

test('SQLite OPFS 可用时执行写入与刷新恢复；不可用时明确失败', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'SQLite OPFS 先在 Chromium 主测，Firefox/WebKit 兼容性另行记录');
  await page.goto('/');
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
    await page.reload();
    await page.getByRole('button', { name: '完整性检查' }).click();
    await expect(page.locator('#status')).toContainText('完整性检查通过', { timeout: 60_000 });
  }
});

test('IndexedDB 100k 消息基准输出多轮 P50/P95 与 Thread 关联查询', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', '100k 性能基准仅在 Chromium 主测，避免兼容矩阵重复压测');
  test.setTimeout(300_000);
  await page.goto('/');
  await page.locator('#adapter').selectOption('indexeddb');
  await page.locator('#count').selectOption('100000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText(/完成|执行失败/, { timeout: 280_000 });
  const result = JSON.parse(await page.locator('#output').textContent());
  expect(result.error, JSON.stringify(result)).toBeUndefined();
  expect(result.count).toBe(100000);
  expect(result.integrity).toBe(true);
  expect(result.runs).toBe(5);
  expect(result.writeMs.samples).toHaveLength(5);
  expect(result.queryMs.p50).toBeGreaterThan(0);
  expect(result.queryMs.p95).toBeGreaterThanOrEqual(result.queryMs.p50);
  expect(result.relationCount).toBe(10000);
  expect(result.relationQueryMs.p95).toBeGreaterThan(0);
});

test('SQLite OPFS 100k 消息基准输出多轮 P50/P95 与 JOIN 查询', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'SQLite OPFS 100k 性能基准仅在 Chromium 主测');
  test.setTimeout(300_000);
  await page.goto('/');
  const capability = await page.evaluate(() => ({
    opfs: Boolean(navigator.storage?.getDirectory),
    isolated: window.crossOriginIsolated
  }));
  test.skip(!capability.opfs || !capability.isolated, '当前运行环境不具备 OPFS/跨源隔离，保留明确失败记录');
  await page.locator('#adapter').selectOption('sqlite');
  await page.locator('#count').selectOption('100000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText('完成', { timeout: 280_000 });
  const result = JSON.parse(await page.locator('#output').textContent());
  expect(result.count).toBe(100000);
  expect(result.integrity).toBe(true);
  expect(result.runs).toBe(5);
  expect(result.writeMs.samples).toHaveLength(5);
  expect(result.queryMs.p50).toBeGreaterThan(0);
  expect(result.queryMs.p95).toBeGreaterThanOrEqual(result.queryMs.p50);
  expect(result.relationCount).toBe(10000);
  expect(result.relationQueryMs.p95).toBeGreaterThan(0);
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
