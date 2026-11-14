import test from "node:test";
import assert from "node:assert/strict";
import {
  GenerationProtocolError,
  advanceGenerationEventCursor,
  authoritativeFinalResult,
  createGenerationClient,
  persistUserMessageBeforeGeneration,
  validateGenerationAccepted,
  validateGenerationRequest,
  validateGenerationSnapshot,
  type GenerationRequest,
} from "../src/index.ts";

const request: GenerationRequest = {
  client_generation_id: "client-generation-0001",
  thread_id: "11111111-1111-4111-8111-111111111111",
  book_revision_id: "22222222-2222-4222-8222-222222222222",
  user_message: { local_message_id: "33333333-3333-4333-8333-333333333333", content: "用户原始表达" },
  context: {
    current_source: { structure_node_id: "44444444-4444-4444-8444-444444444444", excerpt: "当前原文片段" },
    recent_messages: [{ role: "user", content: "之前的讨论" }],
    relevant_memory: [],
  },
};

const accepted = {
  generation_id: "generation-1",
  status: "queued",
  expires_at: "2026-11-14T00:00:00.000Z",
};

function fakeTransport(events: unknown[] = []) {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async createGeneration() { calls.push("create"); return accepted; },
      async getGeneration() {
        calls.push("get");
        return {
          generation_id: "generation-1",
          status: "completed",
          expires_at: "2026-11-14T00:00:00.000Z",
          result: { content: "最终回答" },
        };
      },
      async cancelGeneration() { calls.push("cancel"); return { ...accepted, status: "cancel_requested" }; },
      async streamEvents(_id: string, after: number, _signal: AbortSignal, onEvent: (event: unknown) => void) {
        calls.push(`stream:${after}`);
        for (const event of events) onEvent(event);
      },
    },
  };
}

test("validates the GenerationRequest contract and rejects oversized context", () => {
  assert.doesNotThrow(() => validateGenerationRequest(request));
  assert.throws(() => validateGenerationRequest({
    ...request,
    context: { ...request.context, recent_messages: Array.from({ length: 31 }, () => ({ role: "user", content: "x" })) },
  }), GenerationProtocolError);
  assert.throws(() => validateGenerationRequest({
    ...request,
    client_generation_id: "short",
  }), GenerationProtocolError);
});

test("validates accepted and final task snapshots", () => {
  assert.equal(validateGenerationAccepted(accepted).generation_id, "generation-1");
  assert.throws(() => validateGenerationAccepted({ ...accepted, status: "completed" }), GenerationProtocolError);
  assert.throws(() => validateGenerationSnapshot({
    generation_id: "generation-1", status: "completed", expires_at: "2026-11-14T00:00:00.000Z", result: null,
  }), GenerationProtocolError);
  assert.throws(() => validateGenerationSnapshot({
    generation_id: "generation-1", status: "cancel_requested", expires_at: "2026-11-14T00:00:00.000Z", result: null,
  }), GenerationProtocolError);
});

test("only a completed GET snapshot supplies the authoritative final result", () => {
  const running = validateGenerationSnapshot({
    generation_id: "generation-1", status: "running", expires_at: "2026-11-14T00:00:00.000Z", result: null,
  });
  assert.equal(authoritativeFinalResult(running), null);
  const completed = validateGenerationSnapshot({
    generation_id: "generation-1", status: "completed", expires_at: "2026-11-14T00:00:00.000Z",
    result: { content: "最终回答" },
  });
  assert.equal(authoritativeFinalResult(completed)?.content, "最终回答");
});

test("event cursor accepts contiguous events and ignores replayed duplicates", () => {
  const first = { event_id: "generation-1:1", generation_id: "generation-1", sequence: 1, type: "started" };
  const second = { event_id: "generation-1:2", generation_id: "generation-1", sequence: 2, type: "delta", text: "答" };
  const cursor = { generationId: "generation-1", lastSequence: 0, lastEventId: null };
  const advanced = advanceGenerationEventCursor(cursor, first);
  assert.equal(advanced.cursor.lastSequence, 1);
  assert.equal(advanceGenerationEventCursor(advanced.cursor, first).duplicate, true);
  assert.equal(advanceGenerationEventCursor(advanced.cursor, second).cursor.lastSequence, 2);
  assert.throws(() => advanceGenerationEventCursor(advanced.cursor, {
    ...second, event_id: "generation-1:4", sequence: 4,
  }), /sequence gap/);
  assert.throws(() => advanceGenerationEventCursor(cursor, {
    ...first, generation_id: "another-generation",
  }), /different generation/);
});

test("persists the user message before creating a generation task", async () => {
  const calls: string[] = [];
  const client = createGenerationClient({
    async createGeneration() { calls.push("network"); return accepted; },
    async getGeneration() { return {}; },
    async cancelGeneration() { return accepted; },
    async streamEvents() {},
  });
  const repository = {
    async saveUserMessage() { calls.push("persist"); },
  };
  const result = await persistUserMessageBeforeGeneration(
    repository, client,
    { id: "33333333-3333-4333-8333-333333333333", threadId: "11111111-1111-4111-8111-111111111111", content: "用户原始表达" },
    request,
    "idempotency-key-0001",
  );
  assert.deepEqual(calls, ["persist", "network"]);
  assert.equal(result.generation_id, "generation-1");
});

test("does not call the network when local persistence fails or message ids mismatch", async () => {
  let networkCalls = 0;
  const client = createGenerationClient({
    async createGeneration() { networkCalls += 1; return accepted; },
    async getGeneration() { return {}; },
    async cancelGeneration() { return accepted; },
    async streamEvents() {},
  });
  const message = { id: "33333333-3333-4333-8333-333333333333", threadId: "11111111-1111-4111-8111-111111111111", content: "用户原始表达" };
  await assert.rejects(() => persistUserMessageBeforeGeneration(
    { async saveUserMessage() { throw new Error("quota exceeded"); } },
    client, message, request, "idempotency-key-0001",
  ), /quota exceeded/);
  await assert.rejects(() => persistUserMessageBeforeGeneration(
    { async saveUserMessage() {} },
    client, { ...message, id: "wrong-id" }, request, "idempotency-key-0001",
  ), GenerationProtocolError);
  assert.equal(networkCalls, 0);
});

test("client delegates create, get, cancel and resumes events after the saved sequence", async () => {
  const event = { event_id: "generation-1:1", generation_id: "generation-1", sequence: 1, type: "started" };
  const fake = fakeTransport([event]);
  const client = createGenerationClient(fake.transport);
  await client.create(request, "idempotency-key-0001");
  await client.get("generation-1");
  await client.cancel("generation-1", "cancel-key-0001");
  const cursor = { generationId: "generation-1", lastSequence: 0, lastEventId: null };
  const seen: unknown[] = [];
  const nextCursor = await client.stream("generation-1", cursor, new AbortController().signal, (item) => seen.push(item));
  assert.deepEqual(fake.calls, ["create", "get", "cancel", "stream:0"]);
  assert.equal(seen.length, 1);
  assert.equal(nextCursor.lastSequence, 1);
});

test("stream cursor advances across multiple events and rejects unknown event types", async () => {
  const events = [
    { event_id: "generation-1:1", generation_id: "generation-1", sequence: 1, type: "started" },
    { event_id: "generation-1:2", generation_id: "generation-1", sequence: 2, type: "delta", text: "答" },
  ];
  const fake = fakeTransport(events);
  const client = createGenerationClient(fake.transport);
  const seen: unknown[] = [];
  const next = await client.stream(
    "generation-1",
    { generationId: "generation-1", lastSequence: 0, lastEventId: null },
    new AbortController().signal,
    (event) => seen.push(event),
  );
  assert.equal(next.lastSequence, 2);
  assert.equal(seen.length, 2);
  assert.throws(() => advanceGenerationEventCursor(
    { generationId: "generation-1", lastSequence: 0, lastEventId: null },
    { event_id: "e1", generation_id: "generation-1", sequence: 1, type: "unknown" },
  ), /Unknown generation event type/);
});

test("rejects malformed result payloads and non-object relevant memory", () => {
  assert.throws(() => validateGenerationSnapshot({
    generation_id: "generation-1",
    status: "completed",
    expires_at: "2026-11-14T00:00:00.000Z",
    result: { content: 42 },
  }), GenerationProtocolError);
  assert.throws(() => validateGenerationRequest({
    ...request,
    context: { ...request.context, relevant_memory: ["not-an-object"] as unknown as Array<Record<string, unknown>> },
  }), GenerationProtocolError);
});
