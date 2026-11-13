import ePub from 'epubjs';
async function parseEpub(bytes) {
  const book = ePub(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  await book.ready;
  const metadata = await book.loaded.metadata;
  const navigation = await book.loaded.navigation;
  const chapters = [];
  for (const item of book.spine.spineItems) {
    await item.load(book.load.bind(book));
    const text = item.document?.body?.textContent?.replace(/\s+/g, ' ').trim() || '';
    chapters.push({ href: item.href, id: item.idref, title: item.document?.querySelector('h1,h2')?.textContent || item.href, text, cfiBase: item.cfiBase });
    item.unload();
  }
  await book.locations.generate(1000);
  const cfi = book.locations.length() ? book.locations.cfiFromLocation(0) : null;
  const result = { format: 'EPUB', title: metadata.title, author: metadata.creator, chapterCount: chapters.length, chapters, navigation: navigation.toc.map((item) => ({ label: item.label, href: item.href })), sampleCfi: cfi };
  book.destroy();
  return result;
}

async function parsePdf(bytes) {
  const [pdfjsLib, pdfWorker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker.default;
  // PDF.js may transfer/detach the supplied buffer to its Worker. Keep the
  // original bytes intact because they are also persisted in IndexedDB.
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
    pages.push({ physicalPage: pageNumber, printedPage: null, text, viewport: page.getViewport({ scale: 1 }).view, items: content.items.length });
  }
  return { format: 'PDF', pageCount: pdf.numPages, pages };
}

async function parseTxt(bytes) {
  let text, encoding = 'utf-8';
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { encoding = 'gb18030'; text = new TextDecoder('gb18030').decode(bytes); }
  const paragraphs = [];
  const matcher = /[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/g;
  for (const match of text.matchAll(matcher)) {
    const value = match[0].trim();
    if (value) paragraphs.push({ text: value, startOffset: match.index, endOffset: match.index + match[0].length });
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
