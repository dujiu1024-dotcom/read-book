import test from "node:test";
import assert from "node:assert/strict";
import { createHttpGenerationTransport, GenerationTransportError } from "../src/http-transport.ts";

const accepted = {
  generation_id: "generation-1234567890",
  status: "queued",
  expires_at: "2026-11-14T00:00:00.000Z",
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("create, get and cancel use the OpenAPI paths, bearer token and idempotency headers", async () => {
  const calls = [];
  const transport = createHttpGenerationTransport({
    baseUrl: "https://api.example.test/",
    getAccessToken: async () => "short-lived-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/v1/generations")) return jsonResponse(accepted, 202);
      if (String(url).endsWith("/cancel")) return jsonResponse({ ...accepted, status: "cancel_requested" }, 202);
      return jsonResponse({ ...accepted, status: "completed", result: { content: "final" } });
    },
  });
  await transport.createGeneration({ client_generation_id: "client-generation-1234" } as never, "create-idempotency-123");
  await transport.getGeneration("generation-1234567890");
  await transport.cancelGeneration("generation-1234567890", "cancel-idempotency-123");

  assert.equal(calls[0].url, "https://api.example.test/v1/generations");
  assert.equal(calls[0].init.headers.Authorization, "Bearer short-lived-token");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "create-idempotency-123");
  assert.equal(calls[1].url, "https://api.example.test/v1/generations/generation-1234567890");
  assert.equal(calls[2].url, "https://api.example.test/v1/generations/generation-1234567890/cancel");
  assert.equal(calls[2].init.headers["Idempotency-Key"], "cancel-idempotency-123");
});

test("SSE resumes after the last processed sequence and validates id/event/data frames", async () => {
  const events = [
    { event_id: "generation-1:4", sequence: 4, generation_id: "generation-1", type: "delta", text: "你好" },
    { event_id: "generation-1:5", sequence: 5, generation_id: "generation-1", type: "completed", result_available: true },
  ];
  const body = events.map((event) =>
    `id: ${event.event_id}\r\nevent: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`
  ).join("");
  let requestedUrl = "";
  const transport = createHttpGenerationTransport({
    baseUrl: "https://api.example.test",
    getAccessToken: async () => "token",
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
    },
  });
  const seen = [];
  await transport.streamEvents("generation-1", 3, new AbortController().signal, (event) => seen.push(event));
  assert.equal(requestedUrl, "https://api.example.test/v1/generations/generation-1/events?after=3");
  assert.deepEqual(seen, events);
});

test("SSE rejects event IDs or names that do not match the JSON payload", async () => {
  const event = { event_id: "id-1", sequence: 1, generation_id: "generation-1", type: "started" };
  const body = `id: wrong-id\nevent: started\ndata: ${JSON.stringify(event)}\n\n`;
  const transport = createHttpGenerationTransport({
    baseUrl: "https://api.example.test",
    getAccessToken: async () => "token",
    fetchImpl: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
  });
  await assert.rejects(
    () => transport.streamEvents("generation-1", 0, new AbortController().signal, () => undefined),
    /SSE id does not match/,
  );
});

test("API errors preserve status, code, request ID and retryability", async () => {
  const transport = createHttpGenerationTransport({
    baseUrl: "https://api.example.test",
    getAccessToken: async () => "token",
    fetchImpl: async () => jsonResponse({
      error: { code: "GENERATION_BUSY", message: "稍后重试", retryable: true },
      request_id: "77777777-7777-4777-8777-777777777777",
    }, 503),
  });
  await assert.rejects(
    () => transport.getGeneration("generation-1"),
    (error) => error instanceof GenerationTransportError &&
      error.status === 503 &&
      error.code === "GENERATION_BUSY" &&
      error.requestId === "77777777-7777-4777-8777-777777777777" &&
      error.retryable === true,
  );
});

test("aborted SSE stream exits without emitting incomplete data", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode("id: incomplete\nevent: delta\ndata: {"));
    },
    pull(ctrl) {
      controller.abort();
      ctrl.close();
    },
  });
  const transport = createHttpGenerationTransport({
    baseUrl: "https://api.example.test",
    getAccessToken: async () => "token",
    fetchImpl: async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
  });
  const seen = [];
  await transport.streamEvents("generation-1", 0, controller.signal, (event) => seen.push(event));
  assert.deepEqual(seen, []);
});
