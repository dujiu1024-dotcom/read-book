import test from "node:test";
import assert from "node:assert/strict";
import {
  RepositoryError,
  assertDataSetSequenceInvariant,
  createAgentUserMessageRepository,
  createRepositoryBackupPort,
  type LocalRepositoryTransaction,
} from "../src/index.ts";

test("Agent user-message port resolves only after the repository transaction commits", async () => {
  const events: string[] = [];
  const tx = {
    async appendUserMessage(message: { id: string; threadId: string; content: string }) {
      events.push("insert:" + message.id);
      return {} as never;
    },
  } as unknown as LocalRepositoryTransaction;
  const repository = {
    async transaction<T>(_datasetId: string, operation: (transaction: LocalRepositoryTransaction) => Promise<T>) {
      events.push("begin");
      const result = await operation(tx);
      events.push("commit");
      return result;
    },
  };
  const port = createAgentUserMessageRepository(repository, "dataset-1", (input) => ({
    ...input,
    createdAt: "2026-11-14T00:00:00.000Z",
    sourceReferences: [],
  }));
  await port.saveUserMessage({
    id: "message-1",
    threadId: "thread-1",
    content: "用户原始表达",
  });
  events.push("resolved");
  assert.deepEqual(events, ["begin", "insert:message-1", "commit", "resolved"]);
});

test("Agent user-message port propagates transaction failure without reporting a saved message", async () => {
  let committed = false;
  const tx = {
    async appendUserMessage() { throw new Error("quota exceeded"); },
  } as unknown as LocalRepositoryTransaction;
  const port = createAgentUserMessageRepository({
    async transaction<T>(_datasetId: string, operation: (transaction: LocalRepositoryTransaction) => Promise<T>) {
      const result = await operation(tx);
      committed = true;
      return result;
    },
  }, "dataset-1", (input) => ({
    ...input,
    createdAt: "2026-11-14T00:00:00.000Z",
    sourceReferences: [],
  }));
  await assert.rejects(() => port.saveUserMessage({
    id: "message-2",
    threadId: "thread-1",
    content: "不可丢失的输入",
  }), /quota exceeded/);
  assert.equal(committed, false);
});

test("dataset backup sequence invariant rejects impossible acknowledgement state", () => {
  assert.doesNotThrow(() => assertDataSetSequenceInvariant({
    id: "dataset-1", schemaVersion: 4,
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    dirtySequence: 10, lastAckedSequence: 8,
    lastBackupId: null, lastBackupAt: null, lifecycleStatus: "active",
  }));
  assert.throws(() => assertDataSetSequenceInvariant({
    id: "dataset-1", schemaVersion: 4,
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    dirtySequence: 7, lastAckedSequence: 8,
    lastBackupId: null, lastBackupAt: null, lifecycleStatus: "active",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "INTEGRITY_FAILED");
});

test("binding revocation contract is soft-delete only and cannot imply dataset deletion", async () => {
  const calls: string[] = [];
  const tx = {
    async softRevokeAccountDataSetBinding(bindingId: string, revokedAt: string) {
      calls.push("revoke:" + bindingId + ":" + revokedAt);
      return true;
    },
  } as unknown as LocalRepositoryTransaction;
  const repository = {
    async transaction<T>(_datasetId: string, operation: (transaction: LocalRepositoryTransaction) => Promise<T>) {
      return operation(tx);
    },
  };
  await repository.transaction("dataset-1", (transaction) =>
    transaction.softRevokeAccountDataSetBinding("binding-1", "2026-11-14T00:00:00.000Z"));
  assert.deepEqual(calls, ["revoke:binding-1:2026-11-14T00:00:00.000Z"]);
});

test("backup port acknowledges only the sequence from its own consistent snapshot", async () => {
  const calls: unknown[][] = [];
  const snapshot = {
    datasetId: "dataset-1",
    schemaVersion: 3,
    dirtySequence: 12,
    threads: [], messages: [], readingRounds: [], readingPositions: [], presentedSources: [], readingUnitProgress: [],
    citations: [], notes: [], memories: [], memoryVersions: [], memoryRelations: [], memoryCandidates: [], generationDeliveries: [],
  };
  const port = createRepositoryBackupPort({
    async createConsistentSnapshot(datasetId: string) {
      calls.push(["snapshot", datasetId]);
      return snapshot;
    },
    async acknowledgeBackup(datasetId: string, sequence: number, backupId: string, backedUpAt: string) {
      calls.push(["ack", datasetId, sequence, backupId, backedUpAt]);
    },
  }, "dataset-1");
  const created = await port.createSnapshot();
  await port.acknowledgeUploadedSnapshot(created, "backup-12", "2026-11-14T00:00:00.000Z");
  assert.deepEqual(calls, [
    ["snapshot", "dataset-1"],
    ["ack", "dataset-1", 12, "backup-12", "2026-11-14T00:00:00.000Z"],
  ]);
  await assert.rejects(() => port.acknowledgeUploadedSnapshot({ ...snapshot, datasetId: "dataset-2" }, "backup-12", "2026-11-14T00:00:00.000Z"), RepositoryError);
});
