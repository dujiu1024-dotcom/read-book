import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';


function citationsText(result) {
  if (result.parsed.format === 'EPUB') return result.parsed.chapters[0].text.slice(0, 40);
  if (result.parsed.format === 'PDF') return result.parsed.pages[0].text.slice(0, 40);
  return result.parsed.paragraphs[0].text.slice(0, 40);
}

const fixtureHashes = JSON.parse(readFileSync(new URL('../fixtures.sha256.json', import.meta.url), 'utf8'));

for (const fixture of ['epub-1', 'epub-2', 'epub-3', 'pdf-1', 'pdf-2', 'pdf-3', 'txt-1', 'txt-2', 'txt-3']) {
  test('解析固定样本 ' + fixture + ' 并生成定位', async ({ page }) => {
    await page.goto('/');
    await page.locator('#fixture').selectOption(fixture);
    await page.getByRole('button', { name: '导入固定样本' }).click();
    await expect(page.locator('#status')).toContainText('导入成功', { timeout: 20_000 });
    const result = JSON.parse(await page.locator('#output').textContent());
    expect(result.id).toMatch(/^[a-f0-9]{64}$/);
    console.log('fixture SHA-256:', fixture, result.id);
    expect(result.id).toBe(fixtureHashes[fixture]);
    expect(result.citationCount).toBeGreaterThan(0);
    if (result.parsed.format === 'EPUB') {
      expect(result.parsed.chapterCount).toBeGreaterThan(0);
      expect(result.parsed.chapters.some((chapter) => chapter.text.length > 0)).toBe(true);
    }
    if (result.parsed.format === 'PDF') {
      expect(result.parsed.pageCount).toBeGreaterThan(0);
      expect(result.parsed.pages.every((pdfPage) => pdfPage.text.length > 0)).toBe(true);
    }
    if (result.parsed.format === 'TXT') {
      expect(result.parsed.paragraphCount).toBeGreaterThan(0);
      expect(result.parsed.paragraphs.every((paragraph) => paragraph.endOffset > paragraph.startOffset)).toBe(true);
    }
    if (fixture === 'epub-3') {
      expect(result.parsed.chapters[0].sampleCfi).toContain('epubcfi(');
      expect(result.parsed.chapters[0].images[0].alt).toBe('示意图片');
      expect(result.parsed.chapters[0].footnotes.length).toBeGreaterThan(0);
    }
    if (fixture === 'pdf-2') {
      const text = result.parsed.pages[0].text;
      expect(result.parsed.pages[0].columnCount).toBe(2);
      expect(text.indexOf('Left column text')).toBeLessThan(text.indexOf('Left column second line'));
      expect(text.indexOf('Left column third line')).toBeLessThan(text.indexOf('Right column text'));
      expect(text.indexOf('Right column text')).toBeLessThan(text.indexOf('Right column third line'));
      expect(result.parsed.pages[0].textItems[0].x).toBeLessThan(result.parsed.pages[0].textItems.at(-1).x);
    }
    if (fixture === 'pdf-3') {
      console.log('pdf-3 page diagnostics:', JSON.stringify(result.parsed.pages.map((item) => ({ height: item.viewport?.[3], printedPage: item.printedPage, textItems: item.textItems }))));
      expect(result.parsed.repeatedEdgeText).toContain('Header - Sample Book');
      expect(result.parsed.repeatedEdgeText).toContain('Footer - Sample Book');
      expect(result.parsed.pages[0].printedPage).toBe(1);
      expect(result.parsed.pages[1].printedPage).toBe(2);
      expect(result.parsed.pages[0].text).not.toContain('Header - Sample Book');
      expect(result.parsed.pages[0].text).not.toContain('Footer - Sample Book');
    }
    if (fixture === 'txt-3') {
      expect(result.parsed.encoding).toBe('gb18030');
      expect(result.parsed.paragraphs[0].text).toContain('中文字符');
    }
    await page.getByRole('button', { name: '定位到原文' }).click();
    await expect(page.locator('#source')).toContainText('定位记录');
    await expect(page.locator('#source')).toContainText('引用片段');
    await expect(page.locator('#source')).toContainText('所在原文单元');
    expect(await page.locator('#source').textContent()).toContain(citationsText(result));
    await page.reload();
    await expect(page.locator('#saved-books')).toContainText(fixture);
    await page.getByRole('button', { name: new RegExp(fixture) }).click();
    await expect(page.locator('#status')).toContainText('已从 IndexedDB 恢复');
    const restored = JSON.parse(await page.locator('#output').textContent());
    expect(restored.restoredFromIndexedDB).toBe(true);
    expect(restored.citationCount).toBe(result.citationCount);
    await page.getByRole('button', { name: '定位到原文' }).click();
    await expect(page.locator('#source')).toContainText('定位记录');
  });
}


test('损坏 EPUB/PDF 导入失败且不写入本地书库', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({
    name: 'broken.epub', mimeType: 'application/epub+zip',
    buffer: Buffer.from('this is not a valid ZIP or EPUB package')
  });
  await expect(page.locator('#status')).toContainText('导入失败', { timeout: 20_000 });
  await expect(page.locator('#saved-books')).not.toContainText('broken.epub');

  await page.locator('#file').setInputFiles({
    name: 'broken.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('this is not a PDF file')
  });
  await expect(page.locator('#status')).toContainText('导入失败', { timeout: 20_000 });
  await expect(page.locator('#saved-books')).not.toContainText('broken.pdf');
});

test('不支持的文件格式明确失败且不污染本地书库', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({
    name: 'unsupported.mobi', mimeType: 'application/octet-stream',
    buffer: Buffer.from('fixture')
  });
  await expect(page.locator('#status')).toContainText('暂不支持该文件格式');
  await expect(page.locator('#saved-books')).not.toContainText('unsupported.mobi');
});

test('TXT 段落定位偏移与去除首尾空白后的原文完全一致', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { parseBook } = await import('/src/parsers.js');
    const source = '  标题段落  \n\n   正文段落包含中文和 emoji 😀  \n\n\t末段  ';
    const parsed = await parseBook('offset-check.txt', new TextEncoder().encode(source));
    return parsed.paragraphs.map((paragraph) => ({
      text: paragraph.text,
      slice: source.slice(paragraph.startOffset, paragraph.endOffset),
      startOffset: paragraph.startOffset,
      endOffset: paragraph.endOffset
    }));
  });
  expect(result.length).toBe(3);
  for (const paragraph of result) expect(paragraph.slice).toBe(paragraph.text);
});



test('从维基文库按上中下三卷导入《传习录》，保留修订来源', async ({ page }) => {
  await page.route('https://zh.wikisource.org/w/api.php**', async (route) => {
    const url = new URL(route.request().url());
    const pageName = url.searchParams.get('page');
    const section = pageName.endsWith('卷01') ? '传习录上' : pageName.endsWith('卷02') ? '传习录中' : '传习录下';
    const body = section + '正文。'.repeat(1600);
    const html = '<div class="mw-parser-output"><div class="mw-heading mw-heading3"><h3>◎' + section + '</h3></div><p>' +
      body + '</p><div class="mw-heading mw-heading3"><h3>下一篇</h3></div><p>不应被导入的其他内容。</p></div>';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ parse: { title: pageName, revid: 12345, text: html } })
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '从维基文库导入《传习录》原文' }).click();
  await expect(page.locator('#status')).toContainText('导入成功', { timeout: 20_000 });
  await expect(page.locator('#batch-status')).toContainText('传习录');
  const result = JSON.parse(await page.locator('#output').textContent());
  expect(result.source.sourceRecords).toHaveLength(3);
  expect(result.source.sourceRecords.every((item) => item.revid === 12345)).toBe(true);
  expect(result.sections.map((item) => item.title)).toEqual(['《传习录》上卷', '《传习录》中卷', '《传习录》下卷']);
  expect(result.characters).toBeGreaterThan(10_000);
  expect(result.sections.every((item) => !item.source.url.includes('undefined'))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('不应被导入的其他内容');
});

test('六本指定书籍可一次批量导入并分别识别，不合并书目', async ({ page }) => {
  await page.goto('/');
  const titles = [
    ['传习录.txt', 'chuanxilu'],
    ...[1, 2, 3, 4, 5].map((volume) => ['毛泽东选集-第' + volume + '卷.txt', 'maoxuan-' + volume])
  ];
  await page.locator('#file').setInputFiles(titles.map(([name]) => ({
    name, mimeType: 'text/plain', buffer: Buffer.from('第一段原文内容\\n\\n第二段原文内容，包含足够的书籍文本。')
  })));
  await expect(page.locator('#batch-status')).toContainText('成功 6 本', { timeout: 20_000 });
  const report = JSON.parse(await page.locator('#output').textContent());
  expect(report.outcomes).toHaveLength(6);
  expect(report.outcomes.map((item) => item.corpusKey)).toEqual(titles.map((item) => item[1]));
  expect(report.missingCorpusKeys).toEqual([]);
  await expect(page.locator('#saved-books').locator('li')).toHaveCount(6);
});
