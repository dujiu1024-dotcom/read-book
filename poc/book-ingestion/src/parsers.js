import ePub from 'epubjs';

/**
 * 回目/章节标题：中文长篇（如章回小说）的正文常常一本文件里装好几回，
 * 只按 spine 文件切会把 3–4 回并成一个巨型单元。这里按标题行切。
 */
const HEADING_PATTERN = /^第[〇零一二三四五六七八九十百千两兩0-9]+[回章节節]/;
const HEADING_MAX_CHARACTERS = 80;
// Project Gutenberg 的版权头/许可证不是正文，不能进单元。
const BOILERPLATE_TEXT = /^(Title|Author|Release date|Language|Credits|Other information and formats|Most recently updated|Produced by|Transcriber|Ebookmaker|The Project Gutenberg|PROJECT GUTENBERG|\*\*\* (START|END) OF)/i;
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'dd', 'dt', 'figure', 'figcaption', 'td']);

function compactText(value) {
  const text = String(value || '');
  // 中文古籍原文在 HTML 里被硬换行，去掉换行空白才是原句；西文保留词间空格。
  return /[\u3400-\u9fff]/.test(text)
    ? text.replace(/\s+/g, '')
    : text.replace(/\s+/g, ' ').trim();
}

function isBoilerplate(node) {
  let current = node;
  while (current && current.nodeType === 1) {
    const id = String(current.getAttribute?.('id') || '');
    const className = String(current.getAttribute?.('class') || '');
    if (/^pg-(header|footer)/.test(id) || /pg-boilerplate/.test(className)) return true;
    current = current.parentNode;
  }
  return false;
}

function isFootnote(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = String(node.tagName || '').toLowerCase();
  const role = node.getAttribute?.('role');
  const type = node.getAttribute?.('epub:type') ||
    node.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type');
  return tag === 'aside' || role === 'doc-footnote' ||
    /^(footnote|endnote|rearnote)$/.test(String(type || ''));
}

/**
 * 按文档顺序收集正文块。脚注与版权页在这里就被排除在正文之外，
 * 脚注文本单独返回，供解析结果展示，不会混进单元正文。
 */
function collectBlocks(document) {
  const blocks = [];
  const visit = (node) => {
    if (!node || node.nodeType !== 1) return;
    const tag = String(node.tagName || '').toLowerCase();
    if (['script', 'style', 'nav', 'svg', 'head'].includes(tag)) return;
    if (isBoilerplate(node)) return;
    if (isFootnote(node)) {
      const text = compactText(node.textContent);
      if (text) blocks.push({ kind: 'footnote', node, text });
      return;
    }
    const hasBlockChild = [...node.children].some((child) =>
      BLOCK_TAGS.has(String(child.tagName || '').toLowerCase()) || isFootnote(child));
    if (BLOCK_TAGS.has(tag) && !hasBlockChild) {
      const text = compactText(node.textContent);
      const titleText = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) blocks.push({ kind: /^h[1-6]$/.test(tag) ? 'heading' : 'text', node, text, titleText });
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(document?.body);
  return blocks;
}

function isChapterHeading(block) {
  if (!block || !block.text) return false;
  if (block.kind === 'heading') return true;
  const text = block.text;
  return text.length <= HEADING_MAX_CHARACTERS && !text.includes('。') && HEADING_PATTERN.test(text);
}

function cfiForBlock(item, node) {
  try {
    const document = node?.ownerDocument;
    if (!document) return null;
    const walker = document.createTreeWalker(node, 4);
    const firstText = walker.nextNode();
    if (!firstText) return null;
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(firstText, Math.min(String(firstText.textContent || '').length, 120));
    return item.cfiFromRange?.(range) || null;
  } catch {
    return null;
  }
}

async function parseEpub(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new Error('EPUB 文件不是有效的 ZIP 容器');
  }
  const book = ePub(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  await book.ready;
  const metadata = await book.loaded.metadata;
  const navigation = await book.loaded.navigation;
  const chapters = [];
  let current = null;
  let pendingFootnotes = [];
  for (const item of book.spine.spineItems) {
    await item.load(book.load.bind(book));
    const document = item.document;
    const blocks = collectBlocks(document);
    const images = [...(document?.querySelectorAll('img') || [])].map((image) => ({
      src: image.getAttribute('src'), alt: image.getAttribute('alt') || ''
    }));
    const fallbackTitle = document?.querySelector('h1,h2')?.textContent?.trim() || item.href;
    // 没有回目/标题的文件本身就是一章（旧行为）：在文件开头强制另起单元。
    let fileStartsChapter = !blocks.some((block) => block.kind !== 'footnote' && isChapterHeading(block));
    let imagesAssigned = false;
    const startChapter = (block) => {
      current = {
        href: item.href,
        id: item.idref,
        title: block?.titleText || block?.text || fallbackTitle,
        paragraphs: [],
        footnotes: pendingFootnotes,
        sampleCfi: block ? cfiForBlock(item, block.node) : null,
        locator: null,
        cfiBase: item.cfiBase,
        images: imagesAssigned ? [] : images,
      };
      pendingFootnotes = [];
      imagesAssigned = true;
      chapters.push(current);
    };
    for (const block of blocks) {
      if (block.kind === 'footnote') {
        if (current) current.footnotes.push({ id: block.node.id || null, text: block.text });
        else pendingFootnotes.push({ id: block.node.id || null, text: block.text });
        continue;
      }
      if (BOILERPLATE_TEXT.test(block.text)) continue;
      if (isChapterHeading(block)) {
        startChapter(block);
        fileStartsChapter = false;
        continue;
      }
      if (fileStartsChapter) {
        startChapter(null);
        fileStartsChapter = false;
      }
      if (!current) startChapter(null);
      current.paragraphs.push(block.text);
      if (!current.sampleCfi) current.sampleCfi = cfiForBlock(item, block.node);
    }
    item.unload();
  }
  const normalized = [];
  for (const chapter of chapters) {
    const text = chapter.paragraphs.join('\n').trim();
    if (!text) continue;
    normalized.push({
      href: chapter.href,
      id: chapter.id,
      title: chapter.title,
      text,
      cfiBase: chapter.cfiBase,
      sampleCfi: chapter.sampleCfi,
      locator: chapter.sampleCfi || (chapter.href + '#chapter-' + (normalized.length + 1)),
      images: chapter.images,
      footnotes: chapter.footnotes,
    });
  }
  const result = {
    format: 'EPUB', title: metadata.title, author: metadata.creator,
    chapterCount: normalized.length, chapters: normalized,
    navigation: navigation.toc.map((item) => ({ label: item.label, href: item.href }))
  };
  book.destroy();
  return result;
}

function orderPdfItems(items, pageWidth) {
  const starts = [...new Set(items.map((item) => item.x))].sort((a, b) => a - b);
  let splitAt = null;
  let largestGap = 0;
  for (let index = 0; index < starts.length - 1; index++) {
    const gap = starts[index + 1] - starts[index];
    if (gap > largestGap) { largestGap = gap; splitAt = (starts[index] + starts[index + 1]) / 2; }
  }
  // A wide horizontal gap relative to page width is treated as a two-column
  // layout. This is a deliberately conservative heuristic, not full layout analysis.
  if (splitAt !== null && largestGap >= pageWidth * 0.18) {
    const topToBottom = (a, b) => Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x;
    const left = items.filter((item) => item.x < splitAt).sort(topToBottom);
    const right = items.filter((item) => item.x >= splitAt).sort(topToBottom);
    return { items: [...left, ...right], columnCount: 2, splitAt };
  }
  return {
    items: [...items].sort((a, b) => Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x),
    columnCount: 1,
    splitAt: null
  };
}

async function parsePdf(bytes) {
  if (bytes.length < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') {
    throw new Error('PDF 文件头无效');
  }
  const [pdfjsLib, pdfWorker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker.default;
  // PDF.js may transfer/detach the supplied ArrayBuffer to its Worker. Keep the
  // original bytes intact because they are also persisted in IndexedDB.
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const rawPages = [];
  const repeatedEdgeCounts = new Map();
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const items = content.items.filter((item) => typeof item.str === 'string').map((item) => ({
      text: item.str, x: item.transform?.[4] ?? 0, y: item.transform?.[5] ?? 0,
      width: item.width ?? 0, height: item.height ?? 0, fontName: item.fontName || null
    }));
    for (const item of items) {
      const normalized = item.text.replace(/\s+/g, ' ').trim();
      if (normalized && (item.y > viewport.height - 50 || item.y < 50)) {
        repeatedEdgeCounts.set(normalized, (repeatedEdgeCounts.get(normalized) || 0) + 1);
      }
    }
    rawPages.push({ physicalPage: pageNumber, viewport: viewport.view, width: viewport.width, height: viewport.height, items });
  }
  const repeatedEdgeText = new Set([...repeatedEdgeCounts].filter(([, count]) => count > 1).map(([text]) => text));
  const pages = rawPages.map((page) => {
    const visibleItems = page.items
      .filter((item) => !repeatedEdgeText.has(item.text.replace(/\s+/g, ' ').trim()));
    const ordered = orderPdfItems(visibleItems, page.width);
    const items = ordered.items;
    // PDF.js text transforms may use a bottom-origin coordinate system.
    // Detect numeric printed page labels near either page edge rather than
    // assuming one fixed coordinate orientation or a narrow absolute offset.
    const edgeThreshold = page.height * 0.12;
    const printedPageItem = items.find((item) =>
      (item.y < edgeThreshold || item.y > page.height - edgeThreshold) &&
      /^\d{1,4}$/.test(item.text.trim())
    );
    const bodyItems = printedPageItem ? items.filter((item) => item !== printedPageItem) : items;
    return {
      physicalPage: page.physicalPage,
      printedPage: printedPageItem ? Number(printedPageItem.text.trim()) : null,
      text: bodyItems.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim(),
      viewport: page.viewport, items: bodyItems.length,
      columnCount: ordered.columnCount, columnSplitAt: ordered.splitAt,
      textItems: items
    };
  });
  return { format: 'PDF', pageCount: pdf.numPages, repeatedEdgeText: [...repeatedEdgeText], pages };
}

async function parseTxt(bytes) {
  let text, encoding = 'utf-8';
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { encoding = 'gb18030'; text = new TextDecoder('gb18030').decode(bytes); }
  const paragraphs = [];
  const matcher = /[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/g;
  for (const match of text.matchAll(matcher)) {
    const value = match[0].trim();
    if (value) {
      const leadingWhitespace = match[0].length - match[0].trimStart().length;
      const startOffset = match.index + leadingWhitespace;
      paragraphs.push({ text: value, startOffset, endOffset: startOffset + value.length });
    }
  }
  return { format: 'TXT', encoding, characterCount: text.length, paragraphCount: paragraphs.length, paragraphs };
}

export async function parseBook(name, bytes) {
  const extension = name.toLowerCase().split('.').pop();
  if (extension === 'epub') return parseEpub(bytes);
  if (extension === 'pdf') return parsePdf(bytes);
  if (extension === 'txt') return parseTxt(bytes);
  throw new Error('暂不支持该文件格式');
}
