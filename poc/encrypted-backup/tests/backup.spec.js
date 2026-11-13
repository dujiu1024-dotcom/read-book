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
