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
  validateMemoryEvolution,
  validateMemoryExtractionResult,
  validateMemoryRelation,
  type MemoryCandidate,
  type MemoryRelation,
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

test("user input draft is created before the persistence boundary", () => {
  const message = createUserMessage({
    id: "m-user", threadId: "t1", content: "这是用户的原始表达",
    createdAt: "2026-11-13T00:00:00.000Z", sourceReferences: [],
  });
  assert.equal(message.role, "user");
  assert.equal("status" in message, false);
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
  assert.throws(() => transitionAssistantMessage(assistant, "generating"), DomainRuleError);
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

const extractionContext = {
  threadId: "thread-1",
  bookRevisionId: "revision-1",
  availableMessageIds: ["user-1", "assistant-1"],
  availableUserMessageIds: ["user-1"],
  availableStructureNodeIds: ["node-1"],
};

const validCandidate: MemoryCandidate = {
  id: "candidate-1",
  title: "先建立边界再优化",
  content: "用户倾向先明确问题边界，再进行局部优化。",
  viewpoint: "user",
  confidence: 0.92,
  ambiguity: 0.08,
  value: {
    novelty: 0.8, stability: 0.7, explanatoryPower: 0.85,
    discussionDepth: 0.75, relationStrength: 0.7,
  },
  sourceMessageIds: ["user-1"],
  sourceReferences: [],
  requiresBookCitation: false,
};

test("structured extraction output is limited to supplied messages and user provenance", () => {
  assert.deepEqual(
    validateMemoryExtractionResult({ candidates: [validCandidate] }, extractionContext),
    [validCandidate],
  );
  assert.throws(() => validateMemoryExtractionResult({
    candidates: [{ ...validCandidate, sourceMessageIds: ["unknown-message"] }],
  }, extractionContext), DomainRuleError);
  assert.throws(() => validateMemoryExtractionResult({
    candidates: [{ ...validCandidate, sourceMessageIds: ["assistant-1"] }],
  }, extractionContext), /original user message/);
});

test("book-based and author-viewpoint candidates require a citation in the active revision", () => {
  assert.throws(() => validateMemoryExtractionResult({
    candidates: [{ ...validCandidate, viewpoint: "author", requiresBookCitation: false }],
  }, extractionContext), /author viewpoint/);
  assert.throws(() => validateMemoryExtractionResult({
    candidates: [{ ...validCandidate, requiresBookCitation: true }],
  }, extractionContext), /Book Citation/);
  const cited = {
    ...validCandidate,
    viewpoint: "author" as const,
    requiresBookCitation: true,
    sourceReferences: [{
      bookRevisionId: "revision-1", structureNodeId: "node-1", locator: "EPUB CFI 1",
    }],
  };
  assert.doesNotThrow(() => validateMemoryExtractionResult({ candidates: [cited] }, extractionContext));
  assert.throws(() => validateMemoryExtractionResult({
    candidates: [{ ...cited, sourceReferences: [{
      bookRevisionId: "revision-2", structureNodeId: "node-1", locator: "EPUB CFI 1",
    }] }],
  }, extractionContext), /different BookRevision/);
  assert.throws(() => validateMemoryExtractionResult({
    candidates: [{ ...cited, sourceReferences: [{
      bookRevisionId: "revision-1", structureNodeId: "unknown-node", locator: "EPUB CFI 1",
    }] }],
  }, extractionContext), /outside the supplied BookRevision/);
});

test("one extraction batch rejects duplicate candidates and excessive candidate count", () => {
  assert.throws(() => validateMemoryExtractionResult({
    candidates: [validCandidate, { ...validCandidate, id: "candidate-2" }],
  }, extractionContext), /Duplicate candidates/);
  assert.throws(() => validateMemoryExtractionResult({
    candidates: Array.from({ length: 11 }, (_, index) => ({ ...validCandidate, id: "candidate-" + index })),
  }, extractionContext), /at most 10/);
});

function memoryVersion(changeKind: MemoryVersion["changeKind"], version = 2): MemoryVersion {
  return {
    id: "version-" + version,
    memoryId: "memory-1",
    version,
    previousVersionId: version === 1 ? null : "version-1",
    changeKind,
    content: "认知内容 " + changeKind,
    sourceMessageIds: ["user-1"],
    sourceReferences: [],
    createdAt: "2026-11-14T00:00:00.000Z",
  };
}

function relationFor(version: MemoryVersion, relationType: MemoryRelation["relationType"]): MemoryRelation {
  return {
    id: "relation-" + relationType,
    fromVersionId: version.id,
    toVersionId: "version-other",
    relationType,
    sourceMessageIds: ["user-1"],
    sourceReferences: [],
    createdAt: "2026-11-14T00:00:01.000Z",
  };
}

test("all six memory change kinds have explicit append and relation rules", () => {
  const first = memoryVersion("new", 1);
  assert.doesNotThrow(() => validateMemoryEvolution(null, first));

  assert.doesNotThrow(() => validateMemoryEvolution(
    first, memoryVersion("supplement"), null,
  ));
  assert.doesNotThrow(() => validateMemoryEvolution(
    first, memoryVersion("correction"), relationFor(memoryVersion("correction"), "supersedes"),
  ));
  assert.doesNotThrow(() => validateMemoryEvolution(
    first, memoryVersion("conflict"), relationFor(memoryVersion("conflict"), "contradicts"),
  ));
  assert.doesNotThrow(() => validateMemoryEvolution(
    first, memoryVersion("rejection"), relationFor(memoryVersion("rejection"), "retracts"),
  ));
  assert.doesNotThrow(() => validateMemoryEvolution(
    first, memoryVersion("extension"), relationFor(memoryVersion("extension"), "extends"),
  ));

  assert.throws(() => validateMemoryEvolution(
    first, memoryVersion("conflict"), null,
  ), /requires a "contradicts" relation/);
  assert.throws(() => validateMemoryEvolution(
    first, memoryVersion("rejection"), relationFor(memoryVersion("rejection"), "supports"),
  ), /cannot use relation/);
  assert.throws(() => validateMemoryEvolution(
    null, memoryVersion("new", 1), relationFor(memoryVersion("new", 1), "supports"),
  ), /cannot use relation/);
});

test("memory relations require distinct endpoints and original source provenance", () => {
  const relation = relationFor(memoryVersion("conflict"), "contradicts");
  assert.deepEqual(validateMemoryRelation(relation), relation);
  assert.throws(() => validateMemoryRelation({
    ...relation, toVersionId: relation.fromVersionId,
  }), /cannot point to itself/);
  assert.throws(() => validateMemoryRelation({
    ...relation, sourceMessageIds: [],
  }), /requires source message provenance/);
  assert.throws(() => validateMemoryEvolution(
    memoryVersion("new", 1), memoryVersion("conflict"),
    { ...relation, sourceMessageIds: ["another-user-message"] },
  ), /provenance must overlap/);
});
