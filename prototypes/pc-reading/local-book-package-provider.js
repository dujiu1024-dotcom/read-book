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

function safeArchivePath(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error("ZIP 包含绝对路径或格式异常的路径。");
  }
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  const segments = trimmed.split("/");
  if (!trimmed || segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error("ZIP 包含路径穿越或空路径段。");
  }
  return trimmed;
}

function inspectZipCentralDirectory(bytes) {
  const maxEntries = 20000;
  const maxFileBytes = 128 * 1024 * 1024;
  const maxTotalBytes = MAX_EXPANDED_BYTES;
  const maxCompressionRatio = 200;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error("书籍包缺少有效 ZIP 目录结束记录。");
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  const commentLength = view.getUint16(endOffset + 20, true);
  if (endOffset + 22 + commentLength !== bytes.byteLength) throw new Error("ZIP 目录结束记录长度无效。");
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) throw new Error("不支持分卷 ZIP 书籍包。");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("暂不支持 ZIP64 书籍包。");
  if (entryCount > maxEntries || centralOffset + centralSize > endOffset) throw new Error("ZIP 中央目录超过限制或结构损坏。");

  const seen = new Set();
  const expectedFiles = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("ZIP 中央目录条目损坏。");
    }
    const madeBy = view.getUint16(cursor + 4, true) >>> 8;
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const entryEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (entryEnd > centralOffset + centralSize) throw new Error("ZIP 条目元数据越界。");
    const rawName = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const path = safeArchivePath(rawName);
    const directory = rawName.endsWith("/");
    const folded = path.toLocaleLowerCase("en-US");
    if (seen.has(folded)) throw new Error("ZIP 包含重复或大小写冲突路径：" + path);
    seen.add(folded);
    if ((flags & 1) !== 0) throw new Error("不接受加密 ZIP 条目。");
    if (![0, 8].includes(method)) throw new Error("书籍包使用了不支持的 ZIP 压缩方式。");
    const unixMode = externalAttributes >>> 16;
    if (madeBy === 3 && (unixMode & 0o170000) === 0o120000) throw new Error("不接受 ZIP 符号链接。");
    if (!directory && uncompressedSize > maxFileBytes) throw new Error("ZIP 单个文件超过 128 MiB 限制：" + path);
    if (!directory && uncompressedSize > 0 && uncompressedSize / Math.max(compressedSize, 1) > maxCompressionRatio) {
      throw new Error("ZIP 文件压缩比超过 200:1 限制：" + path);
    }
    if (localHeaderOffset + 30 > centralOffset || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error("ZIP 本地文件头无效：" + path);
    }
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const localName = decoder.decode(bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength));
    if (localName !== rawName) throw new Error("ZIP 本地文件头与中央目录路径不一致：" + path);
    const dataEnd = localHeaderOffset + 30 + localNameLength + localExtraLength + compressedSize;
    if (dataEnd > centralOffset) throw new Error("ZIP 文件数据越界：" + path);
    if (!directory) {
      totalBytes += uncompressedSize;
      if (totalBytes > maxTotalBytes) throw new Error("书籍包展开后体积超过 512 MiB 限制。");
      expectedFiles.set(path, uncompressedSize);
    }
    cursor = entryEnd;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP 中央目录长度与条目数量不一致。");
  return expectedFiles;
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

export async function parseBookPackage(input, identity = {}) {
  const archiveBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!archiveBytes.length || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new RangeError("书籍包为空或超过 256 MiB 限制。");
  }
  const expectedFiles = inspectZipCentralDirectory(archiveBytes);
  let files;
  try { files = unzipSync(archiveBytes); }
  catch (error) { throw new Error("书籍包 ZIP 解压失败：" + error.message); }

  const entries = Object.entries(files);
  if (entries.length !== expectedFiles.size) throw new Error("ZIP 解压后的文件数量与中央目录不一致。");
  for (const [path, size] of expectedFiles) {
    if (!(files[path] instanceof Uint8Array) || files[path].byteLength !== size) {
      throw new Error("ZIP 文件解压结果与中央目录声明不一致：" + path);
    }
  }
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
  const packageId = requiredText(manifest.package_id, "manifest.package_id");
  if (!UUID.test(packageId)) throw new Error("manifest.package_id 必须是 UUID。");
  const bookId = identity.bookId || crypto.randomUUID();
  const bookRevisionId = identity.bookRevisionId || crypto.randomUUID();
  if (!UUID.test(bookId) || !UUID.test(bookRevisionId)) throw new Error("本地 Book/BookRevision 标识必须是 UUID。");

  const sourcePath = requiredText(manifest.source?.file, "manifest.source.file");
  const sourceFormat = requiredText(manifest.source?.format, "manifest.source.format").toLowerCase();
  if (!["epub", "pdf", "txt"].includes(sourceFormat)) throw new Error("不支持的原始书籍格式。");
  if (!sourcePath.startsWith("source/") || sourcePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("manifest.source.file 必须位于 source/ 安全目录下。");
  }
  if (typeof manifest.source?.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.source.sha256)) {
    throw new Error("manifest.source.sha256 格式无效。");
  }
  if (!Number.isInteger(manifest.source?.size_bytes) || manifest.source.size_bytes < 1) throw new Error("manifest.source.size_bytes 无效。");
  if (sourcePath.split(".").pop().toLowerCase() !== sourceFormat) throw new Error("原始文件扩展名与声明格式不一致。");

  const processing = manifest.processing;
  for (const field of ["processor_name", "processor_version", "rules_version", "parser", "parser_version"]) {
    requiredText(processing?.[field], "manifest.processing." + field);
  }
  const bookPath = requiredText(manifest.artifacts?.book, "manifest.artifacts.book");
  const chaptersPath = requiredText(manifest.artifacts?.chapters, "manifest.artifacts.chapters");
  const chunksPath = requiredText(manifest.artifacts?.chunks, "manifest.artifacts.chunks");
  if (![bookPath, chaptersPath, chunksPath].every((path) => path.startsWith("content/"))) {
    throw new Error("书籍、章节和正文工件必须位于 content/ 目录。");
  }
  for (const field of ["assets", "embeddings", "local_report"]) {
    if (!(field in (manifest.artifacts || {}))) throw new Error("manifest.artifacts 缺少字段：" + field);
  }
  const optionalArtifactPaths = [
    [manifest.artifacts.assets, "content/"],
    [manifest.artifacts.embeddings, "embeddings/"],
    [manifest.artifacts.local_report, "validation/"],
  ];
  for (const [path, prefix] of optionalArtifactPaths) {
    if (path !== null && (typeof path !== "string" || !path.startsWith(prefix))) {
      throw new Error("可选工件路径必须位于 " + prefix + " 目录。");
    }
    if (path && !(files[path] instanceof Uint8Array)) throw new Error("书籍包缺少声明工件：" + path);
  }
  const rootNames = new Set(["manifest.json", "source", "content", "assets", "embeddings", "validation"]);
  for (const path of Object.keys(files)) {
    if (!rootNames.has(path.split("/")[0])) throw new Error("书籍包包含未约定的顶层目录：" + path);
  }

  const book = parseJson(files[bookPath], bookPath);
  const chapters = parseJson(files[chaptersPath], chaptersPath);
  const chunkBytes = files[chunksPath];
  if (!(chunkBytes instanceof Uint8Array)) throw new Error("书籍包缺少正文 JSONL 文件。");
  if (!Array.isArray(chapters) || chapters.length === 0) throw new Error("书籍包没有有效章节。");
  const sourceBytes = files[sourcePath];
  if (!(sourceBytes instanceof Uint8Array)) throw new Error("书籍包缺少原始文件。");
  if (await sha256(sourceBytes) !== manifest.source.sha256.toLowerCase()) throw new Error("原始文件 SHA-256 校验失败。");
  if (sourceBytes.byteLength !== manifest.source.size_bytes) throw new Error("原始文件大小与清单不一致。");

  const title = requiredText(book.title, "book.title");
  if (!Array.isArray(book.authors) || !book.authors.length) throw new Error("book.authors 必须包含至少一位作者。");
  const author = requiredText(book.authors[0], "book.authors[0]");
  const language = requiredText(book.language, "book.language");
  if (title !== manifest.book?.title || language !== manifest.book?.language ||
      JSON.stringify(book.authors) !== JSON.stringify(manifest.book?.authors)) {
    throw new Error("manifest.book 与 content/book.json 元数据不一致。");
  }
  for (const field of ["isbn", "edition", "translator", "publisher"]) {
    if (!(field in (manifest.book || {}))) throw new Error("manifest.book 缺少字段：" + field);
  }
  if (!Number.isInteger(manifest.counts?.chapters) || !Number.isInteger(manifest.counts?.chunks) ||
      !Number.isInteger(manifest.counts?.assets) || manifest.counts.chapters < 1 || manifest.counts.chunks < 1 || manifest.counts.assets < 0) {
    throw new Error("manifest.counts 字段无效。");
  }

  const chaptersById = new Map();
  for (const chapter of chapters) {
    requiredText(chapter.chapter_id, "chapter.chapter_id");
    requiredText(chapter.title, "chapter.title");
    if (!Number.isInteger(chapter.order_index) || chapter.order_index < 0) throw new Error("章节必须提供非负整数 order_index。");
    if (!Number.isInteger(chapter.level) || chapter.level < 1 || chapter.level > 12) throw new Error("章节 level 必须在 1–12 之间。");
    requiredText(chapter.start_locator, "chapter.start_locator");
    requiredText(chapter.end_locator, "chapter.end_locator");
    if (!(chapter.parent_chapter_id === null || typeof chapter.parent_chapter_id === "string")) throw new Error("chapter.parent_chapter_id 必须是字符串或 null。");
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
    requiredText(chunk.chapter_title, `chunks[${index}].chapter_title`);
    requiredText(chunk.parser_version, `chunks[${index}].parser_version`);
    requiredText(chunk.chunker_version, `chunks[${index}].chunker_version`);
    requiredText(chunk.locator_type, `chunks[${index}].locator_type`);
    if (!["epub_cfi", "text_anchor", "pdf_page_text", "txt_offset", "paragraph_offset", "custom"].includes(chunk.locator_type)) throw new Error("正文切片 locator_type 无效。");
    requiredText(chunk.start_locator, `chunks[${index}].start_locator`);
    requiredText(chunk.end_locator, `chunks[${index}].end_locator`);
    if (!Number.isInteger(chunk.order_index) || chunk.order_index < 0) throw new Error("正文切片必须提供非负整数 order_index。");
    if (typeof chunk.content_sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(chunk.content_sha256)) throw new Error("正文切片必须提供有效 content_sha256。");
    if (!chaptersById.has(chunk.chapter_id)) throw new Error("正文切片引用了不存在的章节：" + chunk.chapter_id);
    if (chunk.chapter_title !== chaptersById.get(chunk.chapter_id).title) throw new Error("正文切片 chapter_title 与章节树不一致：" + chunk.chunk_id);
    return chunk;
  });
  const chapterOrderPath = (chapter) => {
    const order = [];
    let current = chapter;
    while (current) {
      order.push(current.order_index);
      current = current.parent_chapter_id ? chaptersById.get(current.parent_chapter_id) : null;
    }
    return order.reverse();
  };
  chunks.sort((left, right) => {
    const leftPath = chapterOrderPath(chaptersById.get(left.chapter_id));
    const rightPath = chapterOrderPath(chaptersById.get(right.chapter_id));
    for (let index = 0; index < Math.min(leftPath.length, rightPath.length); index += 1) {
      if (leftPath[index] !== rightPath[index]) return leftPath[index] - rightPath[index];
    }
    return leftPath.length - rightPath.length || left.order_index - right.order_index;
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
      locator: chunk.start_locator,
      endLocator: chunk.end_locator,
      locatorType: chunk.locator_type,
      text: chunk.content,
    });
  }
  const chapterOrderKeys = new Set();
  for (const chapter of chapters) {
    const key = (chapter.parent_chapter_id || "root") + ":" + chapter.order_index;
    if (chapterOrderKeys.has(key)) throw new Error("同级章节 order_index 重复。");
    chapterOrderKeys.add(key);
  }
  const chunkOrderKeys = new Set();
  for (const chunk of chunks) {
    const key = chunk.chapter_id + ":" + chunk.order_index;
    if (chunkOrderKeys.has(key)) throw new Error("同一章节内正文切片 order_index 重复。");
    chunkOrderKeys.add(key);
  }
  const assetPaths = Object.keys(files).filter((path) => path.startsWith("assets/") && !path.endsWith("/"));
  if (manifest.counts.chapters !== chapters.length || manifest.counts.chunks !== chunks.length || manifest.counts.assets !== assetPaths.length) {
    throw new Error("书籍包清单中的章节、正文或资源数量与实际内容不一致。");
  }
  if (manifest.artifacts.assets) {
    const assets = parseJson(files[manifest.artifacts.assets], manifest.artifacts.assets);
    if (!Array.isArray(assets)) throw new Error("资源清单必须是数组。");
    const ids = new Set();
    const paths = new Set();
    for (const asset of assets) {
      const id = requiredText(asset.asset_id, "asset.asset_id");
      const path = requiredText(asset.path, "asset.path");
      if (!["image", "page_render", "figure", "table", "other"].includes(asset.asset_type)) throw new Error("资源类型无效：" + id);
      if (typeof asset.mime_type !== "string" || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(asset.mime_type)) throw new Error("资源 MIME 类型无效：" + id);
      if (!path.startsWith("assets/") || !files[path]) throw new Error("资源文件缺失或不在 assets/ 目录：" + path);
      if (ids.has(id) || paths.has(path)) throw new Error("资源清单存在重复 ID 或路径。");
      if (typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(asset.sha256) || !Number.isInteger(asset.size_bytes) || asset.size_bytes < 1) {
        throw new Error("资源哈希或大小字段无效：" + id);
      }
      ids.add(id); paths.add(path);
      const bytes = files[path];
      if (bytes.byteLength !== asset.size_bytes || await sha256(bytes) !== asset.sha256.toLowerCase()) {
        throw new Error("资源文件大小或 SHA-256 校验失败：" + path);
      }
      if (asset.locator && (
        !["epub_cfi", "text_anchor", "pdf_page_text", "txt_offset", "paragraph_offset", "custom"].includes(asset.locator.locator_type) ||
        typeof asset.locator.start_locator !== "string" || !asset.locator.start_locator ||
        typeof asset.locator.end_locator !== "string" || !asset.locator.end_locator
      )) throw new Error("资源原文定位字段无效：" + id);
    }
    if (paths.size !== assetPaths.length || assetPaths.some((path) => !paths.has(path))) throw new Error("存在未声明的资源文件。");
  } else if (assetPaths.length) {
    throw new Error("存在 assets/ 文件，但 manifest.artifacts.assets 未提供资源清单。");
  }
  return {
    bookRevisionId,
    bookId,
    title: book.title,
    author,
    language,
    initialMainlineUnitId: units[0].id,
    units,
    packageMetadata: {
      packageId,
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
    bookId: revision.bookId,
    packageId: revision.packageMetadata.packageId,
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
      return parseBookPackage(new Uint8Array(record.archive), { bookId: record.bookId, bookRevisionId: record.bookRevisionId });
    },
  });
}
