import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import processingContract from "../processing-contract.json" with { type: "json" };
import { validatePackage, validateProcessingContract } from "../src/validator.js";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function fixtureEntries(overrides = {}) {
  const source = Buffer.from("synthetic epub fixture bytes");
  const content = "第一章：目标与行动。";
  const chunk = {
    chunk_id: "chunk-001", chapter_id: "chapter-001", chapter_title: "第一章",
    order_index: 0, content, content_sha256: hash(content), locator_type: "epub_cfi",
    start_locator: "epubcfi(/6/2)", end_locator: "epubcfi(/6/4)",
    page_number: null, paragraph_start: 0, paragraph_end: 0,
    parser_version: "fixture-1", chunker_version: "fixture-1",
  };
  const book = { title: "测试书", authors: ["测试作者"], language: "zh-CN" };
  const chapters = [{
    chapter_id: "chapter-001", parent_chapter_id: null, title: "第一章",
    level: 1, order_index: 0, start_locator: "epubcfi(/6/2)", end_locator: "epubcfi(/6/4)",
  }];
  const manifest = {
    schema_name: "read-book-package", schema_version: "1.0.0",
    package_id: "11111111-1111-4111-8111-111111111111", created_at: "2026-11-14T00:00:00.000Z",
    source: { file: "source/original.epub", format: "epub", sha256: hash(source), size_bytes: source.length },
    book: { title: book.title, authors: book.authors, language: book.language, isbn: null, edition: null, translator: null, publisher: null },
    processing: { processor_name: "fixture", processor_version: "1.0.0", rules_version: "1.0.0", parser: "fixture", parser_version: "1.0.0" },
    artifacts: { book: "content/book.json", chapters: "content/chapters.json", chunks: "content/chunks.jsonl", embeddings: null, local_report: null },
    counts: { chapters: 1, chunks: 1, assets: 0 },
  };
  const entries = {
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "source/original.epub": source,
    "content/book.json": Buffer.from(JSON.stringify(book)),
    "content/chapters.json": Buffer.from(JSON.stringify(chapters)),
    "content/chunks.jsonl": Buffer.from(JSON.stringify(chunk) + "\n"),
  };
  return { ...entries, ...overrides };
}
async function writeFixture(t, entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "read-book-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(entries)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return root;
}

test("validates a complete directory package and returns stable counts", async (t) => {
  const root = await writeFixture(t, fixtureEntries());
  const result = await validatePackage(root);
  assert.equal(result.status, "valid");
  assert.deepEqual(result.counts, { files: 5, chapters: 1, chunks: 1, assets: 0, total_bytes: Object.values(fixtureEntries()).reduce((sum, item) => sum + item.length, 0) });
});

test("rejects a source hash mismatch", async (t) => {
  const entries = fixtureEntries();
  entries["source/original.epub"] = Buffer.from("tampered");
  const root = await writeFixture(t, entries);
  const result = await validatePackage(root);
  assert.equal(result.status, "invalid");
  assert.ok(result.issues.some((item) => item.issue_code === "SOURCE_HASH_MISMATCH"));
});

test("rejects chunks that reference a missing chapter", async (t) => {
  const entries = fixtureEntries();
  const chunk = JSON.parse(entries["content/chunks.jsonl"].toString("utf8"));
  chunk.chapter_id = "missing-chapter";
  entries["content/chunks.jsonl"] = Buffer.from(JSON.stringify(chunk) + "\n");
  const root = await writeFixture(t, entries);
  const result = await validatePackage(root);
  assert.ok(result.issues.some((item) => item.issue_code === "CHUNK_CHAPTER_MISSING"));
});

test("validates ZIP packages and rejects path traversal before extraction", async () => {
  const safe = zipSync(Object.fromEntries(Object.entries(fixtureEntries()).map(([name, bytes]) => [name, bytes])));
  const root = await mkdtemp(path.join(os.tmpdir(), "read-book-package-zip-"));
  const safePath = path.join(root, "safe.zip");
  await writeFile(safePath, safe);
  const result = await validatePackage(safePath);
  assert.equal(result.status, "valid");
  const traversal = zipSync({ "../outside.txt": strToU8("escape") });
  const traversalPath = path.join(root, "traversal.zip");
  await writeFile(traversalPath, traversal);
  const rejected = await validatePackage(traversalPath);
  assert.equal(rejected.status, "invalid");
  assert.ok(rejected.issues.some((item) => item.issue_code === "PACKAGE_ARCHIVE_UNSAFE"));
  await rm(root, { recursive: true, force: true });
});

test("rejects excessive ZIP compression ratios before decompression", async () => {
  const bomb = zipSync({ "source/large.txt": strToU8("A".repeat(2_000_000)) });
  const root = await mkdtemp(path.join(os.tmpdir(), "read-book-package-bomb-"));
  const file = path.join(root, "bomb.zip");
  await writeFile(file, bomb);
  const result = await validatePackage(file);
  assert.equal(result.status, "invalid");
  assert.ok(result.issues.some((item) => item.message.includes("compression ratio")));
  await rm(root, { recursive: true, force: true });
});

test("processing contract has known stage dependencies and retry scopes", () => {
  assert.deepEqual(validateProcessingContract(processingContract), []);
});
