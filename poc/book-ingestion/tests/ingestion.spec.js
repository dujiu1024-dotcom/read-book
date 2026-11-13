import { test, expect } from '@playwright/test';

for (const fixture of ['epub-1', 'epub-2', 'epub-3', 'pdf-1', 'pdf-2', 'pdf-3', 'txt-1', 'txt-2', 'txt-3']) {
  test('解析固定样本 ' + fixture + ' 并生成定位', async ({ page }) => {
    await page.goto('/');
    await page.locator('#fixture').selectOption(fixture);
    await page.getByRole('button', { name: '导入固定样本' }).click();
    await expect(page.locator('#status')).toContainText('导入成功', { timeout: 60_000 });
    const result = JSON.parse(await page.locator('#output').textContent());
    expect(result.id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.citationCount).toBeGreaterThan(0);
    await page.getByRole('button', { name: '定位到原文' }).click();
    await expect(page.locator('#source')).toContainText('locator');
    await page.reload();
    await expect(page.locator('#saved-books')).toContainText(fixture);
  });
}
