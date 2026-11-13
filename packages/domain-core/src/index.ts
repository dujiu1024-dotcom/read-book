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


/** Provenance is explicit: user beliefs must never be conflated with the author's claims or AI inference. */
export type MemoryViewpoint = "user" | "author" | "assistant_inference";

export interface MemoryCandidate {
  id: string;
  title: string;
  content: string;
  viewpoint: MemoryViewpoint;
  confidence: number;
  ambiguity: number;
  /** Value dimensions are independently assessed in [0, 1]; discussion count is not a proxy for value. */
  value: {
    novelty: number;
    stability: number;
    explanatoryPower: number;
    discussionDepth: number;
    relationStrength: number;
  };
  sourceMessageIds: MessageId[];
  sourceReferences: SourceReference[];
}

export interface MemoryCandidatePolicy {
  weights: MemoryCandidate["value"];
  minimumValueScore: number;
  minimumConfidence: number;
  maximumAmbiguity: number;
  minimumSourceMessages: number;
}

export interface MemoryCandidateEvaluation {
  decision: "accept" | "needs_confirmation" | "reject";
  score: number;
  reasons: string[];
}

/** Evaluate a candidate transparently; thresholds are supplied by the caller, not silently frozen here. */
export function evaluateMemoryCandidate(
  candidate: MemoryCandidate,
  policy: MemoryCandidatePolicy,
): MemoryCandidateEvaluation {
  const dimensions = Object.entries(candidate.value) as [keyof MemoryCandidate["value"], number][];
  const weights = Object.entries(policy.weights) as [keyof MemoryCandidate["value"], number][];
  const validUnit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

  if (!candidate.id.trim() || !candidate.title.trim() || !candidate.content.trim()) {
    throw new DomainRuleError("A memory candidate requires an id, title and content.");
  }
  if (!validUnit(candidate.confidence) || !validUnit(candidate.ambiguity)) {
    throw new DomainRuleError("Candidate confidence and ambiguity must be between 0 and 1.");
  }
  if (dimensions.some(([, value]) => !validUnit(value))) {
    throw new DomainRuleError("Every memory value dimension must be between 0 and 1.");
  }
  if (weights.some(([, value]) => !Number.isFinite(value) || value < 0)) {
    throw new DomainRuleError("Memory value weights must be finite and non-negative.");
  }
  const totalWeight = weights.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight <= 0) throw new DomainRuleError("At least one memory value weight must be positive.");
  if (
    !validUnit(policy.minimumValueScore) ||
    !validUnit(policy.minimumConfidence) ||
    !validUnit(policy.maximumAmbiguity) ||
    !Number.isInteger(policy.minimumSourceMessages) ||
    policy.minimumSourceMessages < 1
  ) {
    throw new DomainRuleError("Memory candidate policy thresholds are invalid.");
  }

  const score = dimensions.reduce((sum, [key, value]) => {
    const weight = policy.weights[key];
    return sum + value * weight;
  }, 0) / totalWeight;

  const reasons: string[] = [];
  if (candidate.sourceMessageIds.length < policy.minimumSourceMessages) {
    reasons.push("insufficient_source_messages");
  }
  if (candidate.sourceMessageIds.some((id) => !id.trim())) {
    throw new DomainRuleError("Source message ids cannot be empty.");
  }
  if (candidate.confidence < policy.minimumConfidence) reasons.push("low_confidence");
  if (candidate.ambiguity > policy.maximumAmbiguity) reasons.push("high_ambiguity");

  if (reasons.includes("insufficient_source_messages")) {
    return { decision: "reject", score, reasons };
  }
  if (reasons.length > 0) {
    return { decision: "needs_confirmation", score, reasons };
  }
  if (score < policy.minimumValueScore) {
    return { decision: "reject", score, reasons: ["insufficient_cognitive_value"] };
  }
  return { decision: "accept", score, reasons: ["value_and_provenance_requirements_met"] };
}
