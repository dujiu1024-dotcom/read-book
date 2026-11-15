import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWLEDGE_BATCH_CHUNKS,
  groupChunksByChapter,
  knowledgeProgressText,
  planKnowledgeBatches,
  selectKnowledgeForPrompt,
  validateKnowledgeItems,
} from "./knowledge-extraction.js";

function chunk(id, chapter, index, text) {
  return {
    id,
    chapter,
    structureNodeId: "unit-" + id,
    locator: chapter + " · 第" + index + "段",
    title: chapter + " · 第" + index + "段",
    text,
  };
}

const batchChunks = [
  chunk("c1", "卷上", 1, "知行合一，正是对病的药。"),
  chunk("c2", "卷上", 2, "心即理也，天下又有心外之事、心外之理乎？"),
];

test("planKnowledgeBatches keeps chapter order, size and character limits", () => {
  const chunks = Array.from({ length: 5 }, (_, index) => chunk("k" + index, "卷上", index + 1, "字".repeat(100)));
  const batches = planKnowledgeBatches(chunks, { chunkLimit: 2, maxCharacters: 900 });
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.chunks.length), [2, 2, 1]);
  assert.equal(batches[0].total, 3);
  assert.equal(batches[2].lastChunkId, "k4");
  assert.equal(planKnowledgeBatches(chunks).length, Math.ceil(5 / KNOWLEDGE_BATCH_CHUNKS));
  assert.equal(groupChunksByChapter([...chunks, chunk("x", "卷中", 1, "另一章")]).get("卷上").length, 5);
});

test("validateKnowledgeItems drops anything that cannot be traced back to a provided chunk", async () => {
  const valid = {
    item_type: "thesis",
    content: "知行合一是针对割裂知行的毛病提出的。",
    term: null,
    definition_quote: null,
    source_chunk_ids: ["c1"],
    confidence: 0.8,
  };
  const concept = {
    item_type: "concept",
    content: "心即理",
    term: "心即理",
    definition_quote: "心即理也",
    source_chunk_ids: ["c2"],
    confidence: 0.9,
  };
  const result = await validateKnowledgeItems([
    valid,
    concept,
    { ...valid, source_chunk_ids: ["unknown"] },
    { ...valid, content: "  " },
    { ...concept, definition_quote: "心外无理" },
    { ...concept, item_type: "summary" },
    { ...valid, source_chunk_ids: [] },
  ], batchChunks, { bookRevisionId: "rev-1", chapter: "卷上", modelVersion: "model-x" });
  assert.equal(result.items.length, 2);
  assert.equal(result.dropped, 5);
  const thesis = result.items.find((item) => item.itemType === "thesis");
  assert.equal(thesis.reviewStatus, "pending");
  assert.equal(thesis.extractionMethod, "llm");
  assert.equal(thesis.modelVersion, "model-x");
  assert.equal(thesis.structureNodeId, "unit-c1");
  assert.deepEqual(thesis.sourceChunkIds, ["c1"]);
  assert.match(thesis.id, /^[0-9a-f-]{36}$/);
  assert.match(thesis.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(result.items.find((item) => item.itemType === "concept").definitionQuote, "心即理也");

  const again = await validateKnowledgeItems([valid, { ...valid }], batchChunks, {
    bookRevisionId: "rev-1", chapter: "卷上", modelVersion: "model-x",
  });
  // 同一批次内的重复条目只保留一条。
  assert.equal(again.items.length, 1);
  assert.equal(again.dropped, 1);

  // 概念以“术语 + 原句定义”为身份：措辞不同的重复输出也只留一条。
  const dedupe = await validateKnowledgeItems([concept, { ...concept, content: "另一种说法" }], batchChunks, {
    bookRevisionId: "rev-1", chapter: "卷上", modelVersion: "model-x",
  });
  assert.equal(dedupe.items.length, 1);
  assert.equal(dedupe.dropped, 1);
});

test("selectKnowledgeForPrompt only uses accepted knowledge and caps each layer at two", () => {
  const base = {
    bookRevisionId: "rev-1",
    chapter: "卷上",
    reviewStatus: "accepted",
    term: null,
    definitionQuote: null,
    sourceLocator: "卷上 · 第1段",
    extractionMethod: "llm",
    modelVersion: "model-x",
    confidence: 0.8,
    contentHash: "hash",
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
    reviewedAt: null,
  };
  const items = [
    { ...base, id: "cur-1", structureNodeId: "unit-cur", itemType: "thesis", content: "当前段主张一" },
    { ...base, id: "cur-2", structureNodeId: "unit-cur", itemType: "concept", content: "当前段概念", term: "良知", definitionQuote: "良知即是天理" },
    { ...base, id: "cur-3", structureNodeId: "unit-cur", itemType: "thesis", content: "当前段主张三" },
    { ...base, id: "chapter-intent", structureNodeId: "unit-1", itemType: "chapter_intent", content: "本章要解决知行割裂" },
    { ...base, id: "chapter-thesis", structureNodeId: "unit-2", itemType: "thesis", content: "本章主张" },
    { ...base, id: "chapter-thesis-2", structureNodeId: "unit-3", itemType: "thesis", content: "本章主张二" },
    { ...base, id: "cross-1", structureNodeId: "unit-9", chapter: "卷中", itemType: "concept", content: "跨章概念", term: "良知", definitionQuote: "良知者，心之本体" },
    { ...base, id: "cross-2", structureNodeId: "unit-10", chapter: "卷下", itemType: "concept", content: "另一跨章", term: "良知", definitionQuote: "良知即是天理" },
    { ...base, id: "pending-1", structureNodeId: "unit-cur", itemType: "thesis", content: "未审核不应进入", reviewStatus: "pending" },
  ];
  const selection = selectKnowledgeForPrompt({ items, currentUnit: { id: "unit-cur", chapter: "卷上" } });
  assert.equal(selection.items.length, 6);
  assert.deepEqual(selection.items.map((item) => item.id), [
    "cur-1", "cur-2", "chapter-intent", "chapter-thesis", "cross-1", "cross-2",
  ]);
  assert.deepEqual(selection.items.map((item) => item.layer), [
    "current", "current", "chapter", "chapter", "cross_chapter", "cross_chapter",
  ]);
  assert.match(selection.lines[0], /^作者主张：当前段主张一（卷上 · 第1段）/);
  assert.match(selection.lines[1], /^概念「良知」：良知即是天理/);
  assert.match(selection.lines[2], /^本章意图：/);
  assert.ok(selection.lines.every((line) => !line.includes("未审核不应进入")));

  // 没有已接受条目时不产生任何 prompt 行。
  assert.deepEqual(selectKnowledgeForPrompt({ items: items.map((item) => ({ ...item, reviewStatus: "rejected" })), currentUnit: { id: "unit-cur", chapter: "卷上" } }).lines, []);
});

test("knowledgeProgressText reports resumable progress", () => {
  assert.match(knowledgeProgressText({ chapter: "卷上", status: "running", doneBatches: 2, totalBatches: 5, itemCount: 4 }), /卷上：正在抽取 2\/5 批/);
  assert.match(knowledgeProgressText({ chapter: "卷上", status: "failed", doneBatches: 2, totalBatches: 5, itemCount: 4 }), /可续跑/);
  assert.match(knowledgeProgressText({ chapter: "卷上", status: "completed", doneBatches: 5, totalBatches: 5, itemCount: 9 }), /已完成，9 条待审核/);
});
