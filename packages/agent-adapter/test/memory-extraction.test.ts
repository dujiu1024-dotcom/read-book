import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryExtractionError,
  runMemoryExtraction,
  type MemoryExtractionProviderInput,
} from "../src/memory-extraction.ts";

const context = {
  threadId: "thread-1",
  bookRevisionId: "book-revision-1",
  availableMessageIds: ["user-1", "assistant-1"],
  availableUserMessageIds: ["user-1"],
  availableStructureNodeIds: ["node-1"],
};

const candidate = {
  id: "candidate-1",
  title: "协同依赖共同目标",
  content: "沟通频率不能替代目标一致。",
  viewpoint: "user" as const,
  confidence: 0.94,
  ambiguity: 0.05,
  value: {
    novelty: 0.9,
    stability: 0.8,
    explanatoryPower: 0.9,
    discussionDepth: 0.8,
    relationStrength: 0.7,
  },
  sourceMessageIds: ["user-1"],
  sourceReferences: [],
  requiresBookCitation: false,
};

const policy = {
  weights: {
    novelty: 1,
    stability: 1,
    explanatoryPower: 1,
    discussionDepth: 1,
    relationStrength: 1,
  },
  minimumValueScore: 0.7,
  minimumConfidence: 0.8,
  maximumAmbiguity: 0.2,
  minimumSourceMessages: 1,
};

const messages = [
  { id: "user-1", role: "user" as const, content: "我认为沟通频率不能替代目标一致。" },
  { id: "assistant-1", role: "assistant" as const, content: "你区分了沟通动作与协同目标。" },
];

test("memory extraction evaluates provider candidates without persisting them", async () => {
  let providerInput: MemoryExtractionProviderInput | undefined;
  const result = await runMemoryExtraction({
    async extractStructured(input) {
      providerInput = input;
      return { candidates: [candidate] };
    },
  }, { context, messages, policy, modelVersion: "mock-v1" });

  assert.equal(result.modelVersion, "mock-v1");
  assert.equal(result.accepted.length, 1);
  assert.equal(result.needsConfirmation.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(providerInput?.messages.length, 2);
  assert.equal(providerInput?.outputSchema.type, "object");
});

test("memory extraction rejects a provider candidate outside the supplied message scope", async () => {
  await assert.rejects(
    runMemoryExtraction({
      async extractStructured() {
        return { candidates: [{ ...candidate, sourceMessageIds: ["other-user"] }] };
      },
    }, { context, messages, policy, modelVersion: "mock-v1" }),
    (error: unknown) => error instanceof MemoryExtractionError && /outside the supplied Thread context/.test(error.message),
  );
});

test("memory extraction requires declared message scope to match provider input", async () => {
  await assert.rejects(
    runMemoryExtraction({ async extractStructured() { return { candidates: [] }; } }, {
      context: { ...context, availableMessageIds: ["user-1"] },
      messages,
      policy,
      modelVersion: "mock-v1",
    }),
    /exactly match the declared Thread message scope/,
  );
});


test("memory extraction routes low-confidence candidates to confirmation instead of acceptance", async () => {
  const result = await runMemoryExtraction({
    async extractStructured() {
      return {
        candidates: [{
          ...candidate,
          confidence: 0.35,
          ambiguity: 0.1,
        }],
      };
    },
  }, { context, messages, policy, modelVersion: "mock-v1" });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.needsConfirmation.length, 1);
  assert.deepEqual(result.needsConfirmation[0].evaluation.reasons, ["low_confidence"]);
});

test("memory extraction allows an empty candidate result for ordinary conversation", async () => {
  const result = await runMemoryExtraction({
    async extractStructured() {
      return { candidates: [] };
    },
  }, { context, messages, policy, modelVersion: "mock-v1" });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.needsConfirmation.length, 0);
  assert.equal(result.rejected.length, 0);
});


test("persists accepted candidates only when an explicit immutable version plan is supplied", async () => {
  const { persistAcceptedMemoryCandidates } = await import("../src/memory-extraction.ts");
  const accepted = await runMemoryExtraction({
    async extractStructured() { return { candidates: [candidate] }; },
  }, { context, messages, policy, modelVersion: "mock-v1" });
  const writes: unknown[] = [];
  const repository = {
    async transaction(_datasetId: string, operation: (tx: any) => Promise<unknown>) {
      return operation({
        async appendMemoryVersion(version: unknown) { writes.push({ kind: "version", version }); },
        async appendMemoryRelation(relation: unknown) { writes.push({ kind: "relation", relation }); },
      });
    },
  };
  const ids = await persistAcceptedMemoryCandidates(repository, "dataset-1", accepted, [{
    candidateId: accepted.accepted[0].candidate.id, memoryId: "memory-1", version: 1, previousVersionId: null, changeKind: "new",
  }], () => "2026-11-14T00:00:00.000Z");
  assert.deepEqual(ids, [accepted.accepted[0].candidate.id]);
  assert.equal(writes.length, 1);
  assert.equal((writes[0] as any).version.viewpoint, "user");
  assert.equal((writes[0] as any).version.evaluationScore, accepted.accepted[0].evaluation.score);
  await assert.rejects(
    persistAcceptedMemoryCandidates(repository, "dataset-1", accepted, []),
    /Every accepted candidate needs exactly one plan/,
  );
});


test("memory persistence revalidates the evolution relation before writing", async () => {
  const { persistAcceptedMemoryCandidates, MemoryExtractionError } = await import("../src/memory-extraction.ts");
  const accepted = await runMemoryExtraction({
    async extractStructured() { return { candidates: [candidate] }; },
  }, { context, messages, policy, modelVersion: "mock-v1" });
  let writes = 0;
  const repository = {
    async transaction(_datasetId: string, operation: (tx: any) => Promise<unknown>) {
      return operation({
        async appendMemoryVersion() { writes += 1; },
        async appendMemoryRelation() { writes += 1; },
      });
    },
  };
  const previousVersion = {
    id: "version-1", memoryId: "memory-1", version: 1, previousVersionId: null,
    changeKind: "new" as const, content: "旧认知", sourceMessageIds: ["user-1"],
    sourceReferences: [], createdAt: "2026-11-13T00:00:00.000Z",
  };
  await assert.rejects(
    persistAcceptedMemoryCandidates(repository, "dataset-1", accepted, [{
      candidateId: accepted.accepted[0].candidate.id, memoryId: "memory-1", version: 2,
      previousVersionId: "version-1", previousVersion, changeKind: "conflict",
    }]),
    /requires a "contradicts" relation/,
  );
  assert.equal(writes, 0);
});
