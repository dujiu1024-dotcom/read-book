import test from "node:test";
import assert from "node:assert/strict";
import { selectThreadMemoryState } from "./memory-thread-scope.js";

test("limits memories, versions, relations, and pending candidates to the active Thread", () => {
  const snapshot = {
    memories: [
      { id: "memory-a", threadId: "thread-a" },
      { id: "memory-b", threadId: "thread-b" },
    ],
    memoryVersions: [
      { id: "version-a1", memoryId: "memory-a" },
      { id: "version-b1", memoryId: "memory-b" },
    ],
    memoryRelations: [
      { id: "relation-a", fromVersionId: "version-a1", toVersionId: "version-a0" },
      { id: "relation-b", fromVersionId: "version-b1", toVersionId: "version-b0" },
      { id: "relation-cross", fromVersionId: "version-a1", toVersionId: "version-b1" },
    ],
    memoryCandidates: [
      { id: "candidate-a", threadId: "thread-a" },
      { id: "candidate-b", threadId: "thread-b" },
    ],
  };

  const result = selectThreadMemoryState(snapshot, "thread-a");
  assert.deepEqual(result.memories.map((item) => item.id), ["memory-a"]);
  assert.deepEqual(result.versions.map((item) => item.id), ["version-a1"]);
  assert.deepEqual(result.relations, []);
  assert.deepEqual(result.pendingCandidates.map((item) => item.id), ["candidate-a"]);
});

test("keeps a relation only when both endpoints belong to the active Thread", () => {
  const snapshot = {
    memories: [{ id: "memory-a", threadId: "thread-a" }],
    memoryVersions: [
      { id: "version-a1", memoryId: "memory-a" },
      { id: "version-a2", memoryId: "memory-a" },
      { id: "version-b1", memoryId: "memory-b" },
    ],
    memoryRelations: [
      { id: "valid", fromVersionId: "version-a2", toVersionId: "version-a1" },
      { id: "cross-thread", fromVersionId: "version-a2", toVersionId: "version-b1" },
    ],
  };

  const result = selectThreadMemoryState(snapshot, "thread-a");
  assert.deepEqual(result.relations.map((item) => item.id), ["valid"]);
});

test("returns empty scoped collections when the Thread has no cognition", () => {
  const result = selectThreadMemoryState({
    memories: [{ id: "memory-b", threadId: "thread-b" }],
    memoryVersions: [{ id: "version-b", memoryId: "memory-b" }],
    memoryRelations: [],
    memoryCandidates: [{ id: "candidate-b", threadId: "thread-b" }],
  }, "thread-a");

  assert.deepEqual(result, { memories: [], versions: [], relations: [], pendingCandidates: [] });
});

test("rejects missing snapshots and invalid Thread IDs", () => {
  assert.throws(() => selectThreadMemoryState(null, "thread-a"), /snapshot/);
  assert.throws(() => selectThreadMemoryState({}, " "), /Thread ID/);
});
