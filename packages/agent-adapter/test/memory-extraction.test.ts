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
