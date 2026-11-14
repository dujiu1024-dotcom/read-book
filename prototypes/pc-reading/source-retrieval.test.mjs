import test from "node:test";
import assert from "node:assert/strict";
import { createBookSourceSearch, tokenizeSourceText } from "./source-retrieval.js";

const units = [
  { id: "unit-1", title: "知行合一", chapter: "第一章", text: "知是行的主意，行是知的功夫。知行本不可分离。" },
  { id: "unit-2", title: "致良知", chapter: "第二章", text: "良知是心之本体，发而为意念。" },
  { id: "unit-3", title: "格物", chapter: "第三章", text: "格物是即物穷理，在事上磨炼。" },
  { id: "unit-4", title: "知行关系", chapter: "第四章", text: "知行合一不是先知后行，而是在行动中完成认识。" },
  { id: "unit-5", title: "无关内容", chapter: "第五章", text: "山川草木，各有其自然变化。" },
];

test("tokenizes Chinese bigrams and trigrams and English terms", () => {
  const tokens = tokenizeSourceText("知行合一 Agent workflow");
  assert.ok(tokens.includes("知行"));
  assert.ok(tokens.includes("知行合"));
  assert.ok(tokens.includes("agent"));
  assert.ok(tokens.includes("workflow"));
});

test("retrieves related source nodes from the same book and excludes the current unit", () => {
  const search = createBookSourceSearch(units);
  const results = search("知行合一如何理解", "unit-1", 7);
  assert.ok(results.some((unit) => unit.id === "unit-4"));
  assert.ok(results.every((unit) => unit.id !== "unit-1"));
  assert.ok(results.every((unit) => units.some((candidate) => candidate.id === unit.id)));
});

test("returns deterministic ranked results and caps the result count at seven", () => {
  const manyUnits = Array.from({ length: 20 }, (_, index) => ({
    id: "unit-" + index,
    title: "知行关系",
    chapter: "第" + index + "章",
    text: "知行合一与致良知的关系。",
  }));
  const search = createBookSourceSearch(manyUnits);
  const first = search("知行合一", "unit-0", 20).map((unit) => unit.id);
  const second = search("知行合一", "unit-0", 20).map((unit) => unit.id);
  assert.deepEqual(first, second);
  assert.equal(first.length, 7);
  assert.equal(first.includes("unit-0"), false);
});

test("returns no candidates for an empty or unmatched query", () => {
  const search = createBookSourceSearch(units);
  assert.deepEqual(search("", "unit-1"), []);
  assert.deepEqual(search("quantum spacecraft", "unit-1"), []);
});
