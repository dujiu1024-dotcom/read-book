import { test, expect } from '@playwright/test';

test('用户消息先落本地，最终结果确认后才写入 Assistant Message', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#status')).toContainText('生成完成', { timeout: 20_000 });
  await expect(page.locator('#messages')).toContainText('user');
  await expect(page.locator('#messages')).toContainText('assistant');
  await expect(page.locator('#messages')).toContainText('这是一条模拟生成结果。');
});

test('客户端断线并刷新后，可恢复服务端最终结果', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#stream')).toContainText('这是', { timeout: 10_000 });
  await page.getByRole('button', { name: '断开流连接' }).click();
  await page.reload();
  await expect(page.locator('#status')).toContainText('生成完成', { timeout: 20_000 });
  await expect(page.locator('#messages')).toContainText('assistant');
});

test('重复提交相同幂等键返回同一 generation_id', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#stream')).toContainText('这是', { timeout: 10_000 });
  await page.getByRole('button', { name: '重复提交同一请求' }).click();
  await expect(page.locator('#status')).toContainText('幂等验证通过');
});

test('取消任务后不生成正式 Assistant Message', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#stream')).toContainText('这是', { timeout: 10_000 });
  await page.getByRole('button', { name: '取消生成' }).click();
  await expect(page.locator('#status')).toContainText('生成已取消');
  await expect(page.locator('#messages')).not.toContainText('assistant');
});
