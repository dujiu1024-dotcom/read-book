import { unzipSync, strFromU8 } from "fflate";
import { createBookContentProvider } from "./book-content-provider.js";

const DB_NAME = "read-book-local-book-packages";
const DB_VERSION = 1;
const STORE_NAME = "packages";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`书籍包字段 ${field} 必须是非空字符串。`);
  return value.trim();
}

function parseJson(bytes, path) {
  if (!(bytes instanceof Uint8Array)) throw new Error(`书籍包缺少文件：${path}`);
  try { return JSON.parse(strFromU8(bytes)); }
  catch (error) { throw new Error(`书籍包文件 ${path} 不是有效 JSON：${error.message}`); }
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function chapterPath(chapter, chaptersById) {
  const names = [];
  const visited = new Set();
  let current = chapter;
  while (current) {
    if (visited.has(current.chapter_id)) throw new Error("书籍章节结构存在循环引用。");
    visited.add(current.chapter_id);
    names.push(current.title);
    current = current.parent_chapter_id ? chaptersById.get(current.parent_chapter_id) : null;
  }
  return names.reverse().join(" / ") || "正文";
}

export async function parseBookPackage(input) {
  const archiveBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!archiveBytes.length || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new RangeError("书籍包为空或超过 256 MiB 限制。");
  }
  let files;
  try { files = unzipSync(archiveBytes); }
  catch (error) { throw new Error("书籍包 ZIP 解压失败：" + error.message); }

  const entries = Object.entries(files);
  const expandedBytes = entries.reduce((total, [, bytes]) => total + bytes.byteLength, 0);
  if (entries.length > 20000 || expandedBytes > MAX_EXPANDED_BYTES) {
    throw new RangeError("书籍包展开后文件数量或体积超过安全限制。");
  }
  for (const [path] of entries) {
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error("书籍包包含非法路径：" + path);
    }
  }

  const manifest = parseJson(files["manifest.json"], "manifest.json");
  if (manifest.schema_name !== "read-book-package" || manifest.schema_version !== "1.0.0") {
    throw new Error("不支持的书籍包协议版本。");
  }
  const revisionId = requiredText(manifest.package_id, "manifest.package_id");
  if (!UUID.test(revisionId)) throw new Error("manifest.package_id 必须是 UUID。");
  const bookPath = requiredText(manifest.artifacts?.book, "manifest.artifacts.book");
  const chaptersPath = requiredText(manifest.artifacts?.chapters, "manifest.artifacts.chapters");
  const chunksPath = requiredText(manifest.artifacts?.chunks, "manifest.artifacts.chunks");
  const sourcePath = requiredText(manifest.source?.file, "manifest.source.file");
  const book = parseJson(files[bookPath], bookPath);
  const chapters = parseJson(files[chaptersPath], chaptersPath);
  const chunkBytes = files[chunksPath];
  if (!(chunkBytes instanceof Uint8Array)) throw new Error("书籍包缺少正文 JSONL 文件。");
  if (!Array.isArray(chapters) || chapters.length === 0) throw new Error("书籍包没有有效章节。");
  const sourceBytes = files[sourcePath];
  if (!(sourceBytes instanceof Uint8Array)) throw new Error("书籍包缺少原始文件。");
  if (await sha256(sourceBytes) !== manifest.source.sha256) throw new Error("原始文件 SHA-256 校验失败。");
  if (sourceBytes.byteLength !== manifest.source.size_bytes) throw new Error("原始文件大小与清单不一致。");

  requiredText(book.title, "book.title");
  const author = Array.isArray(book.authors) ? requiredText(book.authors[0], "book.authors[0]") : "";
  if (!author) throw new Error("书籍包必须提供至少一位作者。");

  const chaptersById = new Map();
  for (const chapter of chapters) {
    requiredText(chapter.chapter_id, "chapter.chapter_id");
    requiredText(chapter.title, "chapter.title");
    if (chaptersById.has(chapter.chapter_id)) throw new Error("书籍包存在重复章节 ID。");
    chaptersById.set(chapter.chapter_id, chapter);
  }
  for (const chapter of chapters) {
    if (chapter.parent_chapter_id && !chaptersById.has(chapter.parent_chapter_id)) {
      throw new Error("章节引用了不存在的父章节：" + chapter.parent_chapter_id);
    }
    chapterPath(chapter, chaptersById);
  }

  const lines = strFromU8(chunkBytes).split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("书籍包正文 JSONL 为空。");
  const chunks = lines.map((line, index) => {
    let chunk;
    try { chunk = JSON.parse(line); }
    catch { throw new Error(`正文 JSONL 第 ${index + 1} 行不是有效 JSON。`); }
    requiredText(chunk.chunk_id, `chunks[${index}].chunk_id`);
    requiredText(chunk.chapter_id, `chunks[${index}].chapter_id`);
    requiredText(chunk.content, `chunks[${index}].content`);
    if (!chaptersById.has(chunk.chapter_id)) throw new Error("正文切片引用了不存在的章节：" + chunk.chapter_id);
    return chunk;
  });
  const ids = new Set();
  const units = [];
  for (const chunk of chunks) {
    if (ids.has(chunk.chunk_id)) throw new Error("书籍包存在重复正文切片 ID：" + chunk.chunk_id);
    ids.add(chunk.chunk_id);
    if (chunk.content_sha256 && await sha256(new TextEncoder().encode(chunk.content)) !== chunk.content_sha256) {
      throw new Error("正文切片 SHA-256 校验失败：" + chunk.chunk_id);
    }
    const chapter = chaptersById.get(chunk.chapter_id);
    units.push({
      id: chunk.chunk_id,
      chapter: chapterPath(chapter, chaptersById),
      title: chapter.title,
      locator: chunk.start_locator || (chunk.page_number ? `第${chunk.page_number}页` : `正文单元 ${units.length + 1}`),
      text: chunk.content,
    });
  }
  if (manifest.counts?.chapters !== chapters.length || manifest.counts?.chunks !== chunks.length) {
    throw new Error("书籍包清单中的章节或正文数量与实际内容不一致。");
  }
  return {
    bookRevisionId: revisionId,
    bookId: revisionId,
    title: book.title,
    author,
    language: book.language || "zh-CN",
    initialMainlineUnitId: units[0].id,
    units,
    packageMetadata: {
      packageId: revisionId,
      createdAt: manifest.created_at,
      sourceFormat: manifest.source.format,
      sourceSha256: manifest.source.sha256,
      sourceDescription: manifest.book?.title || book.description || "",
    },
  };
}

function openDatabase(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) return Promise.reject(new Error("当前浏览器不支持 IndexedDB。"));
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "bookRevisionId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("打开本地书籍库失败。"));
  });
}

async function withStore(mode, operation, indexedDBImpl) {
  const db = await openDatabase(indexedDBImpl);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let result;
      try { result = operation(store); }
      catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error || new Error("本地书籍库事务失败。"));
      transaction.onabort = () => reject(transaction.error || new Error("本地书籍库事务已中止。"));
    });
  } finally { db.close(); }
}

export async function importBookPackageFile(file, options = {}) {
  if (!file || typeof file.arrayBuffer !== "function") throw new TypeError("请选择标准书籍包 ZIP 文件。");
  if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("仅支持 .zip 标准书籍包。");
  if (file.size > MAX_ARCHIVE_BYTES) throw new RangeError("书籍包不能超过 256 MiB。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const revision = await parseBookPackage(bytes);
  await withStore("readwrite", (store) => store.put({
    bookRevisionId: revision.bookRevisionId,
    title: revision.title,
    author: revision.author,
    importedAt: new Date().toISOString(),
    archive: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }), options.indexedDB);
  try {
    globalThis.localStorage?.setItem("read-book:active-local-book", revision.bookRevisionId);
    globalThis.localStorage?.setItem("read-book:prefer-local-book", "true");
  } catch {}
  return { bookRevisionId: revision.bookRevisionId, title: revision.title, author: revision.author, unitCount: revision.units.length };
}

export async function listImportedBookPackages(options = {}) {
  const db = await openDatabase(options.indexedDB);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result.map(({ bookRevisionId, title, author, importedAt }) => ({ bookRevisionId, title, author, importedAt })));
      request.onerror = () => reject(request.error || new Error("读取本地书籍清单失败。"));
    });
  } finally { db.close(); }
}

export function createLocalBookPackageProvider(options = {}) {
  return createBookContentProvider({
    async loadBookRevision(bookRevisionId) {
      const db = await openDatabase(options.indexedDB);
      let record;
      try {
        record = await new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, "readonly");
          const request = transaction.objectStore(STORE_NAME).get(bookRevisionId);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error || new Error("读取本地书籍包失败。"));
        });
      } finally { db.close(); }
      if (!record) throw new Error("本地书籍包不存在或尚未导入：" + bookRevisionId);
      return parseBookPackage(new Uint8Array(record.archive));
    },
  });
}
