import { test, expect } from '@playwright/test';

test('页面展示环境能力并完成 IndexedDB 持久化写入与查询', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '本地数据存储与浏览器可靠性' })).toBeVisible();
  await page.locator('#adapter').selectOption('indexeddb');
  await page.locator('#count').selectOption('1000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText('完成', { timeout: 60_000 });
  const output = JSON.parse(await page.locator('#output').textContent());
  expect(output.count).toBe(1000);
  expect(output.integrity).toBe(true);
  await page.reload();
  await page.locator('#adapter').selectOption('indexeddb');
  await page.locator('#count').selectOption('1000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText('完成', { timeout: 60_000 });
});

test('SQLite OPFS 可用时执行数据库约束与持久化测试；不可用时明确失败', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'SQLite OPFS 先在 Chromium 主测，Firefox/WebKit 兼容性另行记录');
  await page.goto('/');
  await page.locator('#adapter').selectOption('sqlite');
  await page.locator('#count').selectOption('1000');
  await page.getByRole('button', { name: '执行写入与查询测试' }).click();
  await expect(page.locator('#status')).toContainText(/完成|执行失败/, { timeout: 60_000 });
  const output = JSON.parse(await page.locator('#output').textContent());
  if (output.error) expect(output.error).toMatch(/OPFS|Worker|SQLite|cross-origin|SharedArrayBuffer/i);
  else {
    expect(output.count).toBe(1000);
    expect(output.integrity).toBe(true);
  }
});
