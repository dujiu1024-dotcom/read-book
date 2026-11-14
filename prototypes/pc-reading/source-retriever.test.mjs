import test from "node:test";
import assert from "node:assert/strict";
import { createSourceRetriever } from "./source-retriever.js";

test("retrieves relevant passages across the book and excludes the current unit", () => {
  const units = [
    { id: "current", chapter: "第一章", title: "当前", text: "组织协作需要目标一致，并明确每个人的责任。" },
    { id: "related", chapter: "第二章", title: "共同目标", text: "团队目标一致，成员才能围绕同一方向协作。" },
    { id: "related-2", chapter: "第三章", title: "责任边界", text: "明确责任边界，才能减少协作中的重复劳动。" },
    { id: "unrelated", chapter: "第四章", title: "植物", text: "植物通过光合作用将光能转化为化学能。" }
  ];
  const retriever = createSourceRetriever(units);
  const result = retriever.retrieve("团队目标一致，如何明确责任？", "current", 2);
  assert.equal(result.length, 2);
  assert.ok(result.every((unit) => unit.id !== "current"));
  assert.ok(result.some((unit) => unit.id === "related"));
});

test("returns no sources for empty queries and respects the seven-source cap", () => {
  const units = Array.from({ length: 12 }, (_, index) => ({
    id: "unit-" + index,
    chapter: "章节" + index,
    title: "团队目标",
    text: "团队目标一致，成员围绕共同方向开展协作。"
  }));
  const retriever = createSourceRetriever(units);
  assert.deepEqual(retriever.retrieve("   ", "unit-0"), []);
  assert.ok(retriever.retrieve("团队目标一致", "unit-0", 20).length <= 7);
});
