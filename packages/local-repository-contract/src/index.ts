import type {
  AssistantMessage,
  AssistantMessageStatus,
  MemoryVersion,
  Message,
  ReadingPosition,
  ReadingRound,
  SourceReference,
  Thread,
} from "../../domain-core/src/index.ts";

export type RepositoryErrorCode =
  | "DATASET_NOT_FOUND"
  | "THREAD_REVISION_CONFLICT"
  | "MESSAGE_IDEMPOTENCY_CONFLICT"
  | "MESSAGE_SEQUENCE_CONFLICT"
  | "READ_ONLY"
  | "QUOTA_EXCEEDED"
  | "MIGRATION_FAILED"
  | "INTEGRITY_FAILED"
  | "WRITER_LOCK_UNAVAILABLE"
  | "ACCOUNT_BINDING_NOT_FOUND";

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;

  constructor(
    code: RepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepositoryError";
    this.code = code;
  }
}

export interface LocalDataSet {
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  dirtySequence: number;
  lastAckedSequence: number;
  lastBackupId: string | null;
  lastBackupAt: string | null;
  lifecycleStatus: "active" | "locally_locked" | "restore_pending";
}

export interface AccountDataSetBinding {
  id: string;
  accountId: string | null;
  localDataSetId: string;
  status: "active" | "inactive" | "revoked";
  boundAt: string;
  lastSelectedAt: string | null;
  revokedAt: string | null;
}

export interface PersistedMessage {
  message: Message;
  sequence: number;
  idempotencyKey: string | null;
}

export interface NewUserMessage {
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
  sourceReferences: SourceReference[];
  idempotencyKey?: string | null;
}

export interface NewAssistantMessage {
  id: string;
  threadId: string;
  content: string;
  status: AssistantMessageStatus;
  createdAt: string;
  sourceReferences: SourceReference[];
  idempotencyKey?: string | null;
}

export interface ReadingRoundRecord extends ReadingRound {
  roundNumber: number;
  status: "active" | "completed" | "abandoned";
}

export interface ReadingPositionRecord {
  threadId: string;
  mainlineNodeId: string;
  displayedNodeId: string;
  viewMode: ReadingPosition["viewMode"];
  currentUnitDiscussed: boolean;
  updatedAt: string;
}

export interface CitationRecord {
  id: string;
  threadId: string;
  messageId: string;
  bookRevisionId: string;
  structureNodeId: string;
  locator: string;
  excerpt: string;
  excerptHash: string | null;
  createdAt: string;
}

export interface NoteRecord {
  id: string;
  datasetId: string;
  threadId: string;
  readingRoundId: string | null;
  content: string;
  sourceMessageIds: string[];
  sourceReferences: SourceReference[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface MemoryRecord {
  id: string;
  datasetId: string;
  threadId: string;
  currentVersionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepositorySnapshot {
  datasetId: string;
  schemaVersion: number;
  dirtySequence: number;
  threads: Thread[];
  messages: PersistedMessage[];
  readingRounds: ReadingRoundRecord[];
  readingPositions: ReadingPositionRecord[];
  citations: CitationRecord[];
  notes: NoteRecord[];
  memories: MemoryRecord[];
  memoryVersions: MemoryVersion[];
}

/**
 * Transaction-scoped operations. Implementations must enforce dataset isolation,
 * foreign keys, uniqueness and sequence allocation inside the same DB transaction.
 * A transaction callback must never perform network/model calls or wait for UI input.
 */
export interface LocalRepositoryTransaction {
  /** All operations are scoped to this dataset for the lifetime of the transaction. */
  readonly datasetId: string;
  getThreadByRevision(bookRevisionId: string): Promise<Thread | null>;
  createThread(thread: Thread): Promise<Thread>;

  appendUserMessage(message: NewUserMessage): Promise<PersistedMessage>;
  appendAssistantMessage(message: NewAssistantMessage): Promise<PersistedMessage>;
  transitionAssistantMessage(
    messageId: string,
    status: AssistantMessageStatus,
    content?: string,
  ): Promise<AssistantMessage>;

  createReadingRound(round: ReadingRoundRecord): Promise<ReadingRoundRecord>;
  saveReadingPosition(position: ReadingPositionRecord): Promise<void>;

  saveCitation(citation: CitationRecord): Promise<void>;
  saveNote(note: NoteRecord): Promise<void>;
  appendMemoryVersion(version: MemoryVersion): Promise<MemoryVersion>;

  createAccountDataSetBinding(binding: AccountDataSetBinding): Promise<AccountDataSetBinding>;
  getAccountDataSetBinding(bindingId: string): Promise<AccountDataSetBinding | null>;
  /** Soft revoke only the selected binding and its derived authorization/index data. */
  softRevokeAccountDataSetBinding(bindingId: string, revokedAt: string): Promise<boolean>;

  createConsistentSnapshot(): Promise<RepositorySnapshot>;
}

/**
 * Local private-data repository. transaction() resolves only after the underlying
 * database commit has completed; rejection means no write may be reported as saved.
 */
export interface LocalRepository {
  readonly adapterName: string;
  readonly schemaVersion: number;
  transaction<T>(datasetId: string, operation: (tx: LocalRepositoryTransaction) => Promise<T>): Promise<T>;
  getDataSet(datasetId: string): Promise<LocalDataSet | null>;
  getMessages(datasetId: string, threadId: string, afterSequence?: number): Promise<PersistedMessage[]>;
  getMemoryVersions(datasetId: string, memoryId: string): Promise<MemoryVersion[]>;
  close(): Promise<void>;
}

/** Structural port consumed by the Agent adapter; resolves only after DB commit. */
export interface AgentUserMessageRepository {
  saveUserMessage(message: { id: string; threadId: string; content: string }): Promise<void>;
}

export function createAgentUserMessageRepository(
  repository: Pick<LocalRepository, "transaction">,
  datasetId: string,
  createMessage: (input: { id: string; threadId: string; content: string }) => NewUserMessage,
): AgentUserMessageRepository {
  return {
    async saveUserMessage(message) {
      const input = createMessage(message);
      await repository.transaction(datasetId, async (tx) => {
        await tx.appendUserMessage(input);
      });
    },
  };
}

/** Validate persisted dataset sequence metadata before exposing a dataset as writable. */
export function assertDataSetSequenceInvariant(dataSet: LocalDataSet): void {
  if (!Number.isSafeInteger(dataSet.schemaVersion) || dataSet.schemaVersion < 1) {
    throw new RepositoryError("INTEGRITY_FAILED", "Local dataset schemaVersion is invalid.");
  }
  if (
    !Number.isSafeInteger(dataSet.dirtySequence) ||
    !Number.isSafeInteger(dataSet.lastAckedSequence) ||
    dataSet.dirtySequence < dataSet.lastAckedSequence ||
    dataSet.lastAckedSequence < 0
  ) {
    throw new RepositoryError(
      "INTEGRITY_FAILED",
      "Local dataset must satisfy dirtySequence >= lastAckedSequence >= 0.",
    );
  }
}
