import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { parseBookPackage } from "./local-book-package-provider.js";
import { createHash } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture({ corruptChunk = false } = {}) {
  const source = strToU8("source file");
  const content = "第一段正文内容。";
  const packageId = "a9d0a34a-5e6f-4a2d-9f30-4d7e5e8c1a20";
  const manifest = {
    schema_name: "read-book-package",
    schema_version: "1.0.0",
    package_id: packageId,
    created_at: "2026-11-14T00:00:00.000Z",
    source: { file: "source/original.txt", format: "txt", sha256: digest(source), size_bytes: source.byteLength },
    book: { title: "测试书", authors: ["测试作者"], language: "zh-CN" },
    artifacts: { book: "content/book.json", chapters: "content/chapters.json", chunks: "content/chunks.jsonl" },
    counts: { chapters: 1, chunks: 1, assets: 0 },
  };
  const chunk = {
    chunk_id: "chunk-000001", chapter_id: "chapter-1", content,
    content_sha256: corruptChunk ? "0".repeat(64) : digest(content),
    locator_type: "txt", order_index: 0,
    start_locator: "txt:offset:0", end_locator: "txt:offset:8",
  };
  return zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "source/original.txt": source,
    "content/book.json": strToU8(JSON.stringify({ title: "测试书", authors: ["测试作者"], language: "zh-CN" })),
    "content/chapters.json": strToU8(JSON.stringify([{ chapter_id: "chapter-1", parent_chapter_id: null, title: "第一章", order_index: 0 }])),
    "content/chunks.jsonl": strToU8(JSON.stringify(chunk) + "\n"),
  });
}

test("parses a valid standard package into stable reading units", async () => {
  const book = await parseBookPackage(fixture());
  assert.equal(book.packageMetadata.packageId, "a9d0a34a-5e6f-4a2d-9f30-4d7e5e8c1a20");
  assert.match(book.bookId, /^[0-9a-f-]{36}$/i);
  assert.match(book.bookRevisionId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(book.bookRevisionId, book.packageMetadata.packageId);
  assert.equal(book.initialMainlineUnitId, "chunk-000001");
  assert.equal(book.units[0].chapter, "第一章");
  assert.equal(book.units[0].text, "第一段正文内容。");
});

test("rejects a package with a tampered chunk hash", async () => {
  await assert.rejects(() => parseBookPackage(fixture({ corruptChunk: true })), /SHA-256/);
});

test("rejects a package with a tampered source file", async () => {
  const archive = fixture();
  // Parsing a structurally valid archive with a changed source is rejected by its manifest digest.
  const files = {
    "manifest.json": strToU8(JSON.stringify({
      schema_name: "read-book-package", schema_version: "1.0.0",
      package_id: "a9d0a34a-5e6f-4a2d-9f30-4d7e5e8c1a20",
      created_at: "2026-11-14T00:00:00.000Z",
      source: { file: "source/original.txt", format: "txt", sha256: "0".repeat(64), size_bytes: 11 },
      book: { title: "测试书", authors: ["测试作者"] },
      artifacts: { book: "content/book.json", chapters: "content/chapters.json", chunks: "content/chunks.jsonl" },
      counts: { chapters: 1, chunks: 1, assets: 0 },
    })),
    "source/original.txt": strToU8("source file"),
    "content/book.json": strToU8(JSON.stringify({ title: "测试书", authors: ["测试作者"] })),
    "content/chapters.json": strToU8(JSON.stringify([{ chapter_id: "chapter-1", title: "第一章", parent_chapter_id: null }])),
    "content/chunks.jsonl": strToU8(JSON.stringify({ chunk_id: "c1", chapter_id: "chapter-1", content: "正文", content_sha256: digest("正文"), locator_type: "txt", order_index: 0, start_locator: "txt:0", end_locator: "txt:2" })),
  };
  await assert.rejects(() => parseBookPackage(zipSync(files)), /原始文件 SHA-256/);
  assert.ok(archive.byteLength > 0);
});

test("rejects archive paths that escape the package root", async () => {
  await assert.rejects(
    () => parseBookPackage(zipSync({ "../escape.txt": strToU8("not allowed") })),
    /非法路径/,
  );
});
