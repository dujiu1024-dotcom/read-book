/**
 * Read-book domain core.
 *
 * Pure domain rules only: no browser APIs, storage, network, UI framework or model SDK.
 */

export type DatasetId = string;
export type BookRevisionId = string;
export type ThreadId = string;
export type ReadingRoundId = string;
export type MessageId = string;
export type StructureNodeId = string;
export type MemoryId = string;
export type MemoryVersionId = string;

export type MessageRole = "user" | "assistant";
export type AssistantMessageStatus = "generating" | "completed" | "failed" | "cancelled";
export type ViewMode = "mainline" | "temporary" | "review" | "citation";
export type MemoryChangeKind = "new" | "supplement" | "correction" | "conflict" | "rejection" | "extension";

export interface Thread {
  id: ThreadId;
  datasetId: DatasetId;
  bookRevisionId: BookRevisionId;
  createdAt: string;
}

export interface ReadingRound {
  id: ReadingRoundId;
  threadId: ThreadId;
  startedAt: string;
  completedAt?: string;
}

export interface SourceReference {
  bookRevisionId: BookRevisionId;
  structureNodeId: StructureNodeId;
  locator: string;
  excerptHash?: string;
}

export interface UserMessage {
  id: MessageId;
  threadId: ThreadId;
  role: "user";
  content: string;
  status: "saved";
  createdAt: string;
  sourceReferences: SourceReference[];
}

export interface AssistantMessage {
  id: MessageId;
  threadId: ThreadId;
  role: "assistant";
  content: string;
  status: AssistantMessageStatus;
  createdAt: string;
  sourceReferences: SourceReference[];
}

export type Message = UserMessage | AssistantMessage;

export interface ReadingPosition {
  /** The only position that defines progress through the author's mainline. */
  mainlineNodeId: StructureNodeId;
  /** The currently displayed node may differ during temporary/review/citation views. */
  displayedNodeId: StructureNodeId;
  viewMode: ViewMode;
  currentUnitDiscussed: boolean;
}

export interface MemoryVersion {
  id: MemoryVersionId;
  memoryId: MemoryId;
  version: number;
  previousVersionId: MemoryVersionId | null;
  changeKind: MemoryChangeKind;
  content: string;
  sourceMessageIds: MessageId[];
  sourceReferences: SourceReference[];
  createdAt: string;
}

export class DomainRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainRuleError";
  }
}

/** One dataset can have only one long-lived Thread for a given immutable book revision. */
export function assertUniqueThreadPerRevision(threads: readonly Thread[]): void {
  const seen = new Set<string>();
  for (const thread of threads) {
    const key = JSON.stringify([thread.datasetId, thread.bookRevisionId]);
    if (seen.has(key)) {
      throw new DomainRuleError(
        "A dataset may have only one long-lived Thread for each BookRevision.",
      );
    }
    seen.add(key);
  }
}

/** Open a temporary, review or citation view without moving the mainline cursor. */
export function openNonMainlineView(
  position: ReadingPosition,
  mode: Exclude<ViewMode, "mainline">,
  targetNodeId: StructureNodeId,
): ReadingPosition {
  return { ...position, displayedNodeId: targetNodeId, viewMode: mode };
}

/** Return to the actual mainline position; temporary navigation is discarded. */
export function returnToMainline(position: ReadingPosition): ReadingPosition {
  return {
    ...position,
    displayedNodeId: position.mainlineNodeId,
    viewMode: "mainline",
  };
}

/** Advance only through an explicit mainline action; skipping needs explicit confirmation. */
export function advanceMainline(
  position: ReadingPosition,
  nextNodeId: StructureNodeId,
  decision: "discussed" | "skip_confirmed",
): ReadingPosition {
  if (position.viewMode !== "mainline") {
    throw new DomainRuleError("Return to the mainline before advancing it.");
  }
  if (!position.currentUnitDiscussed && decision !== "skip_confirmed") {
    throw new DomainRuleError("An undiscussed unit requires explicit skip confirmation.");
  }
  return {
    mainlineNodeId: nextNodeId,
    displayedNodeId: nextNodeId,
    viewMode: "mainline",
    currentUnitDiscussed: false,
  };
}

/** Build a user-message draft. The repository must commit it before starting Agent generation. */
export function createUserMessage(
  input: Omit<UserMessage, "role" | "status">,
): Omit<UserMessage, "status"> {
  if (!input.content.trim()) throw new DomainRuleError("A user message cannot be empty.");
  return { ...input, role: "user" };
}

/** A generation result changes only the assistant message; it cannot erase user input. */
export function transitionAssistantMessage(
  message: AssistantMessage,
  status: AssistantMessageStatus,
  content = message.content,
): AssistantMessage {
  if (message.status !== "generating") {
    throw new DomainRuleError("Only a generating assistant message can transition.");
  }
  if (status === "generating") {
    throw new DomainRuleError("An assistant message cannot transition back to generating.");
  }
  return { ...message, status, content };
}

/** Append a new immutable memory version; the previous version is never mutated. */
export function appendMemoryVersion(
  previous: MemoryVersion | null,
  next: MemoryVersion,
): MemoryVersion {
  if (!next.content.trim()) throw new DomainRuleError("A memory version cannot be empty.");
  if (previous === null) {
    if (next.version !== 1 || next.previousVersionId !== null || next.changeKind !== "new") {
      throw new DomainRuleError("The first memory version must be version 1 with changeKind 'new'.");
    }
    return structuredClone(next);
  }
  if (next.memoryId !== previous.memoryId) {
    throw new DomainRuleError("A memory version must belong to the same memory chain.");
  }
  if (next.version !== previous.version + 1 || next.previousVersionId !== previous.id) {
    throw new DomainRuleError("A memory version must append directly to the previous version.");
  }
  if (next.changeKind === "new") {
    throw new DomainRuleError("Only the first version may use changeKind 'new'.");
  }
  return structuredClone(next);
}
