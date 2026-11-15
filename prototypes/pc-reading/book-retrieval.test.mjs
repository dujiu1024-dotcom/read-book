import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeQuestion,
  assessKeywordSpecificity,
  buildChunks,
  evaluateEvidence,
  keywordTerms,
  planPromptBudget,
  rrfFuse,
  selectRetrievalPassages,
  splitSentences,
  truncateAtSentence,
} from "./book-retrieval.js";

function unit(index, text, chapter = "卷上") {
  return {
    id: "unit-" + index,
    chapter,
    title: chapter + " · 第" + index + "段",
    locator: "source.txt#line-" + index,
    text,
  };
}

test("splitSentences keeps offsets and sentence boundaries", () => {
  const text = "知行合一。致良知！心即理？";
  const sentences = splitSentences(text);
  assert.equal(sentences.length, 3);
  assert.equal(sentences[1].text, "致良知！");
  assert.equal(text.slice(sentences[2].start, sentences[2].end), "心即理？");
});

test("buildChunks packs 300-600 characters at sentence boundaries with overlap", async () => {
  const long = "知是行的主意，行是知的功夫。" + "知是行之始，行是知之成。".repeat(12);
  const other = "心即理也，天下又有心外之事乎。" + "致吾心之良知于事事物物。".repeat(12);
  const units = [unit(1, long), unit(2, long), unit(3, other, "卷中"), unit(4, other, "卷中")];
  const chunks = await buildChunks(units, { bookRevisionId: "revision-1" });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.charLength >= 300, "chunk too short: " + chunk.charLength);
    assert.ok(chunk.charLength <= 600 * 1.35, "chunk too long: " + chunk.charLength);
  }
  for (const chunk of chunks) {
    assert.equal(chunk.structureNodeId, chunk.unitIds[0]);
    assert.ok(units.some((item) => item.id === chunk.structureNodeId));
  }
  const sameChapter = chunks.filter((chunk) => chunk.chapter === "卷上");
  if (sameChapter.length > 1) {
    const overlap = sameChapter[1].text.slice(0, 40);
    assert.ok(sameChapter[0].text.includes(overlap), "adjacent chunks should overlap");
  }
  const acrossChapter = chunks.findIndex((chunk) => chunk.chapter === "卷中");
  assert.ok(acrossChapter > 0);
  const before = chunks[acrossChapter - 1];
  const after = chunks[acrossChapter];
  assert.notEqual(before.chapter, after.chapter);
  assert.ok(!after.text.startsWith(before.text.slice(0, 40)), "overlap must not cross chapters");
});

test("buildChunks is deterministic for the same revision and units", async () => {
  const text = "知是行的主意，行是知的功夫。".repeat(30);
  const first = await buildChunks([unit(1, text)], { bookRevisionId: "revision-1" });
  const second = await buildChunks([unit(1, text)], { bookRevisionId: "revision-1" });
  assert.deepEqual(first.map((chunk) => chunk.id), second.map((chunk) => chunk.id));
});

test("analyzeQuestion routes explicit whole-book questions to retrieval", () => {
  assert.equal(analyzeQuestion("全书里作者如何论述知行合一？").mode, "book");
  assert.equal(analyzeQuestion("作者在书中哪些地方谈到心即理？").mode, "book");
  assert.equal(analyzeQuestion("这段话里的“行”是什么意思？").mode, "current");
  assert.equal(analyzeQuestion("我不同意这个说法，行不是知的结果。").mode, "current");
});

test("keywordTerms keeps Chinese bigrams and trigrams without a dictionary", () => {
  const terms = keywordTerms("知行合一与致良知的关系是什么？");
  assert.ok(terms.includes("知行"));
  assert.ok(terms.includes("合一"));
  assert.ok(!terms.includes("什么"));
});

test("rrfFuse prefers chunks recalled by both channels", () => {
  const scores = rrfFuse([["a", "b", "c"], ["c", "d"]]);
  assert.ok(scores.get("c") > scores.get("a"));
  assert.ok(scores.get("a") > scores.get("d"));
});

test("evaluateEvidence refuses vector-only guesses below the threshold", () => {
  assert.equal(evaluateEvidence({ keywordHits: [{ chunk: { id: "x" } }], vectorHits: [] }).hasEvidence, true);
  assert.equal(evaluateEvidence({ keywordHits: [], vectorHits: [{ id: "x", score: 0.64 }] }).hasEvidence, true);
  assert.equal(evaluateEvidence({ keywordHits: [], vectorHits: [{ id: "x", score: 0.41 }] }).hasEvidence, false);
});

test("selectRetrievalPassages deduplicates units and reports omissions", () => {
  const hits = [
    { chunk: { id: "c1", structureNodeId: "u1", text: "甲".repeat(500), locator: "l1", chapter: "卷上" }, score: 0.9 },
    { chunk: { id: "c2", structureNodeId: "u1", text: "乙".repeat(500), locator: "l1", chapter: "卷上" }, score: 0.8 },
    { chunk: { id: "c3", structureNodeId: "u2", text: "丙".repeat(500), locator: "l2", chapter: "卷中" }, score: 0.7 },
  ];
  const result = selectRetrievalPassages(hits, { limit: 1 });
  assert.equal(result.passages.length, 1);
  assert.equal(result.passages[0].chunk.id, "c1");
  assert.ok(result.omitted >= 2);
});

test("planPromptBudget drops the oldest chat before current source", () => {
  const plan = planPromptBudget({
    currentUnit: { text: "当前原文。".repeat(10) },
    passages: [{ chunk: { id: "c" }, excerpt: "检索片段。".repeat(10), score: 1 }],
    messages: [
      { role: "user", content: "很旧的一条消息。".repeat(40) },
      { role: "assistant", content: "最新回复。".repeat(10) },
    ],
    memories: [{ title: "认知", content: "记忆内容。".repeat(10) }],
    maxMessageCharacters: 200,
  });
  assert.equal(plan.messages.length, 1);
  assert.ok(plan.notices.some((notice) => notice.includes("较早")));
});

test("assessKeywordSpecificity drops generic high-frequency terms", () => {
  const chunks = Array.from({ length: 20 }, (_, index) => ({
    text: index < 10 ? "我们讨论过这个关系，书中也有说明。" : "知行合一，致良知。",
  }));
  const result = assessKeywordSpecificity("书里有没有红烧肉", chunks, ["讨论", "关系", "书中", "红烧", "烧肉"]);
  assert.deepEqual(result.strongTerms, []);
  const positive = assessKeywordSpecificity("知行合一", chunks, ["知行", "合一"]);
  assert.ok(positive.strongTerms.includes("知行"));
});

test("truncateAtSentence ends on a sentence boundary", () => {
  const result = truncateAtSentence("第一句。第二句。第三句。", 10);
  assert.equal(result.truncated, true);
  assert.ok(result.text.endsWith("。"));
});
