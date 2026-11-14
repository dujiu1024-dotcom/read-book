import test from "node:test";
import assert from "node:assert/strict";
import {
  GenerationProtocolError,
  advanceGenerationEventCursor,
  authoritativeFinalResult,
  createGenerationClient,
  persistUserMessageBeforeGeneration,
  runGenerationTurn,
  validateGenerationAccepted,
  validateGenerationRequest,
  validateGenerationSnapshot,
  verifiedGenerationSourceReferences,
  verifiedGenerationCitationRecords,
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
  generation_id: "generation-1234567890",
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
          generation_id: "generation-1234567890",
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
  assert.equal(validateGenerationAccepted(accepted).generation_id, "generation-1234567890");
  assert.throws(() => validateGenerationAccepted({ ...accepted, status: "completed" }), GenerationProtocolError);
  assert.throws(() => validateGenerationSnapshot({
    generation_id: "generation-1234567890", status: "completed", expires_at: "2026-11-14T00:00:00.000Z", result: null,
  }), GenerationProtocolError);
  assert.throws(() => validateGenerationSnapshot({
    generation_id: "generation-1234567890", status: "cancel_requested", expires_at: "2026-11-14T00:00:00.000Z", result: null,
  }), GenerationProtocolError);
});

test("only a completed GET snapshot supplies the authoritative final result", () => {
  const running = validateGenerationSnapshot({
    generation_id: "generation-1234567890", status: "running", expires_at: "2026-11-14T00:00:00.000Z", result: null,
  });
  assert.equal(authoritativeFinalResult(running), null);
  const completed = validateGenerationSnapshot({
    generation_id: "generation-1234567890", status: "completed", expires_at: "2026-11-14T00:00:00.000Z",
    result: { content: "最终回答" },
  });
  assert.equal(authoritativeFinalResult(completed)?.content, "最终回答");
});

test("event cursor accepts contiguous events and ignores replayed duplicates", () => {
  const first = { event_id: "generation-1234567890:1", generation_id: "generation-1234567890", sequence: 1, type: "started" };
  const second = { event_id: "generation-1234567890:2", generation_id: "generation-1234567890", sequence: 2, type: "delta", text: "答" };
  const cursor = { generationId: "generation-1234567890", lastSequence: 0, lastEventId: null };
  const advanced = advanceGenerationEventCursor(cursor, first);
  assert.equal(advanced.cursor.lastSequence, 1);
  assert.equal(advanceGenerationEventCursor(advanced.cursor, first).duplicate, true);
  assert.equal(advanceGenerationEventCursor(advanced.cursor, second).cursor.lastSequence, 2);
  assert.throws(() => advanceGenerationEventCursor(advanced.cursor, {
    ...second, event_id: "generation-1234567890:4", sequence: 4,
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
  assert.equal(result.generation_id, "generation-1234567890");
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
  const event = { event_id: "generation-1234567890:1", generation_id: "generation-1234567890", sequence: 1, type: "started" };
  const fake = fakeTransport([event]);
  const client = createGenerationClient(fake.transport);
  await client.create(request, "idempotency-key-0001");
  await client.get("generation-1234567890");
  await client.cancel("generation-1234567890", "cancel-idempotency-key-0001");
  const cursor = { generationId: "generation-1234567890", lastSequence: 0, lastEventId: null };
  const seen: unknown[] = [];
  const nextCursor = await client.stream("generation-1234567890", cursor, new AbortController().signal, (item) => seen.push(item));
  assert.deepEqual(fake.calls, ["create", "get", "cancel", "stream:0"]);
  assert.equal(seen.length, 1);
  assert.equal(nextCursor.lastSequence, 1);
});

test("stream cursor advances across multiple events and rejects unknown event types", async () => {
  const events = [
    { event_id: "generation-1234567890:1", generation_id: "generation-1234567890", sequence: 1, type: "started" },
    { event_id: "generation-1234567890:2", generation_id: "generation-1234567890", sequence: 2, type: "delta", text: "答" },
  ];
  const fake = fakeTransport(events);
  const client = createGenerationClient(fake.transport);
  const seen: unknown[] = [];
  const next = await client.stream(
    "generation-1234567890",
    { generationId: "generation-1234567890", lastSequence: 0, lastEventId: null },
    new AbortController().signal,
    (event) => seen.push(event),
  );
  assert.equal(next.lastSequence, 2);
  assert.equal(seen.length, 2);
  assert.throws(() => advanceGenerationEventCursor(
    { generationId: "generation-1234567890", lastSequence: 0, lastEventId: null },
    { event_id: "e1", generation_id: "generation-1234567890", sequence: 1, type: "unknown" },
  ), /Unknown generation event type/);
});

test("rejects malformed result payloads and non-object relevant memory", () => {
  assert.throws(() => validateGenerationSnapshot({
    generation_id: "generation-1234567890",
    status: "completed",
    expires_at: "2026-11-14T00:00:00.000Z",
    result: { content: 42 },
  }), GenerationProtocolError);
  assert.throws(() => validateGenerationRequest({
    ...request,
    context: { ...request.context, relevant_memory: ["not-an-object"] as unknown as Array<Record<string, unknown>> },
  }), GenerationProtocolError);
});

function memoryTurnRepository() {
  const messages = new Map<string, { status: string; content: string }>();
  const deliveries = new Map<string, any>();
  const references = new Map<string, unknown[]>();
  const citations: unknown[] = [];
  let appendUserCount = 0;
  let appendAssistantCount = 0;
  const repository = {
    async transaction(_datasetId: string, operation: (tx: any) => Promise<unknown>) {
      return operation({
        async appendUserMessage(message: { id: string }) { appendUserCount += 1; return { message }; },
        async appendAssistantMessage(message: { id: string; content: string; status: string }) {
          appendAssistantCount += 1;
          messages.set(message.id, { status: message.status, content: message.content });
          return { message };
        },
        async transitionAssistantMessage(id: string, status: string, content = "", sourceReferences: unknown[] = []) {
          messages.set(id, { status, content });
          references.set(id, sourceReferences);
          return { id, status, content };
        },
        async saveCitation(citation: unknown) { citations.push(citation); return citation; },
        async saveGenerationDelivery(delivery: any) {
          deliveries.set(delivery.clientGenerationId, { ...delivery });
          return delivery;
        },
      });
    },
    async getGenerationDelivery(id: string) { return deliveries.get(id) ?? null; },
    async listPendingGenerationDeliveries() { return [...deliveries.values()].filter((d) => d.status === "queued" || d.status === "running"); },
    get counts() { return { appendUserCount, appendAssistantCount }; },
    messages,
    deliveries,
    references,
    citations,
  };
  return repository;
}

test("generation turn persists authoritative result and repeated submit reuses the same delivery", async () => {
  const repository = memoryTurnRepository();
  const calls = { create: 0, get: 0, stream: 0 };
  const client = createGenerationClient({
    async createGeneration() { calls.create += 1; return accepted; },
    async getGeneration() {
      calls.get += 1;
      return { generation_id: accepted.generation_id, status: "completed", expires_at: accepted.expires_at, result: { content: "权威最终内容" } };
    },
    async cancelGeneration() { return { ...accepted, status: "cancel_requested" }; },
    async streamEvents(_id, _after, _signal, onEvent) {
      calls.stream += 1;
      onEvent({ event_id: accepted.generation_id + ":1", generation_id: accepted.generation_id, sequence: 1, type: "started" });
      onEvent({ event_id: accepted.generation_id + ":2", generation_id: accepted.generation_id, sequence: 2, type: "delta", text: "临时流" });
    },
  });
  const input = {
    datasetId: "dataset-01",
    userMessage: { id: request.user_message.local_message_id, threadId: request.thread_id, content: request.user_message.content },
    assistantMessageId: "assistant-message-0001",
    request,
    idempotencyKey: "idempotency-key-0001",
    sourceReferences: [],
    signal: new AbortController().signal,
  };
  const first = await runGenerationTurn(repository as any, client, input);
  assert.equal(first.snapshot.result?.content, "权威最终内容");
  assert.deepEqual(repository.messages.get(input.assistantMessageId), { status: "completed", content: "权威最终内容" });
  assert.equal(repository.deliveries.get(request.client_generation_id).lastSequence, 2);
  const second = await runGenerationTurn(repository as any, client, input);
  assert.equal(second.snapshot.result?.content, "权威最终内容");
  assert.deepEqual(repository.counts, { appendUserCount: 1, appendAssistantCount: 1 });
  assert.deepEqual(calls, { create: 1, get: 2, stream: 1 });
});

test("ambiguous create failure leaves a queued receipt for idempotent recovery", async () => {
  const repository = memoryTurnRepository();
  const client = createGenerationClient({
    async createGeneration() { throw new Error("connection lost after request"); },
    async getGeneration() { throw new Error("not reached"); },
    async cancelGeneration() { return { ...accepted, status: "cancel_requested" }; },
    async streamEvents() {},
  });
  const input = {
    datasetId: "dataset-01",
    userMessage: { id: request.user_message.local_message_id, threadId: request.thread_id, content: request.user_message.content },
    assistantMessageId: "assistant-message-0002",
    request,
    idempotencyKey: "idempotency-key-0002",
    sourceReferences: [],
    signal: new AbortController().signal,
  };
  await assert.rejects(() => runGenerationTurn(repository as any, client, input), /connection lost/);
  assert.equal(repository.deliveries.get(request.client_generation_id).status, "queued");
  assert.equal(repository.messages.get(input.assistantMessageId).status, "generating");
  assert.deepEqual(repository.counts, { appendUserCount: 1, appendAssistantCount: 1 });
});


test("conversation controller resumes queued deliveries in its bound dataset", async () => {
  const repository = memoryTurnRepository();
  repository.deliveries.set(request.client_generation_id, {
    clientGenerationId: request.client_generation_id,
    generationId: null,
    threadId: request.thread_id,
    userMessageId: request.user_message.local_message_id,
    assistantMessageId: "assistant-message-recovery",
    idempotencyKey: "idempotency-key-recovery",
    status: "queued",
    lastSequence: 0,
    lastEventId: null,
    expiresAt: null,
    updatedAt: "2026-11-14T00:00:00.000Z",
  });
  repository.messages.set("assistant-message-recovery", { status: "generating", content: "" });
  const client = createGenerationClient({
    async createGeneration() { return accepted; },
    async getGeneration() {
      return {
        generation_id: accepted.generation_id,
        status: "completed",
        expires_at: accepted.expires_at,
        result: { content: "恢复后的权威结果" },
      };
    },
    async cancelGeneration() { return { ...accepted, status: "cancel_requested" }; },
    async streamEvents() {},
  });
  const controller = createGenerationTurnController(repository as any, client, "dataset-01");
  const results = await controller.resumePending(async () => request);
  assert.equal(results.length, 1);
  assert.equal(results[0].snapshot.result?.content, "恢复后的权威结果");
  assert.deepEqual(repository.messages.get("assistant-message-recovery"), {
    status: "completed",
    content: "恢复后的权威结果",
  });
  assert.equal(controller.isBusy(), false);
});

test("conversation controller rejects sends outside its bound dataset", async () => {
  const repository = memoryTurnRepository();
  const client = createGenerationClient({
    async createGeneration() { return accepted; },
    async getGeneration() { throw new Error("not reached"); },
    async cancelGeneration() { return { ...accepted, status: "cancel_requested" }; },
    async streamEvents() {},
  });
  const controller = createGenerationTurnController(repository as any, client, "dataset-01");
  await assert.rejects(() => controller.send({
    datasetId: "dataset-02",
    userMessage: {
      id: request.user_message.local_message_id,
      threadId: request.thread_id,
      content: request.user_message.content,
    },
    assistantMessageId: "assistant-cross-dataset",
    request,
    idempotencyKey: "idempotency-key-cross-dataset",
    sourceReferences: [],
  }), GenerationProtocolError);
  assert.deepEqual(repository.counts, { appendUserCount: 0, appendAssistantCount: 0 });
});


test("validates structured citations and rejects malformed citation identity", () => {
  const snapshot = validateGenerationSnapshot({
    generation_id: accepted.generation_id,
    status: "completed",
    expires_at: accepted.expires_at,
    result: {
      content: "带来源的回答",
      citations: [{
        book_revision_id: request.book_revision_id,
        structure_node_id: request.context.current_source.structure_node_id,
        locator: "epubcfi(/6/4!/4/2)",
        excerpt: "原文片段",
      }],
    },
  });
  assert.equal(snapshot.result?.citations?.length, 1);
  assert.throws(() => validateGenerationSnapshot({
    generation_id: accepted.generation_id,
    status: "completed",
    expires_at: accepted.expires_at,
    result: { content: "回答", citations: [{ book_revision_id: "invalid", structure_node_id: request.context.current_source.structure_node_id, locator: "x" }] },
  }), GenerationProtocolError);
});

test("only citations from the current BookRevision and current source node become persisted references", () => {
  const result = {
    content: "回答",
    citations: [
      { book_revision_id: request.book_revision_id, structure_node_id: request.context.current_source.structure_node_id, locator: "locator-1", excerpt: "当前原文片段" },
      { book_revision_id: request.book_revision_id, structure_node_id: "55555555-5555-4555-8555-555555555555", locator: "other-node", excerpt: "当前原文片段" },
      { book_revision_id: "66666666-6666-4666-8666-666666666666", structure_node_id: request.context.current_source.structure_node_id, locator: "other-book", excerpt: "当前原文片段" },
      { book_revision_id: request.book_revision_id, structure_node_id: request.context.current_source.structure_node_id, locator: "locator-1", excerpt: "当前原文片段" },
    ],
  };
  assert.deepEqual(verifiedGenerationSourceReferences(result, request), [{
    bookRevisionId: request.book_revision_id,
    structureNodeId: request.context.current_source.structure_node_id,
    locator: "locator-1",
  }]);
});


test("generation turn persists only service-verified citations for its current source", async () => {
  const repository = memoryTurnRepository();
  const client = createGenerationClient({
    async createGeneration() { return accepted; },
    async getGeneration() {
      return {
        generation_id: accepted.generation_id,
        status: "completed",
        expires_at: accepted.expires_at,
        result: {
          content: "带原文来源的最终回答",
          citations: [
            { book_revision_id: request.book_revision_id, structure_node_id: request.context.current_source.structure_node_id, locator: "locator-current", excerpt: "当前原文片段" },
            { book_revision_id: request.book_revision_id, structure_node_id: "55555555-5555-4555-8555-555555555555", locator: "locator-other-node" },
          ],
        },
      };
    },
    async cancelGeneration() { return { ...accepted, status: "cancel_requested" }; },
    async streamEvents() {},
  });
  await runGenerationTurn(repository as any, client, {
    datasetId: "dataset-01",
    userMessage: { id: request.user_message.local_message_id, threadId: request.thread_id, content: request.user_message.content },
    assistantMessageId: "assistant-message-citations",
    request,
    idempotencyKey: "idempotency-key-citations",
    sourceReferences: [],
    signal: new AbortController().signal,
  });
  assert.deepEqual(repository.references.get("assistant-message-citations"), [{
    bookRevisionId: request.book_revision_id,
    structureNodeId: request.context.current_source.structure_node_id,
    locator: "locator-current",
  }]);
  assert.equal(repository.citations.length, 1);
  assert.equal((repository.citations[0] as any).excerpt, "当前原文片段");
});


test("citation records require a quoted excerpt found in the current source text", () => {
  const result = {
    content: "回答",
    citations: [
      { book_revision_id: request.book_revision_id, structure_node_id: request.context.current_source.structure_node_id, locator: "valid", excerpt: "当前原文片段" },
      { book_revision_id: request.book_revision_id, structure_node_id: request.context.current_source.structure_node_id, locator: "fabricated", excerpt: "不存在的引用片段" },
    ],
  };
  const records = verifiedGenerationCitationRecords(result, request, "assistant-message-citation", request.thread_id, "2026-11-14T00:00:00.000Z");
  assert.equal(records.length, 1);
  assert.equal(records[0].excerpt, "当前原文片段");
  assert.equal(records[0].messageId, "assistant-message-citation");
});
