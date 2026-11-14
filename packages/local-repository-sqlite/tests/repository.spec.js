import { test, expect } from "@playwright/test";

const datasetA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const datasetB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const revision = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const threadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const messageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("SQLite OPFS commits Thread and UserMessage, allocates sequence and survives a new Repository instance", async ({ page }) => {
  await page.goto("/");
  const first = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createThread({
        id: ids.threadId,
        datasetId: ids.datasetA,
        bookRevisionId: ids.revision,
        createdAt: "2026-11-14T00:00:00.000Z",
      });
      await tx.appendUserMessage({
        id: ids.messageId,
        threadId: ids.threadId,
        content: "用户原始表达必须先保存",
        createdAt: "2026-11-14T00:00:01.000Z",
        sourceReferences: [],
        idempotencyKey: "message-once",
      });
    });
    const messages = await repository.getMessages(ids.datasetA, ids.threadId);
    const dataset = await repository.getDataSet(ids.datasetA);
    await repository.close();
    return { messages, dataset };
  }, { datasetA, revision, threadId, messageId });

  expect(first.messages).toHaveLength(1);
  expect(first.messages[0].sequence).toBe(1);
  expect(first.messages[0].message.content).toBe("用户原始表达必须先保存");
  expect(first.dataset.dirtySequence).toBe(1);

  const restored = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    const messages = await repository.getMessages(ids.datasetA, ids.threadId);
    const dataset = await repository.getDataSet(ids.datasetA);
    await repository.close();
    return { messages, dataset };
  }, { datasetA, threadId });

  expect(restored.messages).toHaveLength(1);
  expect(restored.messages[0].message.id).toBe(messageId);
  expect(restored.dataset.dirtySequence).toBe(1);
});

test("SQLite OPFS enforces dataset isolation and unique Thread per BookRevision", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    let duplicateRejected = false;
    await repository.transaction(ids.datasetA, async (tx) => {
      const existing = await tx.getThreadByRevision(ids.revision);
      if (!existing) {
        await tx.createThread({
          id: ids.threadId,
          datasetId: ids.datasetA,
          bookRevisionId: ids.revision,
          createdAt: "2026-11-14T00:00:00.000Z",
        });
      }
    });
    try {
      await repository.transaction(ids.datasetA, async (tx) => {
        await tx.createThread({
          id: ids.otherThreadId,
          datasetId: ids.datasetA,
          bookRevisionId: ids.revision,
          createdAt: "2026-11-14T00:00:02.000Z",
        });
      });
    } catch { duplicateRejected = true; }
    const crossDatasetMessages = await repository.getMessages(ids.datasetB, ids.threadId);
    await repository.close();
    return { duplicateRejected, crossDatasetMessages };
  }, { datasetA, datasetB, revision, threadId, otherThreadId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });

  expect(result.duplicateRejected).toBe(true);
  expect(result.crossDatasetMessages).toHaveLength(0);
});

test("failed transaction rolls back all writes and does not advance dirtySequence", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    let failed = false;
    try {
      await repository.transaction(ids.datasetA, async (tx) => {
        await tx.createThread({
          id: ids.threadId,
          datasetId: ids.datasetA,
          bookRevisionId: ids.revision,
          createdAt: "2026-11-14T00:00:00.000Z",
        });
        throw new Error("force rollback");
      });
    } catch { failed = true; }
    const found = await repository.transaction(ids.datasetA, (tx) => tx.getThreadByRevision(ids.revision));
    const dataset = await repository.getDataSet(ids.datasetA);
    await repository.close();
    return { failed, found, dirtySequence: dataset.dirtySequence };
  }, { datasetA, revision, threadId });

  expect(result.failed).toBe(true);
  expect(result.found).toBeNull();
  expect(result.dirtySequence).toBe(0);
});

test("account binding revocation clears account authorization but preserves the local dataset", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createAccountDataSetBinding({
        id: ids.bindingId,
        accountId: ids.accountId,
        localDataSetId: ids.datasetA,
        status: "active",
        boundAt: "2026-11-14T00:00:00.000Z",
        lastSelectedAt: null,
        revokedAt: null,
      });
    });
    await repository.transaction(ids.datasetA, async (tx) => {
      const before = await tx.getAccountDataSetBinding(ids.bindingId);
      if (!before || before.accountId !== ids.accountId) throw new Error("binding seed failed");
      const revoked = await tx.softRevokeAccountDataSetBinding(ids.bindingId, "2026-11-14T00:01:00.000Z");
      if (!revoked) throw new Error("binding revoke did not update the row");
    });
    const after = await repository.transaction(ids.datasetA, (tx) => tx.getAccountDataSetBinding(ids.bindingId));
    const dataset = await repository.getDataSet(ids.datasetA);
    await repository.close();
    return { after, dataset };
  }, {
    datasetA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    bindingId: "99999999-9999-4999-8999-999999999999",
    accountId: "88888888-8888-4888-8888-888888888888",
  });
  expect(result.after.status).toBe("revoked");
  expect(result.after.accountId).toBeNull();
  expect(result.after.revokedAt).toBe("2026-11-14T00:01:00.000Z");
  expect(result.dataset).not.toBeNull();
});

test("message source references cannot cross immutable BookRevision boundaries", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    let rejected = false;
    try {
      await repository.transaction(ids.datasetA, async (tx) => {
        await tx.createThread({
          id: ids.threadId,
          datasetId: ids.datasetA,
          bookRevisionId: ids.revision,
          createdAt: "2026-11-14T00:00:00.000Z",
        });
        await tx.appendUserMessage({
          id: ids.messageId,
          threadId: ids.threadId,
          content: "引用不应跨版本",
          createdAt: "2026-11-14T00:00:01.000Z",
          sourceReferences: [{
            bookRevisionId: ids.otherRevision,
            structureNodeId: "node-1",
            locator: "epubcfi(/6/2)",
          }],
        });
      });
    } catch { rejected = true; }
    const messages = await repository.getMessages(ids.datasetA, ids.threadId);
    await repository.close();
    return { rejected, messages };
  }, {
    datasetA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revision: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    otherRevision: "77777777-7777-4777-8777-777777777777",
    threadId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  });
  expect(result.rejected).toBe(true);
  expect(result.messages).toHaveLength(0);
});


test("schema v1 to v6 migration preserves legacy dataset cursors and creates candidate storage", async ({ page }) => {
  await page.goto("/");
  const seeded = await page.evaluate(async () => {
    const worker = new Worker("/tests/legacy-db.worker.js", { type: "module" });
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage({ type: "seed-v1" });
    });
  });
  expect(seeded.ok).toBe(true);

  const migrated = await page.evaluate(async () => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    const dataset = await repository.getDataSet("legacy-v1-dataset");
    // Querying the v5 table verifies the final migration created it, not only the version marker.
    const candidates = await repository.getMemoryCandidates("legacy-v1-dataset", "no-thread-yet");
    await repository.close();
    return { dataset, candidates };
  });
  expect(migrated.dataset.id).toBe("legacy-v1-dataset");
  expect(migrated.dataset.schemaVersion).toBe(8);
  expect(migrated.dataset.dirtySequence).toBe(7);
  expect(migrated.dataset.lastAckedSequence).toBe(2);
  expect(migrated.candidates).toEqual([]);
});

test("MemoryRelation persists only when both versions and source provenance belong to the dataset", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    const relation = {
      id: "relation-1",
      fromVersionId: "version-a1",
      toVersionId: "version-b1",
      relationType: "contradicts",
      sourceMessageIds: [ids.messageA],
      sourceReferences: [],
      createdAt: "2026-11-14T01:00:00.000Z",
    };
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createThread({
        id: ids.threadId,
        datasetId: ids.datasetA,
        bookRevisionId: ids.revision,
        createdAt: "2026-11-14T00:00:00.000Z",
      });
      await tx.appendUserMessage({
        id: ids.messageA, threadId: ids.threadId, content: "观点 A",
        createdAt: "2026-11-14T00:00:01.000Z", sourceReferences: [],
      });
      await tx.appendUserMessage({
        id: ids.messageB, threadId: ids.threadId, content: "观点 B",
        createdAt: "2026-11-14T00:00:02.000Z", sourceReferences: [],
      });
      await tx.appendMemoryVersion({
        id: "version-a1", memoryId: "memory-a", version: 1, previousVersionId: null,
        changeKind: "new", content: "观点 A", sourceMessageIds: [ids.messageA],
        sourceReferences: [], createdAt: "2026-11-14T00:00:03.000Z",
      });
      await tx.appendMemoryVersion({
        id: "version-b1", memoryId: "memory-b", version: 1, previousVersionId: null,
        changeKind: "new", content: "观点 B", sourceMessageIds: [ids.messageB],
        sourceReferences: [], createdAt: "2026-11-14T00:00:04.000Z",
      });
      await tx.appendMemoryRelation(relation);
    });
    const relations = await repository.getMemoryRelations(ids.datasetA, "version-a1");
    const snapshot = await repository.transaction(ids.datasetA, (tx) => tx.createConsistentSnapshot());
    let invalidRejected = false;
    try {
      await repository.transaction(ids.datasetA, (tx) => tx.appendMemoryRelation({
        ...relation, id: "relation-invalid", toVersionId: "missing-version",
      }));
    } catch { invalidRejected = true; }
    await repository.close();
    return { relations, snapshot, invalidRejected };
  }, {
    datasetA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revision: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    threadId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    messageA: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    messageB: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  });
  expect(result.relations).toHaveLength(1);
  expect(result.relations[0].relationType).toBe("contradicts");
  expect(result.snapshot.memoryRelations).toHaveLength(1);
  expect(result.invalidRejected).toBe(true);
});

test("memory recall returns only effective versions by thread, chapter and topic", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createThread({
        id: ids.threadId, datasetId: ids.datasetA, bookRevisionId: ids.revision,
        createdAt: "2026-11-14T00:00:00.000Z",
      });
      await tx.appendUserMessage({
        id: ids.messageA, threadId: ids.threadId, content: "决策取决于关键变量",
        createdAt: "2026-11-14T00:00:01.000Z", sourceReferences: [],
      });
      await tx.appendUserMessage({
        id: ids.messageB, threadId: ids.threadId, content: "先看目录再读正文",
        createdAt: "2026-11-14T00:00:02.000Z", sourceReferences: [],
      });
      await tx.appendMemoryVersion({
        id: "recall-a1", memoryId: "recall-memory-a", version: 1, previousVersionId: null,
        changeKind: "new", title: "信息与决策", viewpoint: "user", content: "信息越充分决策越准确。",
        sourceMessageIds: [ids.messageA],
        sourceReferences: [{ bookRevisionId: ids.revision, structureNodeId: "node-01", locator: "epubcfi(/6/2)" }],
        createdAt: "2026-11-14T00:00:03.000Z",
      });
      await tx.appendMemoryVersion({
        id: "recall-a2", memoryId: "recall-memory-a", version: 2, previousVersionId: "recall-a1",
        changeKind: "correction", title: "关键变量", viewpoint: "user", content: "决策质量取决于是否识别关键变量。",
        sourceMessageIds: [ids.messageA],
        sourceReferences: [{ bookRevisionId: ids.revision, structureNodeId: "node-01", locator: "epubcfi(/6/2)" }],
        createdAt: "2026-11-14T00:00:04.000Z",
      });
      await tx.appendMemoryVersion({
        id: "recall-b1", memoryId: "recall-memory-b", version: 1, previousVersionId: null,
        changeKind: "new", title: "阅读顺序", viewpoint: "user", content: "先看目录有助于建立结构感。",
        sourceMessageIds: [ids.messageB],
        sourceReferences: [{ bookRevisionId: ids.revision, structureNodeId: "node-02", locator: "epubcfi(/6/4)" }],
        createdAt: "2026-11-14T00:00:05.000Z",
      });
    });
    const byThread = await repository.recallMemoryVersions(ids.datasetA, { threadId: ids.threadId });
    const byChapter = await repository.recallMemoryVersions(ids.datasetA, {
      threadId: ids.threadId, structureNodeId: "node-01",
    });
    const byTopic = await repository.recallMemoryVersions(ids.datasetA, {
      threadId: ids.threadId, topic: "关键变量",
    });
    const limited = await repository.recallMemoryVersions(ids.datasetA, {
      threadId: ids.threadId, limit: 1,
    });
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.appendMemoryVersion({
        id: "recall-b2", memoryId: "recall-memory-b", version: 2, previousVersionId: "recall-b1",
        changeKind: "rejection", title: "阅读顺序", viewpoint: "user", content: "不再坚持先看目录。",
        sourceMessageIds: [ids.messageB],
        sourceReferences: [{ bookRevisionId: ids.revision, structureNodeId: "node-02", locator: "epubcfi(/6/4)" }],
        createdAt: "2026-11-14T00:00:06.000Z",
      });
    });
    const afterRejection = await repository.recallMemoryVersions(ids.datasetA, { threadId: ids.threadId });
    let invalidLimitRejected = false;
    try {
      await repository.recallMemoryVersions(ids.datasetA, { threadId: ids.threadId, limit: 9 });
    } catch { invalidLimitRejected = true; }
    await repository.close();
    return { byThread, byChapter, byTopic, limited, afterRejection, invalidLimitRejected };
  }, {
    datasetA, revision, threadId,
    messageA: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    messageB: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  });
  expect(result.byThread.map((version) => version.id)).toEqual(["recall-b1", "recall-a2"]);
  expect(result.byChapter.map((version) => version.id)).toEqual(["recall-a2"]);
  expect(result.byTopic.map((version) => version.id)).toEqual(["recall-a2"]);
  expect(result.limited).toHaveLength(1);
  expect(result.afterRejection.map((version) => version.id)).toEqual(["recall-a2"]);
  expect(result.invalidLimitRejected).toBe(true);
});


test("SQLite Worker maps quota, integrity and migration failures to typed RepositoryError codes", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { mapWorkerError } = await import("/src/index.ts");
    return ["QUOTA_EXCEEDED", "INTEGRITY_FAILED", "MIGRATION_FAILED", "WRITER_LOCK_UNAVAILABLE", "UNKNOWN"].map((code) => {
      const error = mapWorkerError({ code, message: "simulated storage failure" });
      return { name: error.name, code: error.code ?? null, message: error.message };
    });
  });
  expect(result[0]).toMatchObject({ name: "RepositoryError", code: "QUOTA_EXCEEDED" });
  expect(result[1]).toMatchObject({ name: "RepositoryError", code: "INTEGRITY_FAILED" });
  expect(result[2]).toMatchObject({ name: "RepositoryError", code: "MIGRATION_FAILED" });
  expect(result[3]).toMatchObject({ name: "RepositoryError", code: "WRITER_LOCK_UNAVAILABLE" });
  expect(result[4]).toMatchObject({ name: "Error", code: null });
});


test("backup acknowledgement advances only through the uploaded snapshot and preserves later dirty writes", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createThread({
        id: ids.threadId, datasetId: ids.datasetA, bookRevisionId: ids.revision,
        createdAt: "2026-11-14T00:00:00.000Z",
      });
      await tx.appendUserMessage({
        id: ids.messageA, threadId: ids.threadId, content: "snapshot v1",
        createdAt: "2026-11-14T00:00:01.000Z", sourceReferences: [],
      });
    });
    const snapshot = await repository.transaction(
      ids.datasetA, (tx) => tx.createConsistentSnapshot(),
    );
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.appendUserMessage({
        id: ids.messageB, threadId: ids.threadId, content: "written after snapshot",
        createdAt: "2026-11-14T00:00:02.000Z", sourceReferences: [],
      });
    });
    await repository.transaction(ids.datasetA, (tx) =>
      tx.acknowledgeBackup(snapshot.dirtySequence, "backup-001", "2026-11-14T00:01:00.000Z"),
    );
    const afterAck = await repository.getDataSet(ids.datasetA);
    let staleRejected = false;
    let futureRejected = false;
    try {
      await repository.transaction(ids.datasetA, (tx) =>
        tx.acknowledgeBackup(0, "backup-stale", "2026-11-14T00:02:00.000Z"),
      );
    } catch { staleRejected = true; }
    try {
      await repository.transaction(ids.datasetA, (tx) =>
        tx.acknowledgeBackup(99, "backup-future", "2026-11-14T00:03:00.000Z"),
      );
    } catch { futureRejected = true; }
    const finalDataset = await repository.getDataSet(ids.datasetA);
    await repository.close();
    return { snapshotSequence: snapshot.dirtySequence, afterAck, finalDataset, staleRejected, futureRejected };
  }, {
    datasetA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revision: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    threadId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    messageA: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    messageB: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  });
  expect(result.snapshotSequence).toBe(1);
  expect(result.afterAck.dirtySequence).toBe(2);
  expect(result.afterAck.lastAckedSequence).toBe(1);
  expect(result.afterAck.lastBackupId).toBe("backup-001");
  expect(result.finalDataset.dirtySequence).toBe(2);
  expect(result.finalDataset.lastAckedSequence).toBe(1);
  expect(result.staleRejected).toBe(true);
  expect(result.futureRejected).toBe(true);
});


test("SQLite persists pending memory candidates with Thread and user-message provenance", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    const candidate = {
      id: "candidate-pending-1",
      title: "目标一致性比沟通频率更重要",
      content: "协同质量取决于目标一致，而不是沟通次数。",
      viewpoint: "user",
      confidence: 0.62,
      ambiguity: 0.3,
      value: { novelty: 0.8, stability: 0.7, explanatoryPower: 0.9, discussionDepth: 0.6, relationStrength: 0.8 },
      sourceMessageIds: [ids.messageA],
      sourceReferences: [],
      requiresBookCitation: false,
    };
    const record = {
      id: candidate.id, datasetId: ids.datasetA, threadId: ids.threadId, candidate,
      evaluationScore: 0.66, status: "needs_confirmation",
      createdAt: "2026-11-14T02:00:00.000Z", updatedAt: "2026-11-14T02:00:00.000Z",
    };
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createThread({ id: ids.threadId, datasetId: ids.datasetA, bookRevisionId: ids.revision, createdAt: "2026-11-14T00:00:00.000Z" });
      await tx.appendUserMessage({ id: ids.messageA, threadId: ids.threadId, content: "我认为目标一致更重要。", createdAt: "2026-11-14T00:00:01.000Z", sourceReferences: [] });
      await tx.saveMemoryCandidate(record);
    });
    const pending = await repository.getMemoryCandidates(ids.datasetA, ids.threadId);
    await repository.transaction(ids.datasetA, (tx) => tx.resolveMemoryCandidate(candidate.id, "accepted", "2026-11-14T02:01:00.000Z"));
    const pendingAfterResolution = await repository.getMemoryCandidates(ids.datasetA, ids.threadId);
    const snapshot = await repository.createConsistentSnapshot(ids.datasetA);
    await repository.close();
    return { pending, pendingAfterResolution, snapshot };
  }, {
    datasetA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revision: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    threadId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    messageA: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  });
  expect(result.pending).toHaveLength(1);
  expect(result.pending[0].status).toBe("needs_confirmation");
  expect(result.pending[0].candidate.viewpoint).toBe("user");
  expect(result.pendingAfterResolution).toHaveLength(0);
  expect(result.snapshot.memoryCandidates).toHaveLength(1);
  expect(result.snapshot.memoryCandidates[0].status).toBe("accepted");
});


test("restores a verified snapshot only into an empty dataset and preserves the committed backup cursor", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    const datasetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const threadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const snapshot = {
      datasetId,
      schemaVersion: 5,
      dirtySequence: 7,
      threads: [{ id: threadId, datasetId, bookRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", createdAt: "2026-11-14T00:00:00.000Z" }],
      messages: [{
        message: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", threadId, role: "user", content: "restored", status: "saved", createdAt: "2026-11-14T00:00:01.000Z", sourceReferences: [] },
        sequence: 1, idempotencyKey: null,
      }],
      readingRounds: [], readingPositions: [], citations: [], notes: [], memories: [],
      memoryVersions: [], memoryRelations: [], memoryCandidates: [], generationDeliveries: [],
    };
    await repository.restoreSnapshot(datasetId, snapshot, "backup-restore-1", "2026-11-14T00:01:00.000Z");
    const restored = await repository.createConsistentSnapshot(datasetId);
    const dataset = await repository.getDataSet(datasetId);
    let overwriteRejected = false;
    try {
      await repository.restoreSnapshot(datasetId, snapshot, "backup-restore-2", "2026-11-14T00:02:00.000Z");
    } catch { overwriteRejected = true; }
    const afterRejectedRestore = await repository.createConsistentSnapshot(datasetId);
    await repository.close();
    return { restored, dataset, overwriteRejected, afterRejectedRestore };
  });
  expect(result.restored.threads).toHaveLength(1);
  expect(result.restored.messages).toHaveLength(1);
  expect(result.dataset.dirtySequence).toBe(7);
  expect(result.dataset.lastAckedSequence).toBe(7);
  expect(result.dataset.lastBackupId).toBe("backup-restore-1");
  expect(result.overwriteRejected).toBe(true);
  expect(result.afterRejectedRestore.messages).toHaveLength(1);
});


test("SQLite OPFS persists verified Assistant source references on completion", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    const assistantId = "99999999-9999-4999-8999-999999999999";
    const nodeId = "88888888-8888-4888-8888-888888888888";
    const references = [{ bookRevisionId: ids.revision, structureNodeId: nodeId, locator: "epubcfi(/6/4!/4/2)" }];
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createThread({ id: ids.threadId, datasetId: ids.datasetA, bookRevisionId: ids.revision, createdAt: "2026-11-14T00:00:00.000Z" });
      await tx.appendAssistantMessage({
        id: assistantId, threadId: ids.threadId, content: "", status: "generating",
        createdAt: "2026-11-14T00:00:01.000Z", sourceReferences: []
      });
      await tx.transitionAssistantMessage(assistantId, "completed", "有来源的最终回答", references);
    });
    const messages = await repository.getMessages(ids.datasetA, ids.threadId);
    await repository.close();
    return messages[0].message;
  }, { datasetA, revision, threadId });
  expect(result.status).toBe("completed");
  expect(result.content).toBe("有来源的最终回答");
  expect(result.sourceReferences).toEqual([{
    bookRevisionId: revision,
    structureNodeId: "88888888-8888-4888-8888-888888888888",
    locator: "epubcfi(/6/4!/4/2)"
  }]);
});


test("SQLite OPFS persists CitationRecord with the completed Assistant message", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    const assistantId = "99999999-9999-4999-8999-999999999999";
    const nodeId = "88888888-8888-4888-8888-888888888888";
    const citationId = "77777777-7777-4777-8777-777777777777";
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createThread({ id: ids.threadId, datasetId: ids.datasetA, bookRevisionId: ids.revision, createdAt: "2026-11-14T00:00:00.000Z" });
      await tx.appendAssistantMessage({
        id: assistantId, threadId: ids.threadId, content: "", status: "generating",
        createdAt: "2026-11-14T00:00:01.000Z", sourceReferences: []
      });
      await tx.transitionAssistantMessage(assistantId, "completed", "有来源的最终回答", [{
        bookRevisionId: ids.revision, structureNodeId: nodeId, locator: "epubcfi(/6/4!/4/2)"
      }]);
      await tx.saveCitation({
        id: citationId, threadId: ids.threadId, messageId: assistantId,
        bookRevisionId: ids.revision, structureNodeId: nodeId,
        chunkId: "66666666-6666-4666-8666-666666666666",
        locator: "epubcfi(/6/4!/4/2)", excerpt: "原文片段",
        excerptHash: null, sourceHash: "a".repeat(64), createdAt: "2026-11-14T00:00:02.000Z"
      });
    });
    const snapshot = await repository.createConsistentSnapshot(ids.datasetA);
    const messages = await repository.getMessages(ids.datasetA, ids.threadId);
    await repository.close();
    return { citation: snapshot.citations[0], message: messages[0].message };
  }, { datasetA, revision, threadId });
  expect(result.message.sourceReferences).toHaveLength(1);
  expect(result.citation.messageId).toBe("99999999-9999-4999-8999-999999999999");
  expect(result.citation.excerpt).toBe("原文片段");
  expect(result.citation.chunkId).toBe("66666666-6666-4666-8666-666666666666");
  expect(result.citation.sourceHash).toBe("a".repeat(64));
});



test("snapshot restore uses the same dataset writer lock and fails closed when another writer owns it", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    const datasetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const outcome = await navigator.locks.request(
      "read-book-dataset:" + datasetId,
      { mode: "exclusive" },
      async () => {
        try {
          await repository.restoreSnapshot(datasetId, {
            datasetId,
            schemaVersion: 5,
            dirtySequence: 1,
            threads: [],
            messages: [],
            readingRounds: [],
            readingPositions: [],
            citations: [],
            notes: [],
            memories: [],
            memoryVersions: [],
            memoryRelations: [],
            memoryCandidates: [],
            generationDeliveries: [],
          }, "backup-locked", "2026-11-14T03:00:00.000Z");
          return { rejected: false, name: null, code: null };
        } catch (error) {
          return { rejected: true, name: error.name, code: error.code ?? null };
        }
      },
    );
    const dataset = await repository.getDataSet(datasetId);
    await repository.close();
    return { ...outcome, dataset };
  });
  expect(result.rejected).toBe(true);
  expect(result.name).toBe("RepositoryError");
  expect(result.code).toBe("WRITER_LOCK_UNAVAILABLE");
  expect(result.dataset).toBeNull();
});


test("Note writes cannot cross Thread or dataset boundaries or overwrite an older revision", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    const datasetA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const datasetB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const threadA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const threadB = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const revisionA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const revisionB = "77777777-7777-4777-8777-777777777777";
    const noteId = "note-boundary-1";
    await repository.transaction(datasetA, async (tx) => {
      await tx.createThread({ id: threadA, datasetId: datasetA, bookRevisionId: revisionA, createdAt: "2026-11-14T00:00:00.000Z" });
      await tx.createThread({ id: threadB, datasetId: datasetA, bookRevisionId: revisionB, createdAt: "2026-11-14T00:00:01.000Z" });
      await tx.createReadingRound({
        id: "round-thread-b", threadId: threadB, roundNumber: 1, status: "active",
        startedAt: "2026-11-14T00:00:02.000Z",
      });
    });
    let crossThreadRoundRejected = false;
    try {
      await repository.transaction(datasetA, (tx) => tx.saveNote({
        id: noteId, datasetId: datasetA, threadId: threadA, readingRoundId: "round-thread-b",
        content: "错误关联", sourceMessageIds: [], sourceReferences: [],
        createdAt: "2026-11-14T00:00:03.000Z", updatedAt: "2026-11-14T00:00:03.000Z", revision: 1,
      }));
    } catch { crossThreadRoundRejected = true; }
    await repository.transaction(datasetA, (tx) => tx.saveNote({
      id: noteId, datasetId: datasetA, threadId: threadA, readingRoundId: null,
      content: "原始笔记", sourceMessageIds: [], sourceReferences: [],
      createdAt: "2026-11-14T00:00:04.000Z", updatedAt: "2026-11-14T00:00:04.000Z", revision: 1,
    }));
    await repository.transaction(datasetB, (tx) => tx.createThread({
      id: "thread-dataset-b", datasetId: datasetB, bookRevisionId: revisionA, createdAt: "2026-11-14T00:00:05.000Z",
    }));
    let crossDatasetIdRejected = false;
    try {
      await repository.transaction(datasetB, (tx) => tx.saveNote({
        id: noteId, datasetId: datasetB, threadId: "thread-dataset-b", readingRoundId: null,
        content: "跨数据集覆盖", sourceMessageIds: [], sourceReferences: [],
        createdAt: "2026-11-14T00:00:06.000Z", updatedAt: "2026-11-14T00:00:06.000Z", revision: 1,
      }));
    } catch { crossDatasetIdRejected = true; }
    let staleRevisionRejected = false;
    try {
      await repository.transaction(datasetA, (tx) => tx.saveNote({
        id: noteId, datasetId: datasetA, threadId: threadA, readingRoundId: null,
        content: "旧版本覆盖", sourceMessageIds: [], sourceReferences: [],
        createdAt: "2026-11-14T00:00:07.000Z", updatedAt: "2026-11-14T00:00:07.000Z", revision: 1,
      }));
    } catch { staleRevisionRejected = true; }
    const snapshot = await repository.createConsistentSnapshot(datasetA);
    await repository.close();
    return {
      crossThreadRoundRejected, crossDatasetIdRejected, staleRevisionRejected,
      savedNote: snapshot.notes.find((note) => note.id === noteId),
    };
  });
  expect(result.crossThreadRoundRejected).toBe(true);
  expect(result.crossDatasetIdRejected).toBe(true);
  expect(result.staleRevisionRejected).toBe(true);
  expect(result.savedNote.content).toBe("原始笔记");
  expect(result.savedNote.revision).toBe(1);
});

test("backup journal records content mutations at the committed dirty sequence and prunes after ack", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createThread({
        id: ids.threadId, datasetId: ids.datasetA, bookRevisionId: ids.revision,
        createdAt: "2026-11-14T00:00:00.000Z",
      });
      await tx.appendUserMessage({
        id: ids.messageId, threadId: ids.threadId, content: "第一条消息",
        createdAt: "2026-11-14T00:00:01.000Z", sourceReferences: [],
      });
    });
    const first = await repository.createConsistentSnapshot(ids.datasetA);
    await repository.transaction(ids.datasetA, (tx) => tx.saveReadingPosition({
      datasetId: ids.datasetA, threadId: ids.threadId, mainlineNodeId: "node-1",
      displayedNodeId: "node-1", viewMode: "mainline", currentUnitDiscussed: false,
      updatedAt: "2026-11-14T00:00:02.000Z",
    }));
    const second = await repository.createConsistentSnapshot(ids.datasetA);
    await repository.transaction(ids.datasetA, (tx) =>
      tx.acknowledgeBackup(second.dirtySequence, "backup-journal", "2026-11-14T00:00:03.000Z"));
    const afterAck = await repository.createConsistentSnapshot(ids.datasetA);
    await repository.close();
    return { first, second, afterAck };
  }, {
    datasetA, revision, threadId,
    messageId: "cccccccc-3333-4333-8333-cccccccccccc",
  });
  expect(result.first.schemaVersion).toBe(8);
  expect(result.first.dirtySequence).toBe(1);
  expect(result.first.backupJournal.map((entry) => entry.entityType).sort()).toEqual(["message", "thread"]);
  expect(new Set(result.first.backupJournal.map((entry) => entry.sequence))).toEqual(new Set([1]));
  expect(result.second.dirtySequence).toBe(2);
  expect(result.second.backupJournal).toHaveLength(3);
  expect(result.second.backupJournal.find((entry) => entry.entityType === "readingPosition")?.entityId).toBe(threadId);
  expect(result.afterAck.dirtySequence).toBe(2);
  expect(result.afterAck.backupJournal).toEqual([]);
});

test("SQLite OPFS persists SM-001 to SM-008 mainline progress and reading rounds", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (ids) => {
    const { SqliteOpfsRepository } = await import("/src/index.ts");
    const repository = new SqliteOpfsRepository();
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createThread({
        id: ids.threadId,
        datasetId: ids.datasetA,
        bookRevisionId: ids.revision,
        createdAt: "2026-11-14T00:00:00.000Z",
      });
    });
    let illegalSkipRejected = false;
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createReadingRoundPlan({
        round: {
          id: ids.roundId, threadId: ids.threadId, roundNumber: 1,
          status: "active", startReason: "first_read", startedAt: "2026-11-14T00:00:01.000Z",
        },
        state: {
          readingRoundId: ids.roundId, currentStructureNodeId: "node-01",
          currentOrderIndex: 0, lastPresentedSourceId: null, updatedAt: "2026-11-14T00:00:01.000Z",
        },
        unitProgress: [
          { readingRoundId: ids.roundId, structureNodeId: "node-01", status: "not_presented", firstPresentedSourceId: null, lastActivityMessageId: null, completedAt: null, updatedAt: "2026-11-14T00:00:01.000Z" },
          { readingRoundId: ids.roundId, structureNodeId: "node-02", status: "not_presented", firstPresentedSourceId: null, lastActivityMessageId: null, completedAt: null, updatedAt: "2026-11-14T00:00:01.000Z" },
        ],
      });
      await tx.savePresentedSource({
        id: ids.sourceOne, datasetId: ids.datasetA, threadId: ids.threadId,
        bookRevisionId: ids.revision, structureNodeId: "node-01", chunkId: null,
        presentationType: "mainline", readingRoundId: ids.roundId,
        presentedAt: "2026-11-14T00:00:02.000Z", sourceLocator: { cfi: "/6/4!/4/2" },
      });
      await tx.saveReadingUnitProgress({
        readingRoundId: ids.roundId, datasetId: ids.datasetA, structureNodeId: "node-01",
        status: "awaiting_user", firstPresentedSourceId: ids.sourceOne,
        lastActivityMessageId: null, completedAt: null, updatedAt: "2026-11-14T00:00:02.000Z",
      });
      await tx.saveReadingRoundState({
        readingRoundId: ids.roundId, datasetId: ids.datasetA,
        currentStructureNodeId: "node-01", currentOrderIndex: 0,
        lastPresentedSourceId: ids.sourceOne, updatedAt: "2026-11-14T00:00:02.000Z",
      });
      try {
        await tx.saveReadingUnitProgress({
          readingRoundId: ids.roundId, datasetId: ids.datasetA, structureNodeId: "node-01",
          status: "discussed", firstPresentedSourceId: ids.sourceOne,
          lastActivityMessageId: null, completedAt: "2026-11-14T00:00:03.000Z",
          updatedAt: "2026-11-14T00:00:03.000Z",
        });
      } catch {
        illegalSkipRejected = true;
      }
      await tx.savePresentedSource({
        id: ids.temporarySource, datasetId: ids.datasetA, threadId: ids.threadId,
        bookRevisionId: ids.revision, structureNodeId: "node-09", chunkId: null,
        presentationType: "temporary", readingRoundId: null,
        presentedAt: "2026-11-14T00:00:03.000Z", sourceLocator: { cfi: "/6/10!/4/2" },
      });
      await tx.saveReadingUnitProgress({
        readingRoundId: ids.roundId, datasetId: ids.datasetA, structureNodeId: "node-01",
        status: "discussion_active", firstPresentedSourceId: ids.sourceOne,
        lastActivityMessageId: null, completedAt: null, updatedAt: "2026-11-14T00:00:04.000Z",
      });
      await tx.saveReadingUnitProgress({
        readingRoundId: ids.roundId, datasetId: ids.datasetA, structureNodeId: "node-01",
        status: "discussed", firstPresentedSourceId: ids.sourceOne,
        lastActivityMessageId: null, completedAt: "2026-11-14T00:00:05.000Z",
        updatedAt: "2026-11-14T00:00:05.000Z",
      });
      await tx.savePresentedSource({
        id: ids.sourceTwo, datasetId: ids.datasetA, threadId: ids.threadId,
        bookRevisionId: ids.revision, structureNodeId: "node-02", chunkId: null,
        presentationType: "mainline", readingRoundId: ids.roundId,
        presentedAt: "2026-11-14T00:00:06.000Z", sourceLocator: { cfi: "/6/4!/4/6" },
      });
      await tx.saveReadingUnitProgress({
        readingRoundId: ids.roundId, datasetId: ids.datasetA, structureNodeId: "node-02",
        status: "awaiting_user", firstPresentedSourceId: ids.sourceTwo,
        lastActivityMessageId: null, completedAt: null, updatedAt: "2026-11-14T00:00:06.500Z",
      });
      await tx.saveReadingUnitProgress({
        readingRoundId: ids.roundId, datasetId: ids.datasetA, structureNodeId: "node-02",
        status: "skipped", firstPresentedSourceId: ids.sourceTwo,
        lastActivityMessageId: null, completedAt: "2026-11-14T00:00:07.000Z",
        updatedAt: "2026-11-14T00:00:07.000Z",
      });
      await tx.saveReadingRoundState({
        readingRoundId: ids.roundId, datasetId: ids.datasetA,
        currentStructureNodeId: "node-02", currentOrderIndex: 1,
        lastPresentedSourceId: ids.sourceTwo, updatedAt: "2026-11-14T00:00:07.000Z",
      });
      await tx.updateReadingRoundStatus(ids.roundId, "completed", "2026-11-14T00:00:08.000Z");
    });

    let thirdActiveRejected = false;
    await repository.transaction(ids.datasetA, async (tx) => {
      await tx.createReadingRoundPlan({
        round: {
          id: ids.secondRoundId, threadId: ids.threadId, roundNumber: 2,
          status: "active", startReason: "reread", startedAt: "2026-11-14T00:00:09.000Z",
        },
        state: {
          readingRoundId: ids.secondRoundId, currentStructureNodeId: "node-01",
          currentOrderIndex: 0, lastPresentedSourceId: null, updatedAt: "2026-11-14T00:00:09.000Z",
        },
        unitProgress: [
          { readingRoundId: ids.secondRoundId, structureNodeId: "node-01", status: "not_presented", firstPresentedSourceId: null, lastActivityMessageId: null, completedAt: null, updatedAt: "2026-11-14T00:00:09.000Z" },
        ],
      });
    });
    try {
      await repository.transaction(ids.datasetA, async (tx) => {
        await tx.createReadingRoundPlan({
          round: {
            id: ids.thirdRoundId, threadId: ids.threadId, roundNumber: 3,
            status: "active", startReason: "reread", startedAt: "2026-11-14T00:00:10.000Z",
          },
          state: {
            readingRoundId: ids.thirdRoundId, currentStructureNodeId: "node-01",
            currentOrderIndex: 0, lastPresentedSourceId: null, updatedAt: "2026-11-14T00:00:10.000Z",
          },
          unitProgress: [
            { readingRoundId: ids.thirdRoundId, structureNodeId: "node-01", status: "not_presented", firstPresentedSourceId: null, lastActivityMessageId: null, completedAt: null, updatedAt: "2026-11-14T00:00:10.000Z" },
          ],
        });
      });
    } catch {
      thirdActiveRejected = true;
    }

    const round = await repository.getReadingRound(ids.datasetA, ids.roundId);
    const state = await repository.getReadingRoundState(ids.datasetA, ids.roundId);
    const units = await repository.listReadingUnitProgress(ids.datasetA, ids.roundId);
    const sources = await repository.listPresentedSources(ids.datasetA, ids.threadId);
    const secondRound = await repository.getReadingRound(ids.datasetA, ids.secondRoundId);
    await repository.close();
    return { round, secondRound, state, units, sources, illegalSkipRejected, thirdActiveRejected };
  }, {
    datasetA, revision, threadId,
    roundId: "11111111-1111-4111-8111-111111111111",
    secondRoundId: "22222222-2222-4222-8222-222222222222",
    thirdRoundId: "77777777-7777-4777-8777-777777777777",
    sourceOne: "33333333-3333-4333-8333-333333333333",
    sourceTwo: "44444444-4444-4444-8444-444444444444",
    temporarySource: "55555555-5555-4555-8555-555555555555",
  });

  expect(result.illegalSkipRejected).toBe(true);
  expect(result.thirdActiveRejected).toBe(true);
  expect(result.round.status).toBe("completed");
  expect(result.secondRound.status).toBe("active");
  expect(result.secondRound.startReason).toBe("reread");
  expect(result.state.currentStructureNodeId).toBe("node-02");
  expect(result.state.lastPresentedSourceId).toBe(result.sources.find((source) => source.structureNodeId === "node-02").id);
  expect(result.units.map((unit) => unit.status).sort()).toEqual(["discussed", "skipped"]);
  expect(result.sources).toHaveLength(3);
  expect(result.sources.filter((source) => source.presentationType === "temporary")).toHaveLength(1);
});
