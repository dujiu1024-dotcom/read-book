import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWLEDGE_BATCH_CHUNKS,
  consolidateConcepts,
  detectChapterGenre,
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
  chunk("c3", "卷上", 3, "「格物」者，正也。」"),
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

test("validateKnowledgeItems rejects quotes with stray glyphs and quotes without the term", async () => {
  const quote = {
    item_type: "concept",
    content: "心即理",
    term: "心即理",
    definition_quote: "心即理也",
    source_chunk_ids: ["c2"],
    confidence: 0.9,
  };
  const result = await validateKnowledgeItems([
    { ...quote, definition_quote: "心即理也\uE123" },
    { ...quote, term: "心即理也\uFFFD" },
    { ...quote, definition_quote: "心即理也」" },
    { ...quote, term: "格物", definition_quote: "「格物」者，正也。」", source_chunk_ids: ["c3"] },
    { ...quote, term: "知行合一", definition_quote: "知行合一，正是对病的药" , source_chunk_ids: ["c1"] },
    { ...quote, term: "格物", definition_quote: "正是对病的药", source_chunk_ids: ["c1"] },
  ], batchChunks, { bookRevisionId: "rev-1", chapter: "卷上", modelVersion: "model-x" });
  // 第五条（知行合一）的术语确实出现在引文里，保留；其余五条因脏字符、引号残缺或引文不含术语被丢弃。
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].term, "知行合一");
  assert.equal(result.dropped, 5);
});

test("consolidateConcepts keeps one canonical concept per term and merges the rest as aliases", () => {
  const base = {
    bookRevisionId: "rev-1",
    chapter: "卷上",
    itemType: "concept",
    reviewStatus: "pending",
    sourceLocator: "卷上 · 第1段",
    structureNodeId: "unit-1",
    aliasOf: null,
  };
  const items = [
    { ...base, id: "a", term: "性", definitionQuote: "性即理也", content: "性即理" },
    { ...base, id: "b", term: "性", definitionQuote: "性者，心之本体，所谓天理也", content: "性" },
    { ...base, id: "c", term: "性", definitionQuote: "性只是一箇理", content: "性" },
    { ...base, id: "d", term: "良知", definitionQuote: "良知者，心之本体", content: "良知", reviewStatus: "accepted" },
    { ...base, id: "e", term: "良知", definitionQuote: "良知即是天理", content: "良知" },
    { ...base, id: "f", term: "格物", definitionQuote: "格物者，格其心之物也", content: "格物" },
    // 已经是别名的条目不再参与合并。
    { ...base, id: "g", term: "致知", definitionQuote: "致知者，致吾心之良知", content: "致知", aliasOf: "someone" },
  ];
  const aliases = consolidateConcepts(items);
  const byId = new Map(aliases.map((alias) => [alias.id, alias.aliasOf]));
  // 已审核的 k 优先做主条目，另一条 pending 并入。
  assert.equal(byId.get("e"), "d");
  assert.equal(byId.has("d"), false);
  // 「性」取引文最长、最像界定句的 b，其余两条并入。
  assert.equal(byId.get("a"), "b");
  assert.equal(byId.get("c"), "b");
  assert.equal(byId.size, 3);

  // 已接受/已驳回条目即使引文更短也不会被改成别名。
  const reviewed = consolidateConcepts([
    { ...base, id: "x", term: "心", definitionQuote: "心即理也", content: "心", reviewStatus: "accepted" },
    { ...base, id: "y", term: "心", definitionQuote: "心者，身之主宰，即所谓天理也，无所不包者也", content: "心" },
  ]);
  // 评分优先已审核条目，所以 x 仍是主条目，y 并入。
  assert.deepEqual(reviewed, [{ id: "y", aliasOf: "x" }]);
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
    // 已合并为别名的概念即使被接受也不进入 prompt。
    { ...base, id: "alias-1", structureNodeId: "unit-cur", itemType: "concept", content: "同一概念的别名", term: "良知", definitionQuote: "良知即是天理", aliasOf: "cur-2" },
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

test("detectChapterGenre separates chapter-novel narrative from expository prose", () => {
  const narrative = [
    "卻說那猴王領了旨意，歡歡喜喜，徑回花果山。",
    "只見那洞門外，群猴羅列，齊聲叫道：「大王來了！」",
    "行者道：「你等不必驚慌，老孫自有主張。」",
    "正說間，忽見一朵祥雲自東而來，原來是太白金星。",
    "畢竟不知此去如何，且聽下回分解。",
  ].join("");
  assert.equal(detectChapterGenre(narrative.repeat(3)), "narrative");
  const expository = [
    "先生曰：「心即理也。天下又有心外之事、心外之理乎？」",
    "愛曰：「如事父之孝，事君之忠，其間有許多理在。」",
    "所謂致知格物者，致吾心之良知於事事物物也。",
    "知是行之始，行是知之成。",
  ].join("");
  assert.equal(detectChapterGenre(expository.repeat(3)), "expository");
});
