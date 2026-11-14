import type {
  LocalRepository,
  LocalRepositoryTransaction,
  RepositorySnapshot,
  PersistedMessage,
  LocalDataSet,
  ReadingRoundRecord,
  ReadingPositionRecord,
  CitationRecord,
  NoteRecord,
  NewUserMessage,
  NewAssistantMessage,
  AccountDataSetBinding,
} from "../../local-repository-contract/src/index.ts";
import type { Thread, AssistantMessage, AssistantMessageStatus, MemoryVersion } from "../../domain-core/src/index.ts";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class SqliteOpfsRepository implements LocalRepository {
  readonly adapterName = "SQLite WASM + OPFS";
  readonly schemaVersion = 2;
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  private ready: Promise<void> | null = null;

  constructor() {
    this.worker = new Worker(new URL("./sqlite.worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error.message));
      else pending.resolve(data.result);
    };
    this.worker.onerror = (event) => {
      for (const pending of this.pending.values()) pending.reject(new Error(event.message || "SQLite Worker 异常退出"));
      this.pending.clear();
    };
  }

  private request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.closed && type !== "close") return Promise.reject(new Error("Repository 已关闭"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  async initialize(): Promise<void> {
    if (!this.ready) this.ready = this.request<void>("init");
    await this.ready;
  }

  private async ensureReady(): Promise<void> { await this.initialize(); }

  async transaction<T>(datasetId: string, operation: (tx: LocalRepositoryTransaction) => Promise<T>): Promise<T> {
    await this.ensureReady();
    if (!navigator.locks?.request) throw new Error("Web Locks 不可用，已阻止写入并降级只读");
    return navigator.locks.request("read-book-dataset:" + datasetId, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("当前标签页未获得数据集写锁，已阻止写入");
      await this.request("begin", { datasetId });
      const call = <R>(name: string, input: Record<string, unknown> = {}) =>
        this.request<R>("tx", { datasetId, operation: name, input });
      const tx: LocalRepositoryTransaction = {
        datasetId,
        getThreadByRevision: (bookRevisionId) => call("getThreadByRevision", { bookRevisionId }),
        createThread: (thread) => call("createThread", { thread }),
        appendUserMessage: (message: NewUserMessage) => call("appendUserMessage", { message }),
        appendAssistantMessage: (message: NewAssistantMessage) => call("appendAssistantMessage", { message }),
        transitionAssistantMessage: (messageId: string, status: AssistantMessageStatus, content?: string) =>
          call("transitionAssistantMessage", { messageId, status, content }),
        createReadingRound: (round: ReadingRoundRecord) => call("createReadingRound", { round }),
        saveReadingPosition: (position: ReadingPositionRecord) => call("saveReadingPosition", { position }),
        saveCitation: (citation: CitationRecord) => call("saveCitation", { citation }),
        saveNote: (note: NoteRecord) => call("saveNote", { note }),
        appendMemoryVersion: (version: MemoryVersion) =>
          call("appendMemoryVersion", { version }),
        appendMemoryRelation: (relation) => call("appendMemoryRelation", { relation }),
        createAccountDataSetBinding: (binding: AccountDataSetBinding) => call("createAccountDataSetBinding", { binding }),
        getAccountDataSetBinding: (bindingId: string) => call("getAccountDataSetBinding", { bindingId }),
        softRevokeAccountDataSetBinding: (bindingId: string, revokedAt: string) =>
          call("softRevokeAccountDataSetBinding", { bindingId, revokedAt }),
        createConsistentSnapshot: () => call("createConsistentSnapshot"),
      } as LocalRepositoryTransaction;
      try {
        const result = await operation(tx);
        await this.request("commit", { datasetId });
        return result;
      } catch (error) {
        await this.request("rollback").catch(() => undefined);
        throw error;
      }
    });
  }

  async getDataSet(datasetId: string): Promise<LocalDataSet | null> {
    await this.ensureReady();
    return this.request("getDataSet", { datasetId });
  }
  async getMessages(datasetId: string, threadId: string, afterSequence = 0): Promise<PersistedMessage[]> {
    await this.ensureReady();
    return this.request("getMessages", { datasetId, threadId, afterSequence });
  }
  async getMemoryVersions(datasetId: string, memoryId: string): Promise<MemoryVersion[]> {
    await this.ensureReady();
    return this.request("getMemoryVersions", { datasetId, memoryId });
  }
  async getMemoryRelations(datasetId: string, versionId: string) {
    await this.ensureReady();
    return this.request("getMemoryRelations", { datasetId, versionId });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.request("close");
    this.closed = true;
    this.worker.terminate();
  }
}
