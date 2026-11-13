import test from "node:test";
import assert from "node:assert/strict";
import {
  DomainRuleError,
  advanceMainline,
  appendMemoryVersion,
  assertUniqueThreadPerRevision,
  createUserMessage,
  openNonMainlineView,
  returnToMainline,
  transitionAssistantMessage,
  type MemoryVersion,
  type ReadingPosition,
  type Thread,
} from "../src/index.ts";

const basePosition: ReadingPosition = {
  mainlineNodeId: "node-02",
  displayedNodeId: "node-02",
  viewMode: "mainline",
  currentUnitDiscussed: true,
};

test("one dataset and one book revision cannot have two long-lived Threads", () => {
  const threads: Thread[] = [
    { id: "t1", datasetId: "d1", bookRevisionId: "r1", createdAt: "2026-01-01" },
    { id: "t2", datasetId: "d1", bookRevisionId: "r2", createdAt: "2026-01-01" },
    { id: "t3", datasetId: "d2", bookRevisionId: "r1", createdAt: "2026-01-01" },
  ];
  assert.doesNotThrow(() => assertUniqueThreadPerRevision(threads));
  assert.throws(() => assertUniqueThreadPerRevision([...threads, {
    id: "t4", datasetId: "d1", bookRevisionId: "r1", createdAt: "2026-01-02",
  }]), DomainRuleError);
});

test("temporary view changes display only, never the mainline cursor", () => {
  const viewed = openNonMainlineView(basePosition, "temporary", "node-09");
  assert.equal(viewed.displayedNodeId, "node-09");
  assert.equal(viewed.mainlineNodeId, "node-02");
  assert.equal(returnToMainline(viewed).displayedNodeId, "node-02");
});

test("review and citation views also preserve the mainline cursor", () => {
  for (const mode of ["review", "citation"] as const) {
    const viewed = openNonMainlineView(basePosition, mode, "node-old");
    assert.equal(viewed.mainlineNodeId, "node-02");
    assert.equal(returnToMainline(viewed).mainlineNodeId, "node-02");
  }
});

test("mainline cannot advance from a non-mainline view", () => {
  const viewed = openNonMainlineView(basePosition, "temporary", "node-09");
  assert.throws(() => advanceMainline(viewed, "node-03", "discussed"), DomainRuleError);
});

test("an undiscussed mainline unit requires explicit skip confirmation", () => {
  const position = { ...basePosition, currentUnitDiscussed: false };
  assert.throws(() => advanceMainline(position, "node-03", "discussed"), DomainRuleError);
  assert.equal(advanceMainline(position, "node-03", "skip_confirmed").mainlineNodeId, "node-03");
});

test("discussed mainline unit advances explicitly and resets discussion state", () => {
  const next = advanceMainline(basePosition, "node-03", "discussed");
  assert.equal(next.mainlineNodeId, "node-03");
  assert.equal(next.displayedNodeId, "node-03");
  assert.equal(next.currentUnitDiscussed, false);
});

test("user input is created as saved before generation", () => {
  const message = createUserMessage({
    id: "m-user", threadId: "t1", content: "这是用户的原始表达",
    createdAt: "2026-11-13T00:00:00.000Z", sourceReferences: [],
  });
  assert.equal(message.role, "user");
  assert.equal(message.status, "saved");
  assert.throws(() => createUserMessage({
    id: "empty", threadId: "t1", content: "  ",
    createdAt: "2026-11-13T00:00:00.000Z", sourceReferences: [],
  }), DomainRuleError);
});

test("assistant generation may complete, fail or cancel", () => {
  const assistant = {
    id: "m-assistant", threadId: "t1", role: "assistant" as const,
    content: "", status: "generating" as const,
    createdAt: "2026-11-13T00:00:00.000Z", sourceReferences: [],
  };
  assert.equal(transitionAssistantMessage(assistant, "failed").status, "failed");
  assert.equal(transitionAssistantMessage(assistant, "cancelled").status, "cancelled");
  assert.equal(transitionAssistantMessage(assistant, "completed", "回应").content, "回应");
  assert.throws(() => transitionAssistantMessage(
    transitionAssistantMessage(assistant, "failed"), "completed",
  ), DomainRuleError);
});

test("first memory version is created as an immutable root", () => {
  const first: MemoryVersion = {
    id: "mv1", memoryId: "mem1", version: 1, previousVersionId: null,
    changeKind: "new", content: "初始认知", sourceMessageIds: ["m1"],
    sourceReferences: [], createdAt: "2026-11-13T00:00:00.000Z",
  };
  assert.deepEqual(appendMemoryVersion(null, first), first);
});

test("memory evolution appends a linked version and preserves the old version", () => {
  const first: MemoryVersion = {
    id: "mv1", memoryId: "mem1", version: 1, previousVersionId: null,
    changeKind: "new", content: "初始认知", sourceMessageIds: ["m1"],
    sourceReferences: [], createdAt: "2026-11-13T00:00:00.000Z",
  };
  const second: MemoryVersion = {
    id: "mv2", memoryId: "mem1", version: 2, previousVersionId: "mv1",
    changeKind: "correction", content: "修正后的认知", sourceMessageIds: ["m2"],
    sourceReferences: [], createdAt: "2026-11-14T00:00:00.000Z",
  };
  const appended = appendMemoryVersion(first, second);
  assert.equal(appended.previousVersionId, first.id);
  assert.equal(first.content, "初始认知");
  assert.throws(() => appendMemoryVersion(first, { ...second, previousVersionId: null }), DomainRuleError);
  assert.throws(() => appendMemoryVersion(first, { ...second, version: 3 }), DomainRuleError);
  assert.throws(() => appendMemoryVersion(first, { ...second, memoryId: "other" }), DomainRuleError);
});
