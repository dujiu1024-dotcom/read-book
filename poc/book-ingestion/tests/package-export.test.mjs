import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { buildBookPackage, splitLongChapter } from "../src/package-export.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const metadata = { title: "测试书", author: "测试作者", language: "zh-CN" };
const sourceBytes = new TextEncoder().encode("original source fixture");

test("EPUB package includes source, chapter CFI locator and hashed chunks", async () => {
  const result = await buildBookPackage({
    fileName: "sample.epub",
    sourceBytes,
    metadata,
    packageId: "00000000-0000-4000-8000-000000000001",
    now: () => "2026-11-14T00:00:00.000Z",
    parsed: { format: "EPUB", chapters: [
      { href: "chapter-1.xhtml", title: "第一章", text: "第一章正文", sampleCfi: "epubcfi(/6/4!/4/2)" },
      { href: "chapter-2.xhtml", title: "空章节", text: "" }
    ] }
  });
  assert.equal(result.manifest.counts.chapters, 1);
  assert.equal(result.manifest.counts.chunks, 1);
  assert.equal(result.chunks[0].locator_type, "epub_cfi");
  assert.match(result.chunks[0].content_sha256, /^[a-f0-9]{64}$/);
  const files = unzipSync(result.archive);
  assert.equal(strFromU8(files["source/original.epub"]), "original source fixture");
  assert.equal(JSON.parse(strFromU8(files["content/book.json"])).title, "测试书");
  assert.equal(JSON.parse(strFromU8(files["manifest.json"])).schema_version, "1.0.0");
});

test("PDF package retains physical page locators", async () => {
  const result = await buildBookPackage({
    fileName: "sample.pdf",
    sourceBytes,
    metadata,
    parsed: { format: "PDF", pages: [{ physicalPage: 7, printedPage: 5, text: "PDF page body" }] }
  });
  assert.equal(result.chapters[0].page_start, 7);
  assert.equal(result.chunks[0].locator_type, "pdf_page_text");
  assert.equal(result.chunks[0].page_number, 7);
});

test("TXT package preserves paragraph offsets", async () => {
  const result = await buildBookPackage({
    fileName: "sample.txt",
    sourceBytes,
    metadata,
    parsed: { format: "TXT", paragraphs: [
      { text: "第一段", startOffset: 0, endOffset: 3 },
      { text: "第二段", startOffset: 5, endOffset: 8 }
    ] }
  });
  assert.equal(result.chapters.length, 1);
  assert.equal(result.chunks.length, 2);
  assert.equal(result.chunks[1].start_locator, "txt:offset:5");
});

test("missing author and empty extracted text fail closed", async () => {
  await assert.rejects(() => buildBookPackage({
    fileName: "sample.txt", sourceBytes, metadata: { title: "测试书", language: "zh-CN" },
    parsed: { format: "TXT", paragraphs: [{ text: "正文", startOffset: 0, endOffset: 2 }] }
  }), /作者不能为空/);
  await assert.rejects(() => buildBookPackage({
    fileName: "sample.pdf", sourceBytes, metadata,
    parsed: { format: "PDF", pages: [{ physicalPage: 1, text: " " }] }
  }), /未提取到可打包/);
});

test("超长章节按段落二次切分，短章节保持一个单元", () => {
  const paragraph = "這是一段用於驗證超長章節二次切分的原文。".repeat(40);
  const long = { href: "c1.xhtml", title: "第一回 測試", text: Array.from({ length: 40 }, () => paragraph).join("\n") };
  assert.ok(long.text.length > 10_000);
  const parts = splitLongChapter(long);
  assert.ok(parts.length >= 2);
  parts.forEach((part, index) => {
    assert.ok(part.text.length <= 6_000 + paragraph.length);
    assert.equal(part.title, "第一回 測試（" + (index + 1) + "/" + parts.length + "）");
    assert.equal(part.href, "c1.xhtml");
  });
  const short = { href: "c2.xhtml", title: "第二回 測試", text: paragraph.repeat(20) };
  assert.equal(splitLongChapter(short).length, 1);
  assert.equal(splitLongChapter(short)[0].title, "第二回 測試");
});
