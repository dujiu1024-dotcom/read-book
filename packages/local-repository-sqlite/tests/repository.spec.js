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
