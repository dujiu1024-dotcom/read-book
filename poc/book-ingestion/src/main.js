import './style.css';
import { getFixture } from './fixtures.js';
import { parseBook } from './parsers.js';
import { buildBookPackage } from './package-export.js';
import { saveBook, getBook, listBooks } from './storage.js';
import { importChuanxiLuFromWikisource } from './wikisource-provider.js';

const $ = (id) => document.getElementById(id);
let current = null;
let citations = [];
const CORPUS = [
  { key: 'chuanxilu', match: /传习录/i, title: '传习录', author: '王阳明' },
  ...[
    ['1', '一'], ['2', '二'], ['3', '三'], ['4', '四'], ['5', '五']
  ].map(([arabic, chinese]) => ({
    key: 'maoxuan-' + arabic,
    match: new RegExp('(毛泽东选集|毛选).*(第)?(' + arabic + '|' + chinese + ')(卷)?', 'i'),
    title: '毛泽东选集 第' + arabic + '卷',
    author: '毛泽东'
  }))
];
const EXPECTED_KEYS = CORPUS.map((item) => item.key);
const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map((v) => v.toString(16).padStart(2, '0')).join('');

function identifyBook(fileName, parsed) {
  const entry = CORPUS.find((item) => item.match.test(fileName));
  return {
    corpusKey: entry?.key || null,
    title: entry?.title || parsed.title || fileName.replace(/\.[^.]+$/, ''),
    author: entry?.author || (Array.isArray(parsed.author) ? parsed.author.join('、') : (parsed.author || '')),
    language: parsed.language || 'zh-CN'
  };
}

function show(value) { $('output').textContent = JSON.stringify(value, null, 2); }

function buildCitations(parsed) {
  if (parsed.format === 'EPUB') return parsed.chapters.map((chapter) => ({
    label: chapter.title, locator: chapter.sampleCfi || chapter.href,
    text: chapter.text.slice(0, 180), detail: chapter.href
  }));
  if (parsed.format === 'PDF') return parsed.pages.map((page) => ({
    label: '物理页 ' + page.physicalPage, locator: 'pdf:page:' + page.physicalPage,
    text: page.text.slice(0, 180), detail: page.physicalPage
  }));
  return parsed.paragraphs.map((paragraph, index) => ({
    label: '段落 ' + (index + 1), locator: 'txt:offset:' + paragraph.startOffset,
    text: paragraph.text.slice(0, 180), detail: paragraph
  }));
}

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

async function importFile(file, sourceMetadata = null) {
  $('status').textContent = '正在解析 ' + file.name + ' …';
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = await parseBook(file.name, bytes);
  const id = await digest(bytes);
  const metadata = identifyBook(file.name, parsed);
  const book = {
    id, name: file.name, type: file.type, bytes: bytes.buffer, parsed,
    metadata, corpusKey: metadata.corpusKey, sourceMetadata, importedAt: new Date().toISOString()
  };
  await saveBook(book);
  current = book;
  $('book-title').value = metadata.title;
  $('book-author').value = metadata.author;
  $('book-language').value = metadata.language;
  $('batch-status').textContent = sourceMetadata?.completenessNote || '';
  $('export-package').disabled = false;
  setCitations(parsed);
  show({
    id, name: file.name, size: bytes.length, format: parsed.format,
    title: metadata.title, author: metadata.author, corpusKey: metadata.corpusKey,
    unitCount: parsed.chapters?.length || parsed.pages?.length || parsed.paragraphs?.length || 0,
    citationCount: citations.length
  });
  $('status').textContent = '导入成功，文件与解析结果已保存到 IndexedDB。';
  return book;
}

async function openSavedBook(id) {
  const book = await getBook(id);
  if (!book) throw new Error('本地书籍记录不存在');
  current = book;
  const metadata = book.metadata || identifyBook(book.name, book.parsed);
  $('book-title').value = metadata.title;
  $('book-author').value = metadata.author;
  $('book-language').value = metadata.language || 'zh-CN';
  $('export-package').disabled = false;
  $('book-isbn').value = metadata.isbn || '';
  $('book-edition').value = metadata.edition || '';
  $('book-translator').value = metadata.translator || '';
  $('book-publisher').value = metadata.publisher || '';
  setCitations(book.parsed);
  show({
    id: book.id, name: book.name, size: book.bytes?.byteLength ?? 0,
    parsed: book.parsed, citationCount: citations.length, restoredFromIndexedDB: true,
    corpusKey: book.corpusKey || metadata.corpusKey || null
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
    button.textContent = (book.metadata?.title || book.name) + ' · ' + book.id.slice(0, 12) + ' · ' + book.parsed.format;
    button.addEventListener('click', async () => {
      try { await openSavedBook(book.id); }
      catch (error) { $('status').textContent = '本地恢复失败：' + error.message; }
    });
    item.append(button);
    list.append(item);
  }
}

$('import-fixture').addEventListener('click', async () => {
  try {
    const fixture = getFixture($('fixture').value);
    await importFile(new File([fixture.bytes], fixture.name, { type: fixture.type }));
    await renderSaved();
  } catch (error) {
    $('status').textContent = '导入失败：' + error.message;
    show({ error: error.message, stack: error.stack });
  }
});


$('import-wikisource').addEventListener('click', async () => {
  const button = $('import-wikisource');
  button.disabled = true;
  try {
    $('status').textContent = '正在从维基文库读取《传习录》上、中、下原文…';
    const result = await importChuanxiLuFromWikisource();
    const file = new File([result.bytes], result.fileName, { type: 'text/plain' });
    const book = await importFile(file, result.sourceMetadata);
    book.sections = result.sections;
    await saveBook(book);
    await renderSaved();
    $('batch-status').textContent = '已导入《传习录》：' + result.sections.map((section) => section.title + ' ' + section.characterCount + ' 字').join('；') + '。请抽样核对版本和正文完整性。';
    show({ title: '传习录', source: result.sourceMetadata, sections: result.sections, parsedUnits: book.parsed.paragraphs.length, characters: book.parsed.characterCount });
  } catch (error) {
    $('status').textContent = '维基文库导入失败：' + error.message;
    show({ error: error.message });
  } finally {
    button.disabled = false;
  }
});

$('file').addEventListener('change', async (event) => {
  const files = [...(event.target.files || [])];
  if (!files.length) return;
  const outcomes = [];
  for (const file of files) {
    try {
      const book = await importFile(file);
      const parsed = book.parsed;
      outcomes.push({
        file: file.name, status: 'imported', title: book.metadata.title,
        corpusKey: book.corpusKey, format: parsed.format, sourceBytes: file.size,
        units: parsed.chapters?.length || parsed.pages?.length || parsed.paragraphs?.length || 0,
        characters: parsed.characterCount || null
      });
    } catch (error) {
      outcomes.push({ file: file.name, status: 'failed', error: error.message });
    }
    await renderSaved();
  }
  const importedKeys = new Set(outcomes.filter((item) => item.status === 'imported').map((item) => item.corpusKey).filter(Boolean));
  const missing = EXPECTED_KEYS.filter((key) => !importedKeys.has(key));
  $('batch-status').textContent =
    '批量导入结束：成功 ' + outcomes.filter((item) => item.status === 'imported').length +
    ' 本，失败 ' + outcomes.filter((item) => item.status === 'failed').length +
    ' 本；本批次尚缺：' + (missing.join('、') || '无') + '。';
  show({ corpus: 'read-book-six-book-validation', outcomes, missingCorpusKeys: missing });
  event.target.value = '';
});

$('export-package').addEventListener('click', async () => {
  if (!current) return;
  try {
    $('status').textContent = '正在生成标准书籍包…';
    const metadata = {
      title: $('book-title').value,
      author: $('book-author').value,
      language: $('book-language').value,
      isbn: $('book-isbn').value,
      edition: $('book-edition').value,
      translator: $('book-translator').value,
      publisher: $('book-publisher').value,
      description: current.sourceMetadata?.attribution || ''
    };
    if (!metadata.title.trim() || !metadata.author.trim()) throw new Error('书名和作者必须核对填写。');
    current.metadata = metadata;
    await saveBook(current);
    const result = await buildBookPackage({
      fileName: current.name, sourceBytes: new Uint8Array(current.bytes),
      parsed: current.parsed, metadata
    });
    const blob = new Blob([result.archive], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = (result.manifest.book.title.replace(/[\\/:*?"<>|]/g, '_') || 'book') + '.read-book.zip';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('status').textContent = '标准书籍包已生成：' + result.manifest.counts.chapters +
      ' 个章节、' + result.manifest.counts.chunks + ' 个正文切片。';
    show({ manifest: result.manifest, archiveBytes: result.archive.byteLength });
  } catch (error) {
    $('status').textContent = '标准书籍包生成失败：' + error.message;
    show({ error: error.message });
  }
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
