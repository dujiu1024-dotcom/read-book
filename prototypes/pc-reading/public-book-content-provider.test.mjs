import test from "node:test";
import assert from "node:assert/strict";
import { createPublicBookApiProvider, PublicBookApiError } from "./public-book-content-provider.js";

const revisionId = "11111111-1111-4111-8111-111111111111";
const chapterId = "22222222-2222-4222-8222-222222222222";
const unitA = "33333333-3333-4333-8333-333333333333";
const unitB = "44444444-4444-4444-8444-444444444444";

const revision = {
  id: revisionId, book_id: "55555555-5555-4555-8555-555555555555",
  title: "真实书籍标题", author: "作者", language: "zh-CN",
  status: "published", source_hash: "a".repeat(64),
  processing_version: "0.1.0", published_at: "2026-11-14T00:00:00.000Z",
};
const structure = {
  book_revision_id: revisionId,
  nodes: [
    { id: chapterId, book_revision_id: revisionId, parent_id: null, node_type: "chapter", title: "第一章", order_index: 0, source_locator: {} },
    { id: unitA, book_revision_id: revisionId, parent_id: chapterId, node_type: "argument_unit", title: "第一个论述单元", order_index: 0, source_locator: {} },
    { id: unitB, book_revision_id: revisionId, parent_id: chapterId, node_type: "argument_unit", title: "第二个论述单元", order_index: 1, source_locator: {} },
  ],
};

function createFetchMock() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/v1/book-revisions/" + revisionId)) {
      return new Response(JSON.stringify(revision), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).endsWith("/v1/book-revisions/" + revisionId + "/structure")) {
      return new Response(JSON.stringify(structure), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const nodeId = String(url).split("/nodes/")[1]?.split("/content")[0];
    if (nodeId === unitA || nodeId === unitB) {
      return new Response(JSON.stringify({
        book_revision_id: revisionId,
        structure_node_id: nodeId,
        content: nodeId === unitA ? "第一段原文" : "第二段原文",
        source_locator: nodeId === unitA ? { page_number: 8 } : { cfi: "epubcfi(/6/4)" },
        content_hash: "b".repeat(64),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("public provider loads revision, ordered structure and argument-unit content with bearer auth", async () => {
  const mock = createFetchMock();
  const provider = createPublicBookApiProvider({
    baseUrl: "https://api.example.test/",
    getAccessToken: async () => "test-token",
    fetchImpl: mock.fetchImpl,
    contentConcurrency: 2,
  });
  const loaded = await provider.loadBookRevision(revisionId);
  assert.equal(loaded.bookRevisionId, revisionId);
  assert.equal(loaded.title, "真实书籍标题");
  assert.equal(loaded.author, "作者");
  assert.equal(loaded.initialMainlineUnitId, unitA);
  assert.deepEqual(loaded.units.map((unit) => unit.id), [unitA, unitB]);
  assert.equal(loaded.units[0].chapter, "第一章");
  assert.equal(loaded.units[0].locator, "第8页");
  assert.equal(loaded.units[1].locator, "EPUB · epubcfi(/6/4)");
  assert.equal(mock.calls.length, 4);
  assert.ok(mock.calls.every((call) => call.options.headers.Authorization === "Bearer test-token"));
});

test("public provider rejects cross-revision structure and node content", async () => {
  const mock = createFetchMock();
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith("/structure")) {
      return new Response(JSON.stringify({ ...structure, book_revision_id: "different" }), { status: 200 });
    }
    return mock.fetchImpl(url, options);
  };
  const provider = createPublicBookApiProvider({
    baseUrl: "https://api.example.test",
    getAccessToken: async () => "token",
    fetchImpl,
  });
  await assert.rejects(() => provider.loadBookRevision(revisionId), /different BookRevision/);
});

test("public provider preserves API authorization errors and retryability", async () => {
  const provider = createPublicBookApiProvider({
    baseUrl: "https://api.example.test",
    getAccessToken: async () => "token",
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: "BOOK_ENTITLEMENT_REQUIRED", message: "尚未获得该版本访问权益", retryable: false },
      request_id: "66666666-6666-4666-8666-666666666666",
    }), { status: 403, headers: { "Content-Type": "application/json" } }),
  });
  await assert.rejects(
    () => provider.loadBookRevision(revisionId),
    (error) => error instanceof PublicBookApiError &&
      error.status === 403 &&
      error.code === "BOOK_ENTITLEMENT_REQUIRED" &&
      error.retryable === false,
  );
});

test("provider requires an injected access token and never invents credentials", async () => {
  const provider = createPublicBookApiProvider({
    baseUrl: "https://api.example.test",
    getAccessToken: async () => "",
    fetchImpl: async () => { throw new Error("must not fetch without token"); },
  });
  await assert.rejects(() => provider.loadBookRevision(revisionId), /access token/);
});
