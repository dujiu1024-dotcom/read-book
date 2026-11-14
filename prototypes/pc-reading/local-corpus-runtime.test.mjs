import test from "node:test";
import assert from "node:assert/strict";
import { createLocalCorpusRuntime } from "./local-corpus-runtime.js";

function fakeRepository() {
  const threads = new Map();
  const positions = new Map();
  return {
    threads, positions,
    async initialize() {},
    async transaction(datasetId, operation) {
      return operation({
        async getThreadByRevision(revisionId) {
          return [...threads.values()].find((thread) => thread.bookRevisionId === revisionId) || null;
        },
        async createThread(thread) {
          threads.set(thread.id, thread);
          return thread;
        },
        async createConsistentSnapshot() {
          return { readingPositions: [...positions.values()] };
        },
        async saveReadingPosition(position) {
          positions.set(position.threadId, position);
        }
      });
    },
    async createConsistentSnapshot(datasetId) {
      return { datasetId, readingPositions: [...positions.values()] };
    },
    async close() {}
  };
}

test("creates a local Thread and restores its saved mainline position", async () => {
  const repository = fakeRepository();
  const bookRevision = {
    bookRevisionId: "github-corpus-chuanxilu-0123456789abcdefabcd",
    initialMainlineUnitId: "unit-1"
  };
  const runtime = await createLocalCorpusRuntime(bookRevision, {
    datasetId: "test-dataset",
    repositoryFactory: () => repository,
    now: () => "2026-11-14T00:00:00.000Z"
  });
  assert.equal(runtime.readingPosition.mainlineNodeId, "unit-1");
  assert.equal(runtime.backupStatus.label, "备份未配置");
  await runtime.savePosition({
    mainlineIndex: 1, displayedUnit: { id: "unit-2" }, viewMode: "temporary", discussed: true
  }, [{ id: "unit-1" }, { id: "unit-2" }]);
  assert.equal(repository.positions.get(runtime.thread.id).displayedNodeId, "unit-2");
  assert.equal(repository.positions.get(runtime.thread.id).viewMode, "temporary");
  const reopened = await createLocalCorpusRuntime(bookRevision, {
    datasetId: "test-dataset",
    repositoryFactory: () => repository,
    now: () => "2026-11-14T00:01:00.000Z"
  });
  assert.equal(reopened.thread.id, runtime.thread.id);
  assert.equal(reopened.readingPosition.displayedNodeId, "unit-2");
  assert.equal(reopened.readingPosition.viewMode, "temporary");
});

test("uses a separate local Thread for each immutable BookRevision", async () => {
  const repository = fakeRepository();
  const first = await createLocalCorpusRuntime({ bookRevisionId: "revision-a", initialMainlineUnitId: "a" }, {
    datasetId: "test-dataset",
    repositoryFactory: () => repository
  });
  const second = await createLocalCorpusRuntime({ bookRevisionId: "revision-b", initialMainlineUnitId: "b" }, {
    repositoryFactory: () => repository
  });
  assert.notEqual(first.thread.id, second.thread.id);
  assert.equal(repository.threads.size, 2);
});
