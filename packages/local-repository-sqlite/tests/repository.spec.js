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


test("schema v2 migration preserves a legacy v1 dataset and advances its schema marker", async ({ page }) => {
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
    await repository.close();
    return dataset;
  });
  expect(migrated.id).toBe("legacy-v1-dataset");
  expect(migrated.schemaVersion).toBe(5);
  expect(migrated.dirtySequence).toBe(7);
  expect(migrated.lastAckedSequence).toBe(2);
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


test("SQLite Worker maps quota, integrity and migration failures to typed RepositoryError codes", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { mapWorkerError } = await import("/src/index.ts");
    return ["QUOTA_EXCEEDED", "INTEGRITY_FAILED", "MIGRATION_FAILED", "UNKNOWN"].map((code) => {
      const error = mapWorkerError({ code, message: "simulated storage failure" });
      return { name: error.name, code: error.code ?? null, message: error.message };
    });
  });
  expect(result[0]).toMatchObject({ name: "RepositoryError", code: "QUOTA_EXCEEDED" });
  expect(result[1]).toMatchObject({ name: "RepositoryError", code: "INTEGRITY_FAILED" });
  expect(result[2]).toMatchObject({ name: "RepositoryError", code: "MIGRATION_FAILED" });
  expect(result[3]).toMatchObject({ name: "Error", code: null });
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
        locator: "epubcfi(/6/4!/4/2)", excerpt: "原文片段",
        excerptHash: null, createdAt: "2026-11-14T00:00:02.000Z"
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
});
