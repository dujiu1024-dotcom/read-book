import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleMemoryProvider } from "../src/openai-compatible-memory-provider.ts";

function response(content: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
}

test("extraction provider sends JSON Schema mode and returns structured content", async () => {
  let request: any;
  const provider = new OpenAICompatibleMemoryProvider({
    baseUrl: "https://example.test/v1", apiKey: "secret", model: "test-model",
    fetchImpl: async (_url, init) => { request = JSON.parse(String(init?.body)); return response({ candidates: [] }); }
  });
  const result = await provider.extractStructured({
    instruction: "只抽取",
    context: { threadId: "t", bookRevisionId: "b", availableMessageIds: ["m"], availableUserMessageIds: ["m"], availableStructureNodeIds: [] },
    messages: [{ id: "m", role: "user", content: "原文" }],
    outputSchema: { type: "object", properties: { candidates: { type: "array" } } }
  });
  assert.deepEqual(result, { candidates: [] });
  assert.equal(request.model, "test-model");
  assert.equal(request.response_format.type, "json_schema");
  assert.equal(request.response_format.json_schema.strict, true);
});

test("evolution provider maps strict proposals to the planner contract", async () => {
  const provider = new OpenAICompatibleMemoryProvider({
    baseUrl: "https://example.test", apiKey: "secret", model: "test-model",
    fetchImpl: async () => response({ proposals: [{
      candidate_id: "candidate-1", change_kind: "correction",
      target_memory_id: "memory-1", duplicate_of_memory_id: null, rationale: "明确修正"
    }] })
  });
  const proposals = await provider.propose({
    candidates: [{ id: "candidate-1", title: "新", content: "内容", viewpoint: "user", confidence: 0.9, ambiguity: 0.1, sourceReferences: [] } as any],
    existingLatestVersions: [{ id: "version-1", memoryId: "memory-1", version: 1, content: "旧", sourceMessageIds: [], sourceReferences: [], createdAt: "2026-11-13T00:00:00.000Z", changeKind: "new" } as any]
  });
  assert.deepEqual(proposals, [{
    candidateId: "candidate-1", changeKind: "correction", targetMemoryId: "memory-1", rationale: "明确修正"
  }]);
});

test("provider rejects invalid endpoints, HTTP errors and malformed structured output", async () => {
  assert.throws(() => new OpenAICompatibleMemoryProvider({ baseUrl: "file:///tmp", apiKey: "x", model: "m" }), /HTTP/);
  const failed = new OpenAICompatibleMemoryProvider({
    baseUrl: "https://example.test", apiKey: "secret", model: "m",
    fetchImpl: async () => new Response("no", { status: 503 })
  });
  await assert.rejects(failed.extractStructured({
    instruction: "x", context: {} as any, messages: [], outputSchema: {}
  }), /HTTP 503/);
  const malformed = new OpenAICompatibleMemoryProvider({
    baseUrl: "https://example.test", apiKey: "secret", model: "m",
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 })
  });
  await assert.rejects(malformed.extractStructured({
    instruction: "x", context: {} as any, messages: [], outputSchema: {}
  }), /malformed JSON/);
});
