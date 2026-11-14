import './style.css';
import { getFixture } from './fixtures.js';
import { parseBook } from './parsers.js';
import { buildBookPackage } from './package-export.js';
import { saveBook, getBook, listBooks } from './storage.js';

const $ = (id) => document.getElementById(id);
let current = null;
let citations = [];
const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join('');
function show(value) { $('output').textContent = JSON.stringify(value, null, 2); }
function setCitations(parsed) {
  citations = buildCitations(parsed);
  const select = $('citation');
  select.replaceChildren();
  for (const [index, item] of citations.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = item.label + ' · ' + item.locator;
    select.append(option);
  }
}
function buildCitations(parsed) {
  if (parsed.format === 'EPUB') return parsed.chapters.map((chapter, index) => ({ label: chapter.title, locator: chapter.sampleCfi || chapter.href, text: chapter.text.slice(0, 180), detail: chapter.href }));
  if (parsed.format === 'PDF') return parsed.pages.map((page) => ({ label: '物理页 ' + page.physicalPage, locator: 'pdf:page:' + page.physicalPage, text: page.text.slice(0, 180), detail: page.physicalPage }));
  return parsed.paragraphs.map((paragraph, index) => ({ label: '段落 ' + (index + 1), locator: 'txt:offset:' + paragraph.startOffset, text: paragraph.text.slice(0, 180), detail: paragraph }));
}
async function importFile(file) {
  $('status').textContent = '正在解析 ' + file.name + ' …';
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = await parseBook(file.name, bytes);
  const id = await digest(bytes);
  current = { id, name: file.name, type: file.type, bytes: bytes.buffer, parsed, importedAt: new Date().toISOString() };
  $('book-title').value = parsed.title || file.name.replace(/\.[^.]+$/, '');
  $('book-author').value = Array.isArray(parsed.author) ? parsed.author.join('、') : (parsed.author || '');
  $('book-language').value = parsed.language || 'zh-CN';
  $('export-package').disabled = false;
  await saveBook(current);
  setCitations(parsed);
  show({ id, name: file.name, size: bytes.length, parsed, citationCount: citations.length });
  $('status').textContent = '导入成功，文件与解析结果已保存到 IndexedDB。';
  $('export-package').addEventListener('click', async () => {
  if (!current) return;
  try {
    $('status').textContent = '正在生成标准书籍包…';
    const result = await buildBookPackage({
      fileName: current.name,
      sourceBytes: new Uint8Array(current.bytes),
      parsed: current.parsed,
      metadata: {
        title: $('book-title').value,
        author: $('book-author').value,
        language: $('book-language').value,
        isbn: $('book-isbn').value,
        edition: $('book-edition').value,
        translator: $('book-translator').value,
        publisher: $('book-publisher').value
      }
    });
    const blob = new Blob([result.archive], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = (result.manifest.book.title.replace(/[\\/:*?"<>|]/g, '_') || 'book') + '.read-book.zip';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('status').textContent = '标准书籍包已生成：' + result.manifest.counts.chapters + ' 个章节、' + result.manifest.counts.chunks + ' 个正文切片。可使用 packages/book-package-validator 校验。';
    show({ manifest: result.manifest, archiveBytes: result.archive.byteLength });
  } catch (error) {
    $('status').textContent = '标准书籍包生成失败：' + error.message;
    show({ error: error.message });
  }
});
await renderSaved();
}
async function openSavedBook(id) {
  const book = await getBook(id);
  if (!book) throw new Error('本地书籍记录不存在');
  current = book;
  setCitations(book.parsed);
  show({
    id: book.id, name: book.name, size: book.bytes?.byteLength ?? 0,
    parsed: book.parsed, citationCount: citations.length, restoredFromIndexedDB: true
  });
  $('status').textContent = '已从 IndexedDB 恢复原文件、解析结果和定位信息。';
}
async function renderSaved() {
  const books = await listBooks();
  const list = $('saved-books');
  list.replaceChildren();
  for (const book of books) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = book.name + ' · ' + book.id.slice(0, 12) + ' · ' + book.parsed.format;
    button.addEventListener('click', async () => {
      try { await openSavedBook(book.id); }
      catch (error) { $('status').textContent = '本地恢复失败：' + error.message; }
    });
    item.append(button);
    list.append(item);
  }
}
$('import-fixture').addEventListener('click', async () => {
  try { const fixture = getFixture($('fixture').value); await importFile(new File([fixture.bytes], fixture.name, { type: fixture.type })); }
  catch (error) { $('status').textContent = '导入失败：' + error.message; show({ error: error.message, stack: error.stack }); }
});
$('file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file) { try { await importFile(file); } catch (error) { $('status').textContent = '导入失败：' + error.message; show({ error: error.message }); } }
});
function resolveCitationSource(citation) {
  if (!current || !citation) return { unit: null, text: '' };
  if (current.parsed.format === 'EPUB') {
    const chapter = current.parsed.chapters.find((item) => item.href === citation.detail);
    return { unit: chapter ? chapter.title : citation.detail, text: chapter?.text || '' };
  }
  if (current.parsed.format === 'PDF') {
    const page = current.parsed.pages.find((item) => item.physicalPage === citation.detail);
    return {
      unit: page ? '物理页 ' + page.physicalPage + (page.printedPage ? '（印刷页 ' + page.printedPage + '）' : '') : citation.detail,
      text: page?.text || ''
    };
  }
  return { unit: 'TXT 字符偏移 ' + citation.detail.startOffset, text: citation.detail.text || '' };
}
$('jump').addEventListener('click', () => {
  const citation = citations[Number($('citation').value)];
  if (!citation) return;
  const source = resolveCitationSource(citation);
  $('source').textContent = [
    '定位记录：' + citation.locator,
    '原文位置：' + source.unit,
    '引用片段：' + citation.text,
    '',
    '所在原文单元：',
    source.text
  ].join('\n');
});
await renderSaved();
