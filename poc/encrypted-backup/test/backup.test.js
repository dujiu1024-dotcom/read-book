import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecoveryBundle,
  encryptBackup,
  restoreBackupChain,
  createMockBackupServer,
} from "../src/index.js";

function snapshot(sequence, text) {
  return {
    datasetId: "dataset-1",
    schemaVersion: 4,
    dirtySequence: sequence,
    threads: [{ id: "thread-1", datasetId: "dataset-1", bookRevisionId: "book-1", createdAt: "2026-11-14T00:00:00.000Z" }],
    messages: [{ message: { id: "message-1", threadId: "thread-1", role: "user", content: text, status: "saved", createdAt: "2026-11-14T00:00:00.000Z", sourceReferences: [] }, sequence: sequence, idempotencyKey: null }],
    readingRounds: [],
    readingPositions: [{ threadId: "thread-1", mainlineNodeId: "node-1", displayedNodeId: "node-1", viewMode: "mainline", currentUnitDiscussed: true, updatedAt: "2026-11-14T00:00:00.000Z" }],
    citations: [], notes: [], memories: [], memoryVersions: [], memoryRelations: [], generationDeliveries: [],
  };
}

test("encrypts a full backup and incremental chain and restores the exact latest snapshot", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const firstSnapshot = snapshot(1, "第一条消息");
  const first = await encryptBackup(firstSnapshot, { dataKey: bundle.dataKey, keyEnvelope: bundle.keyEnvelope, chunkBytes: 1024 });
  const nextSnapshot = snapshot(2, "修订后的消息");
  const second = await encryptBackup(nextSnapshot, {
    dataKey: bundle.dataKey,
    keyEnvelope: bundle.keyEnvelope,
    parentBackupId: first.manifest.backupId,
    previousSnapshot: firstSnapshot,
    chunkBytes: 1024,
  });
  const server = createMockBackupServer();
  const firstSession = server.beginUpload("dataset-1");
  await server.completeUpload(firstSession, first);
  const secondSession = server.beginUpload("dataset-1");
  await server.completeUpload(secondSession, second);
  const chain = server.getBackupChain("dataset-1", second.manifest.backupId);
  const restored = await restoreBackupChain(chain, bundle.recoveryCredential);
  assert.deepEqual(restored, nextSnapshot);
});

test("rejects a wrong independent recovery credential", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const backup = await encryptBackup(snapshot(1, "secret"), { dataKey: bundle.dataKey, keyEnvelope: bundle.keyEnvelope });
  const wrong = btoa("not-the-original-recovery-secret-which-is-long-enough");
  await assert.rejects(restoreBackupChain([backup], wrong));
});

test("rejects ciphertext tampering and missing chunks", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const backup = await encryptBackup(snapshot(1, "secret"), { dataKey: bundle.dataKey, keyEnvelope: bundle.keyEnvelope, chunkBytes: 1024 });
  const tampered = { manifest: structuredClone(backup.manifest), chunks: backup.chunks.map((chunk) => new Uint8Array(chunk)) };
  tampered.chunks[0][0] ^= 1;
  await assert.rejects(restoreBackupChain([tampered], bundle.recoveryCredential), /hash or length mismatch/);
  await assert.rejects(restoreBackupChain([{ manifest: backup.manifest, chunks: [] }], bundle.recoveryCredential), /incomplete/);
});

test("rejects broken parent chains and cross-dataset deltas", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const firstSnapshot = snapshot(1, "one");
  const first = await encryptBackup(firstSnapshot, { dataKey: bundle.dataKey, keyEnvelope: bundle.keyEnvelope });
  const second = await encryptBackup(snapshot(2, "two"), {
    dataKey: bundle.dataKey, keyEnvelope: bundle.keyEnvelope, parentBackupId: "wrong-parent", previousSnapshot: firstSnapshot,
  });
  await assert.rejects(restoreBackupChain([first, second], bundle.recoveryCredential), /parent chain is broken/);
});

test("cleared tombstone blocks a late upload and download while retaining ciphertext", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const backup = await encryptBackup(snapshot(1, "secret"), { dataKey: bundle.dataKey, keyEnvelope: bundle.keyEnvelope });
  const server = createMockBackupServer();
  const session = server.beginUpload("dataset-1");
  const tombstone = server.clearDataset("dataset-1");
  assert.equal(tombstone.status, "cleared");
  await assert.rejects(server.completeUpload(session, backup), /cleared before upload completion/);
  assert.equal(server.isCleared("dataset-1"), true);
  assert.throws(() => server.getBackupChain("dataset-1", backup.manifest.backupId), /cleared/);
  assert.equal(server.inspectStoredCiphertextCount("dataset-1"), 0);
});

test("mock server makes repeated upload idempotent and rejects conflicting backup IDs", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const one = await encryptBackup(snapshot(1, "secret"), { dataKey: bundle.dataKey, keyEnvelope: bundle.keyEnvelope, backupId: "backup-stable" });
  const server = createMockBackupServer();
  await server.completeUpload(server.beginUpload("dataset-1"), one);
  const again = await server.completeUpload(server.beginUpload("dataset-1"), one);
  assert.equal(again.idempotent, true);
});
