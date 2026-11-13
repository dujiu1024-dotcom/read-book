import ePub from 'epubjs';

async function parseEpub(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new Error('EPUB 文件不是有效的 ZIP 容器');
  }
  const book = ePub(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  await book.ready;
  const metadata = await book.loaded.metadata;
  const navigation = await book.loaded.navigation;
  const chapters = [];
  for (const item of book.spine.spineItems) {
    await item.load(book.load.bind(book));
    const document = item.document;
    const text = document?.body?.textContent?.replace(/\\s+/g, ' ').trim() || '';
    let sampleCfi = null;
    if (document?.body && item.cfiFromRange) {
      const walker = document.createTreeWalker(document.body, 4);
      const firstText = walker.nextNode();
      if (firstText) {
        const range = document.createRange();
        range.setStart(firstText, 0);
        range.setEnd(firstText, Math.min(firstText.textContent.length, 120));
        sampleCfi = item.cfiFromRange(range);
      }
    }
    const images = [...(document?.querySelectorAll('img') || [])].map((image) => ({
      src: image.getAttribute('src'), alt: image.getAttribute('alt') || ''
    }));
    const footnotes = [...(document?.querySelectorAll('aside, [role="doc-footnote"]') || [])]
      .filter((node) => node.getAttribute('epub:type') === 'footnote' || node.getAttribute('role') === 'doc-footnote')
      .map((node) => ({ id: node.id || null, text: node.textContent?.replace(/\\s+/g, ' ').trim() || '' }));
    chapters.push({
      href: item.href, id: item.idref,
      title: document?.querySelector('h1,h2')?.textContent || item.href,
      text, cfiBase: item.cfiBase, sampleCfi, images, footnotes
    });
    item.unload();
  }
  const result = {
    format: 'EPUB', title: metadata.title, author: metadata.creator,
    chapterCount: chapters.length, chapters,
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
      const normalized = item.text.replace(/\\s+/g, ' ').trim();
      if (normalized && (item.y > viewport.height - 50 || item.y < 50)) {
        repeatedEdgeCounts.set(normalized, (repeatedEdgeCounts.get(normalized) || 0) + 1);
      }
    }
    rawPages.push({ physicalPage: pageNumber, viewport: viewport.view, width: viewport.width, height: viewport.height, items });
  }
  const repeatedEdgeText = new Set([...repeatedEdgeCounts].filter(([, count]) => count > 1).map(([text]) => text));
  const pages = rawPages.map((page) => {
    const visibleItems = page.items
      .filter((item) => !repeatedEdgeText.has(item.text.replace(/\\s+/g, ' ').trim()));
    const ordered = orderPdfItems(visibleItems, page.width);
    const items = ordered.items;
    const printedPageItem = items.find((item) =>
      item.y < 40 && /^\\d{1,4}$/.test(item.text.trim())
    );
    const bodyItems = printedPageItem ? items.filter((item) => item !== printedPageItem) : items;
    return {
      physicalPage: page.physicalPage,
      printedPage: printedPageItem ? Number(printedPageItem.text.trim()) : null,
      text: bodyItems.map((item) => item.text).join(' ').replace(/\\s+/g, ' ').trim(),
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
  const matcher = /[^\\r\\n]+(?:\\r?\\n(?!\\s*\\r?\\n)[^\\r\\n]+)*/g;
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
