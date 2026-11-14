import { strToU8, zipSync } from "fflate";

const encoder = new TextEncoder();
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map((value) => value.toString(16).padStart(2, "0")).join("");

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " 不能为空；不会自动编造书籍元数据。");
  return value.trim();
}

function sourceExtension(fileName, format) {
  const extension = String(fileName).split(".").pop()?.toLowerCase();
  if (!["epub", "pdf", "txt"].includes(extension) || extension !== format.toLowerCase()) {
    throw new Error("原始文件扩展名与解析格式不一致。");
  }
  return extension;
}

function toRecords(parsed) {
  if (parsed.format === "EPUB") {
    const chapters = [];
    const chunks = [];
    parsed.chapters.forEach((item, index) => {
      const content = String(item.text || "").trim();
      if (!content) return;
      const chapterId = "chapter-" + String(index + 1).padStart(5, "0");
      const locator = item.sampleCfi || item.href;
      chapters.push({
        chapter_id: chapterId,
        parent_chapter_id: null,
        title: String(item.title || item.href || "未命名章节"),
        level: 1,
        order_index: chapters.length,
        start_locator: locator,
        end_locator: locator,
        source_heading: item.title || null
      });
      chunks.push({
        chunk_id: "chunk-" + String(chunks.length + 1).padStart(6, "0"),
        chapter_id: chapterId,
        chapter_title: String(item.title || item.href || "未命名章节"),
        order_index: chunks.length,
        content,
        locator_type: item.sampleCfi ? "epub_cfi" : "text_anchor",
        start_locator: locator,
        end_locator: locator,
        parser_version: "epubjs-0.3.93",
        chunker_version: "read-book-ingestion-0.1.0"
      });
    });
    return { chapters, chunks };
  }
  if (parsed.format === "PDF") {
    const chapters = [];
    const chunks = [];
    parsed.pages.forEach((page) => {
      const content = String(page.text || "").trim();
      if (!content) return;
      const chapterId = "page-" + String(page.physicalPage).padStart(5, "0");
      const locator = "pdf:page:" + page.physicalPage;
      chapters.push({
        chapter_id: chapterId,
        parent_chapter_id: null,
        title: "物理页 " + page.physicalPage,
        level: 1,
        order_index: chapters.length,
        start_locator: locator + ":start",
        end_locator: locator + ":end",
        page_start: page.physicalPage,
        page_end: page.physicalPage,
        source_heading: null
      });
      chunks.push({
        chunk_id: "chunk-" + String(chunks.length + 1).padStart(6, "0"),
        chapter_id: chapterId,
        chapter_title: "物理页 " + page.physicalPage,
        order_index: chunks.length,
        content,
        locator_type: "pdf_page_text",
        start_locator: locator + ":start",
        end_locator: locator + ":end",
        page_number: page.physicalPage,
        parser_version: "pdfjs-dist-6.5.438",
        chunker_version: "read-book-ingestion-0.1.0"
      });
    });
    return { chapters, chunks };
  }
  if (parsed.format === "TXT") {
    const paragraphs = (parsed.paragraphs || []).filter((item) => String(item.text || "").trim());
    if (!paragraphs.length) throw new Error("TXT 未提取到可导出的正文段落。");
    const chapterId = "chapter-body";
    const chapters = [{
      chapter_id: chapterId,
      parent_chapter_id: null,
      title: "正文",
      level: 1,
      order_index: 0,
      start_locator: "txt:offset:" + paragraphs[0].startOffset,
      end_locator: "txt:offset:" + paragraphs[paragraphs.length - 1].endOffset,
      source_heading: null
    }];
    const chunks = paragraphs.map((item, index) => ({
      chunk_id: "chunk-" + String(index + 1).padStart(6, "0"),
      chapter_id: chapterId,
      chapter_title: "正文",
      order_index: index,
      content: String(item.text).trim(),
      locator_type: "txt_offset",
      start_locator: "txt:offset:" + item.startOffset,
      end_locator: "txt:offset:" + item.endOffset,
      paragraph_start: index,
      paragraph_end: index,
      parser_version: "read-book-txt-0.1.0",
      chunker_version: "read-book-ingestion-0.1.0"
    }));
    return { chapters, chunks };
  }
  throw new Error("不支持的解析格式。");
}

export async function buildBookPackage({ fileName, sourceBytes, parsed, metadata, now = () => new Date().toISOString(), packageId = crypto.randomUUID() }) {
  if (!(sourceBytes instanceof Uint8Array) || sourceBytes.length === 0) throw new Error("原始文件内容为空。");
  if (!parsed || !["EPUB", "PDF", "TXT"].includes(parsed.format)) throw new Error("缺少有效的解析结果。");
  const title = requiredText(metadata?.title, "书名");
  const author = requiredText(metadata?.author, "作者");
  const language = requiredText(metadata?.language || "zh-CN", "语言");
  const extension = sourceExtension(fileName, parsed.format);
  const { chapters, chunks } = toRecords(parsed);
  if (!chapters.length || !chunks.length) throw new Error("未提取到可打包的章节和正文切片。");

  for (const chunk of chunks) chunk.content_sha256 = await sha256(encoder.encode(chunk.content));
  const book = {
    title,
    authors: [author],
    language,
    description: metadata?.description?.trim() || null,
    identifiers: metadata?.isbn?.trim() ? [{ scheme: "ISBN", value: metadata.isbn.trim() }] : []
  };
  const sourcePath = "source/original." + extension;
  const manifest = {
    schema_name: "read-book-package",
    schema_version: "1.0.0",
    package_id: packageId,
    created_at: now(),
    source: {
      file: sourcePath,
      format: extension,
      sha256: await sha256(sourceBytes),
      size_bytes: sourceBytes.byteLength
    },
    book: {
      title,
      authors: [author],
      language,
      isbn: metadata?.isbn?.trim() || null,
      edition: metadata?.edition?.trim() || null,
      translator: metadata?.translator?.trim() || null,
      publisher: metadata?.publisher?.trim() || null
    },
    processing: {
      processor_name: "read-book-book-ingestion-poc",
      processor_version: "0.1.0",
      rules_version: "1.0.0",
      parser: extension === "epub" ? "epubjs" : extension === "pdf" ? "pdfjs-dist" : "read-book-txt",
      parser_version: extension === "epub" ? "0.3.93" : extension === "pdf" ? "6.5.438" : "0.1.0"
    },
    artifacts: {
      book: "content/book.json",
      chapters: "content/chapters.json",
      chunks: "content/chunks.jsonl",
      assets: null,
      embeddings: null,
      local_report: null
    },
    counts: { chapters: chapters.length, chunks: chunks.length, assets: 0 }
  };
  const files = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "content/book.json": strToU8(JSON.stringify(book, null, 2)),
    "content/chapters.json": strToU8(JSON.stringify(chapters, null, 2)),
    "content/chunks.jsonl": strToU8(chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n"),
    [sourcePath]: sourceBytes
  };
  return { manifest, book, chapters, chunks, archive: zipSync(files, { level: 6 }) };
}
