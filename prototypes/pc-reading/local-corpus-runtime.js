import { SqliteOpfsRepository } from "../../packages/local-repository-sqlite/src/index.ts";

const LOCAL_DATASET_STORAGE_KEY = "read-book:local-dataset-id";

function getOrCreateLocalDataSetId() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error("当前浏览器不支持 localStorage。");
    const existing = storage.getItem(LOCAL_DATASET_STORAGE_KEY);
    if (existing) return existing;
    const created = uuid();
    storage.setItem(LOCAL_DATASET_STORAGE_KEY, created);
    return created;
  } catch {
    throw new Error("无法持久化本地数据集标识；请允许当前站点使用本地存储后重试。");
  }
}

function uuid() {
  if (!globalThis.crypto?.randomUUID) throw new Error("当前浏览器不支持安全 UUID，无法创建本地阅读 Thread。");
  return globalThis.crypto.randomUUID();
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " 未配置。");
  return value.trim();
}

/**
 * Local-only runtime for public GitHub corpus books.
 * It persists the reading position in the same SQLite/OPFS repository as the
 * production reader, but deliberately does not pretend that backup or Agent
 * services are configured.
 */
export async function createLocalCorpusRuntime(bookRevision, {
  datasetId = getOrCreateLocalDataSetId(),
  repositoryFactory = () => new SqliteOpfsRepository(),
  now = () => new Date().toISOString(),
} = {}) {
  if (!bookRevision || typeof bookRevision.bookRevisionId !== "string" || !bookRevision.bookRevisionId.trim()) {
    throw new TypeError("本地语料运行时需要有效的 BookRevision。");
  }
  const localDatasetId = required(datasetId, "localDataSetId");
  const repository = repositoryFactory();
  let thread;
  let readingPosition = null;
  try {
    await repository.initialize();
    await repository.transaction(localDatasetId, async (tx) => {
      thread = await tx.getThreadByRevision(bookRevision.bookRevisionId);
      if (!thread) {
        thread = await tx.createThread({
          id: uuid(),
          datasetId: localDatasetId,
          bookRevisionId: bookRevision.bookRevisionId,
          createdAt: now(),
        });
      }
      const snapshot = await tx.createConsistentSnapshot();
      readingPosition = snapshot.readingPositions.find((item) => item.threadId === thread.id) || null;
      if (!readingPosition) {
        readingPosition = {
          threadId: thread.id,
          mainlineNodeId: bookRevision.initialMainlineUnitId,
          displayedNodeId: bookRevision.initialMainlineUnitId,
          viewMode: "mainline",
          currentUnitDiscussed: true,
          updatedAt: now(),
        };
        await tx.saveReadingPosition(readingPosition);
      }
    });
    const startupSnapshot = await repository.createConsistentSnapshot(localDatasetId);

    async function savePosition(state, units) {
      const mainline = units[state.mainlineIndex];
      const displayed = state.displayedUnit;
      if (!mainline || !displayed) return;
      const next = {
        threadId: thread.id,
        mainlineNodeId: mainline.id,
        displayedNodeId: displayed.id,
        viewMode: state.viewMode,
        currentUnitDiscussed: Boolean(state.discussed),
        updatedAt: now(),
      };
      await repository.transaction(localDatasetId, (tx) => tx.saveReadingPosition(next));
      readingPosition = next;
    }

    return Object.freeze({
      datasetId: localDatasetId,
      thread,
      readingPosition,
      startupSnapshot,
      backupStatus: {
        label: "备份未配置",
        detail: "已在本地 SQLite/OPFS 创建一致性快照；未配置加密备份服务，因此没有上传云端。",
      },
      async savePosition(state, units) {
        return savePosition(state, units);
      },
      async close() {
        await repository.close();
      },
    });
  } catch (error) {
    await repository.close().catch(() => {});
    throw error;
  }
}
