import test from "node:test";
import assert from "node:assert/strict";
import { createSourceRetriever } from "./source-retriever.js";

const units = [
  { id: "u1", locator: "1", chapter: "第一章", title: "知行合一", text: "知是行的主意，行是知的功夫。知行本不可分离。" },
  { id: "u2", locator: "2", chapter: "第二章", title: "致良知", text: "良知是心之本体，发而为意念。" },
  { id: "u3", locator: "3", chapter: "第三章", title: "格物", text: "格物是即物穷理，在事上磨炼。" },
  { id: "u4", locator: "4", chapter: "第四章", title: "知行关系", text: "知行合一不是先知后行，而是在行动中完成认识。" },
  { id: "u5", locator: "5", chapter: "第五章", title: "无关内容", text: "山川草木，各有其自然变化。" },
];

test("retrieves related Chinese source nodes and excludes the current unit", () => {
  const retriever = createSourceRetriever(units);
  const results = retriever.retrieve("知行合一如何理解", "u1");
  assert.ok(results.some((unit) => unit.id === "u4"));
  assert.ok(results.every((unit) => unit.id !== "u1"));
  assert.ok(results.every((unit) => units.some((candidate) => candidate.id === unit.id)));
});

test("normalizes full-width English and matches metadata", () => {
  const retriever = createSourceRetriever([
    ...units,
    { id: "u6", locator: "6", chapter: "附录", title: "Ａｇｅｎｔ 工作流", text: "这里讨论自动执行任务。" },
  ]);
  const results = retriever.retrieve("agent workflow", "u1");
  assert.equal(results[0]?.id, "u6");
});

test("supports Chinese trigrams and English terms in the same query", () => {
  const retriever = createSourceRetriever(units);
  const results = retriever.retrieve("知行合一 Agent workflow", "u5");
  assert.ok(results.some((unit) => unit.id === "u1" || unit.id === "u4"));
});

test("caps results at seven and remains deterministic", () => {
  const manyUnits = Array.from({ length: 20 }, (_, index) => ({
    id: "unit-" + index,
    locator: "loc-" + index,
    chapter: "第" + (index % 4) + "章",
    title: "知行关系",
    text: "知行合一与致良知的关系。",
  }));
  const retriever = createSourceRetriever(manyUnits);
  const first = retriever.retrieve("知行合一", "unit-0", 100).map((unit) => unit.id);
  const second = retriever.retrieve("知行合一", "unit-0", 100).map((unit) => unit.id);
  assert.deepEqual(first, second);
  assert.ok(first.length <= 7);
  assert.equal(first.includes("unit-0"), false);
});

test("returns no result for empty or unmatched queries and invalid limits", () => {
  const retriever = createSourceRetriever(units);
  assert.deepEqual(retriever.retrieve("", "u1"), []);
  assert.deepEqual(retriever.retrieve("quantum spacecraft", "u1"), []);
  assert.deepEqual(retriever.retrieve("知行合一", "u1", 0), []);
});

test("ignores malformed units and duplicate unit identifiers", () => {
  const retriever = createSourceRetriever([
    ...units,
    { id: "u1", locator: "duplicate", chapter: "重复", title: "错误记录", text: "不应重复参与排序" },
    { id: "broken", chapter: "缺少正文", text: "" },
    { id: "missing-locator", text: "缺少定位" },
  ]);
  assert.equal(retriever.documentCount, units.length);
  assert.ok(retriever.retrieve("知行合一", "u5").every((unit) => unit.id !== "u1" || unit.locator === "1"));
});
