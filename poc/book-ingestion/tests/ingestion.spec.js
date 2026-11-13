import { test, expect } from '@playwright/test';

for (const fixture of ['epub-1', 'epub-2', 'epub-3', 'pdf-1', 'pdf-2', 'pdf-3', 'txt-1', 'txt-2', 'txt-3']) {
  test('解析固定样本 ' + fixture + ' 并生成定位', async ({ page }) => {
    await page.goto('/');
    await page.locator('#fixture').selectOption(fixture);
    await page.getByRole('button', { name: '导入固定样本' }).click();
    await expect(page.locator('#status')).toContainText('导入成功', { timeout: 20_000 });
    const result = JSON.parse(await page.locator('#output').textContent());
    expect(result.id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.citationCount).toBeGreaterThan(0);
    if (fixture === 'epub-3') {
      expect(result.parsed.chapters[0].sampleCfi).toContain('epubcfi(');
      expect(result.parsed.chapters[0].images[0].alt).toBe('示意图片');
      expect(result.parsed.chapters[0].footnotes.length).toBeGreaterThan(0);
    }
    if (fixture === 'pdf-2') {
      const text = result.parsed.pages[0].text;
      expect(text.indexOf('Left column text')).toBeLessThan(text.indexOf('Right column text'));
      expect(result.parsed.pages[0].textItems[0].x).toBeLessThan(result.parsed.pages[0].textItems[1].x);
    }
    if (fixture === 'pdf-3') {
      expect(result.parsed.repeatedEdgeText).toContain('Header - Sample Book');
      expect(result.parsed.repeatedEdgeText).toContain('Footer - Sample Book');
      expect(result.parsed.pages[0].text).not.toContain('Header - Sample Book');
      expect(result.parsed.pages[0].text).not.toContain('Footer - Sample Book');
    }
    if (fixture === 'txt-3') {
      expect(result.parsed.encoding).toBe('gb18030');
      expect(result.parsed.paragraphs[0].text).toContain('中文字符');
    }
    await page.getByRole('button', { name: '定位到原文' }).click();
    await expect(page.locator('#source')).toContainText('locator');
    await page.reload();
    await expect(page.locator('#saved-books')).toContainText(fixture);
  });
}
