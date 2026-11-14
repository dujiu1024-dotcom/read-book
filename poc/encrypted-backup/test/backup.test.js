import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecoveryBundle,
  createBackupPayload,
  encryptBackup,
  restoreBackupChain,
  restoreBackupChainWithKey,
  createRestoredForkIdentity,
  createMockBackupServer,
  uploadBackupResumable,
  shouldCreateFullCheckpoint,
} from "../src/index.js";

const identity = { deviceId: "device-1", lineageId: "lineage-1", forkId: "fork-1" };

function snapshot(sequence, text, options = {}) {
  return {
    datasetId: options.datasetId ?? "dataset-1",
    identity: options.identity ?? identity,
    schemaVersion: 4,
    dirtySequence: sequence,
    backupJournal: options.backupJournal ?? Array.from({ length: sequence }, (_, index) => ({
      sequence: index + 1, entityType: "message", entityId: "message-1", operation: "upsert",
      changedAt: "2026-11-14T00:00:0" + (index + 1) + ".000Z",
    })),
    threads: [{ id: "thread-1", datasetId: "dataset-1", bookRevisionId: "book-1", createdAt: "2026-11-14T00:00:00.000Z" }],
    messages: [{ message: { id: "message-1", threadId: "thread-1", role: "user", content: text, status: "saved", createdAt: "2026-11-14T00:00:00.000Z", sourceReferences: [] }, sequence: sequence, idempotencyKey: null }],
    readingRounds: [],
    readingRoundStates: [], readingUnitProgress: [], presentedSources: [],
    readingPositions: [{ threadId: "thread-1", mainlineNodeId: "node-1", displayedNodeId: "node-1", viewMode: "mainline", currentUnitDiscussed: true, updatedAt: "2026-11-14T00:00:00.000Z" }],
    citations: [], notes: [], memories: [], memoryVersions: [], memoryRelations: [], memoryCandidates: [], generationDeliveries: [],
  };
}

function keyOptions(bundle, extra = {}) {
  return { dataKey: bundle.dataKey, keyEnvelope: bundle.keyEnvelope, ...extra };
}

test("encrypts a full backup and incremental chain and restores the exact latest snapshot", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const firstSnapshot = snapshot(1, "第一条消息");
  const first = await encryptBackup(firstSnapshot, keyOptions(bundle, { chunkBytes: 1024, backupSequence: 1 }));
  const nextSnapshot = snapshot(2, "修订后的消息");
  const second = await encryptBackup(nextSnapshot, keyOptions(bundle, {
    parentBackupId: first.manifest.backupId,
    previousSnapshot: firstSnapshot,
    backupSequence: 2,
    previousBackupSequence: 1,
    chunkBytes: 1024,
  }));
  const server = createMockBackupServer();
  await uploadBackupResumable(server, first);
  await uploadBackupResumable(server, second);
  const chain = server.getBackupChain("dataset-1", second.manifest.backupId);
  const restored = await restoreBackupChain(chain, bundle.recoveryCredential);
  assert.deepEqual(restored, nextSnapshot);
});

test("rejects a wrong independent recovery credential", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const backup = await encryptBackup(snapshot(1, "secret"), keyOptions(bundle, { backupSequence: 1 }));
  const wrong = btoa("not-the-original-recovery-secret-which-is-long-enough");
  await assert.rejects(restoreBackupChain([backup], wrong));
});

test("rejects ciphertext tampering and missing chunks", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const backup = await encryptBackup(snapshot(1, "secret"), keyOptions(bundle, { chunkBytes: 1024, backupSequence: 1 }));
  const tampered = { manifest: structuredClone(backup.manifest), chunks: backup.chunks.map((chunk) => new Uint8Array(chunk)) };
  tampered.chunks[0][0] ^= 1;
  await assert.rejects(restoreBackupChain([tampered], bundle.recoveryCredential), /hash or length mismatch/);
  await assert.rejects(restoreBackupChain([{ manifest: backup.manifest, chunks: [] }], bundle.recoveryCredential), /incomplete/);
});

test("rejects broken parent chains and cross-dataset deltas", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const firstSnapshot = snapshot(1, "one");
  const first = await encryptBackup(firstSnapshot, keyOptions(bundle, { backupSequence: 1 }));
  const second = await encryptBackup(snapshot(2, "two"), keyOptions(bundle, {
    parentBackupId: "wrong-parent", previousSnapshot: firstSnapshot,
    backupSequence: 2, previousBackupSequence: 1,
  }));
  await assert.rejects(restoreBackupChain([first, second], bundle.recoveryCredential), /parent chain is broken/);
});

test("cleared tombstone blocks a late upload and download while retaining ciphertext", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const backup = await encryptBackup(snapshot(1, "secret"), keyOptions(bundle, { backupSequence: 1 }));
  const server = createMockBackupServer();
  await server.completeUpload(server.beginUpload("dataset-1"), backup);
  const session = server.beginUpload("dataset-1");
  server.uploadChunk(session, 0, backup.chunks[0]);
  const tombstone = server.clearDataset("dataset-1");
  assert.equal(tombstone.status, "cleared");
  await assert.rejects(server.completeUpload(session, backup), /cleared before upload completion/);
  assert.equal(server.isCleared("dataset-1"), true);
  assert.throws(() => server.getBackupChain("dataset-1", backup.manifest.backupId), /cleared/);
  assert.equal(server.inspectStoredCiphertextCount("dataset-1"), 1);
});

test("mock server makes repeated upload idempotent and rejects conflicting backup IDs", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const one = await encryptBackup(snapshot(1, "secret"), keyOptions(bundle, { backupSequence: 1, backupId: "backup-stable" }));
  const server = createMockBackupServer();
  await server.completeUpload(server.beginUpload("dataset-1"), one);
  const again = await server.completeUpload(server.beginUpload("dataset-1"), one);
  assert.equal(again.idempotent, true);
});

test("resumes a partially uploaded backup without retransmitting accepted chunks", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const backup = await encryptBackup(snapshot(1, "large payload ".repeat(500)), keyOptions(bundle, {
    chunkBytes: 1024, backupSequence: 1,
  }));
  const server = createMockBackupServer();
  const session = server.beginUpload("dataset-1");
  server.uploadChunk(session, 0, backup.chunks[0]);
  const progressBefore = server.getUploadProgress(session);
  assert.deepEqual(progressBefore, [0]);
  const receipt = await uploadBackupResumable(server, backup, session);
  assert.equal(receipt.backupId, backup.manifest.backupId);
  assert.deepEqual(server.getBackupChain("dataset-1", backup.manifest.backupId).length, 1);
});

test("creates full checkpoints at the configured interval", () => {
  assert.equal(shouldCreateFullCheckpoint(9, 10), false);
  assert.equal(shouldCreateFullCheckpoint(10, 10), true);
  assert.equal(shouldCreateFullCheckpoint(0, 1), false);
});


test("device backup key is a non-extractable HKDF CryptoKey", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  assert.equal(bundle.dataKey.algorithm.name, "HKDF");
  assert.equal(bundle.dataKey.extractable, false);
});

test("incremental payload is journal-driven and fails closed when the journal is incomplete", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const firstSnapshot = snapshot(1, "第一版");
  const first = await encryptBackup(firstSnapshot, keyOptions(bundle, { backupSequence: 1 }));
  const nextSnapshot = snapshot(2, "第二版");
  const next = await encryptBackup(nextSnapshot, keyOptions(bundle, {
    parentBackupId: first.manifest.backupId, previousSnapshot: firstSnapshot,
    backupSequence: 2, previousBackupSequence: 1,
  }));
  const restored = await restoreBackupChain([first, next], bundle.recoveryCredential);
  assert.deepEqual(restored, nextSnapshot);

  assert.throws(() => createBackupPayload(snapshot(3, "第三版", { backupJournal: [] }), nextSnapshot),
    /does not cover/);
  const missingEntityJournal = [{
    sequence: 3, entityType: "message", entityId: "message-1", operation: "upsert",
    changedAt: "2026-11-14T00:00:03.000Z",
  }];
  const changedWithExtraRecord = snapshot(3, "第三版", { backupJournal: missingEntityJournal });
  changedWithExtraRecord.notes = [{ id: "note-1", content: "未入 journal", updatedAt: "2026-11-14T00:00:03.000Z" }];
  assert.throws(() => createBackupPayload(changedWithExtraRecord, nextSnapshot),
    /missing an entry for notes:note-1/);
});

test("backupSequence increments independently from dirtySequence and is part of the manifest", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const firstSnapshot = snapshot(1, "one");
  const first = await encryptBackup(firstSnapshot, keyOptions(bundle, { backupSequence: 5 }));
  assert.equal(first.manifest.backupSequence, 5);
  assert.equal(first.manifest.dirtySequence, 1);
  const second = await encryptBackup(snapshot(2, "two"), keyOptions(bundle, {
    parentBackupId: first.manifest.backupId, previousSnapshot: firstSnapshot,
    backupSequence: 6, previousBackupSequence: 5,
  }));
  assert.equal(second.manifest.backupSequence, 6);
  await assert.rejects(encryptBackup(snapshot(3, "three"), keyOptions(bundle, {
    parentBackupId: second.manifest.backupId, previousSnapshot: snapshot(2, "two"),
    backupSequence: 9, previousBackupSequence: 6,
  })), /increment by exactly one/);
});

test("cross-device restore starts a new fork without colliding with the source fork", async () => {
  const bundle = await createRecoveryBundle("dataset-1", undefined, { iterations: 100_000 });
  const source = await encryptBackup(snapshot(1, "源设备"), keyOptions(bundle, { backupSequence: 1 }));
  const restored = await restoreBackupChainWithKey([source], bundle.recoveryCredential);
  assert.equal(restored.identity.forkId, source.manifest.forkId);
  const forkIdentity = createRestoredForkIdentity(source.manifest, "device-2");
  assert.equal(forkIdentity.lineageId, source.manifest.lineageId);
  assert.notEqual(forkIdentity.forkId, source.manifest.forkId);
  const restoredSnapshot = snapshot(1, "恢复设备继续", { identity: forkIdentity });
  const fork = await encryptBackup(restoredSnapshot, keyOptions(bundle, {
    backupSequence: 1, identity: forkIdentity,
  }));
  const server = createMockBackupServer();
  await uploadBackupResumable(server, source);
  await uploadBackupResumable(server, fork);
  assert.equal(server.listBackups("dataset-1").length, 2);
  assert.equal(server.listBackupsForFork(source.manifest.lineageId, source.manifest.forkId).length, 1);
  assert.equal(server.listBackupsForFork(forkIdentity.lineageId, forkIdentity.forkId).length, 1);
});
