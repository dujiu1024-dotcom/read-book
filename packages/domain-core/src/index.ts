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

export type ReadingUnitProgressStatus =
  | "not_presented"
  | "presented"
  | "awaiting_user"
  | "discussion_active"
  | "discussed"
  | "skipped";

export type PresentationType = "mainline" | "review" | "temporary" | "citation";

export interface PresentedSource {
  id: string;
  threadId: ThreadId;
  bookRevisionId: BookRevisionId;
  structureNodeId: StructureNodeId;
  chunkId: string | null;
  presentationType: PresentationType;
  readingRoundId: ReadingRoundId | null;
  presentedAt: string;
  sourceLocator: Record<string, unknown>;
}

export interface ReadingUnitProgress {
  readingRoundId: ReadingRoundId;
  structureNodeId: StructureNodeId;
  status: ReadingUnitProgressStatus;
  firstPresentedSourceId: string | null;
  lastActivityMessageId: MessageId | null;
  completedAt: string | null;
  updatedAt: string;
}

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
  /** Human-readable candidate label; optional for legacy versions. */
  title?: string;
  /** Preserve whether this version records the user's view, the author's view, or AI inference. */
  viewpoint?: MemoryViewpoint;
  confidence?: number;
  ambiguity?: number;
  evaluationScore?: number;
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
  /** True when the candidate makes a claim about book content and must cite its exact source. */
  requiresBookCitation: boolean;
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
  if (new Set(candidate.sourceMessageIds).size !== candidate.sourceMessageIds.length) {
    throw new DomainRuleError("Source message ids must be unique.");
  }
  if (candidate.sourceReferences.some((reference) =>
    !reference.bookRevisionId.trim() || !reference.structureNodeId.trim() || !reference.locator.trim()
  )) {
    throw new DomainRuleError("Book source references require revision, structure node and locator.");
  }
  if (candidate.requiresBookCitation && candidate.sourceReferences.length === 0) {
    reasons.push("missing_book_citation");
  }
  if (candidate.sourceMessageIds.some((id) => !id.trim())) {
    throw new DomainRuleError("Source message ids cannot be empty.");
  }
  if (candidate.confidence < policy.minimumConfidence) reasons.push("low_confidence");
  if (candidate.ambiguity > policy.maximumAmbiguity) reasons.push("high_ambiguity");

  if (reasons.includes("insufficient_source_messages") || reasons.includes("missing_book_citation")) {
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


/** Cross-memory links are explicit and provenance-bearing; they never replace the immutable version chain. */
export type MemoryRelationType =
  | "supports"
  | "contradicts"
  | "extends"
  | "supersedes"
  | "retracts"
  | "duplicate_of";

export interface MemoryRelation {
  id: string;
  fromVersionId: MemoryVersionId;
  toVersionId: MemoryVersionId;
  relationType: MemoryRelationType;
  sourceMessageIds: MessageId[];
  sourceReferences: SourceReference[];
  createdAt: string;
}

export interface MemoryExtractionContext {
  threadId: ThreadId;
  bookRevisionId: BookRevisionId;
  /** All message IDs available to the extractor in this Thread. */
  availableMessageIds: MessageId[];
  /** A candidate must trace to at least one original user message, not only assistant output. */
  availableUserMessageIds: MessageId[];
  /** Structure nodes belonging to the immutable BookRevision currently being discussed. */
  availableStructureNodeIds: StructureNodeId[];
}

export interface MemoryExtractionResult {
  candidates: MemoryCandidate[];
}

/**
 * Validate structured model output against the exact conversation and source scope supplied.
 * This is a provenance gate, not a semantic truth check or a replacement for value evaluation.
 */
export function validateMemoryExtractionResult(
  output: MemoryExtractionResult,
  context: MemoryExtractionContext,
): MemoryCandidate[] {
  if (!output || !Array.isArray(output.candidates)) {
    throw new DomainRuleError("Memory extraction output must contain a candidates array.");
  }
  if (output.candidates.length > 10) {
    throw new DomainRuleError("One extraction result may contain at most 10 candidates.");
  }
  if (!context || !Array.isArray(context.availableMessageIds) ||
      !Array.isArray(context.availableUserMessageIds) || !Array.isArray(context.availableStructureNodeIds)) {
    throw new DomainRuleError("Extraction context scopes must be arrays.");
  }
  const availableMessages = new Set(context.availableMessageIds);
  const availableUsers = new Set(context.availableUserMessageIds);
  const availableNodes = new Set(context.availableStructureNodeIds);
  if (!availableMessages.size ||
      [...availableMessages].some((id) => typeof id !== "string" || !id.trim()) ||
      availableMessages.size !== context.availableMessageIds.length ||
      [...availableUsers].some((id) => !availableMessages.has(id)) ||
      availableUsers.size !== context.availableUserMessageIds.length ||
      [...availableNodes].some((id) => typeof id !== "string" || !id.trim()) ||
      availableNodes.size !== context.availableStructureNodeIds.length) {
    throw new DomainRuleError("Extraction context message/source scopes are invalid.");
  }
  if (typeof context.threadId !== "string" || !context.threadId.trim() ||
      typeof context.bookRevisionId !== "string" || !context.bookRevisionId.trim()) {
    throw new DomainRuleError("Extraction context requires a Thread and BookRevision.");
  }

  const candidateIds = new Set<string>();
  const contentFingerprints = new Set<string>();
  for (const candidate of output.candidates) {
    if (!candidate || typeof candidate !== "object") {
      throw new DomainRuleError("Every extraction candidate must be an object.");
    }
    if (typeof candidate.id !== "string" || !candidate.id.trim() ||
        typeof candidate.title !== "string" || !candidate.title.trim() ||
        typeof candidate.content !== "string" || !candidate.content.trim()) {
      throw new DomainRuleError("Every candidate requires a non-empty id, title and content.");
    }
    if (candidateIds.has(candidate.id)) throw new DomainRuleError("Candidate IDs must be unique within one result.");
    candidateIds.add(candidate.id);
    if (!["user", "author", "assistant_inference"].includes(candidate.viewpoint)) {
      throw new DomainRuleError("Candidate viewpoint is invalid.");
    }
    if (typeof candidate.requiresBookCitation !== "boolean") {
      throw new DomainRuleError("Candidate requiresBookCitation must be boolean.");
    }
    if (!Array.isArray(candidate.sourceMessageIds) || candidate.sourceMessageIds.length === 0) {
      throw new DomainRuleError("Every candidate must cite at least one original message.");
    }
    if (new Set(candidate.sourceMessageIds).size !== candidate.sourceMessageIds.length) {
      throw new DomainRuleError("Candidate source message IDs must be unique.");
    }
    if (candidate.sourceMessageIds.some((id) => !availableMessages.has(id))) {
      throw new DomainRuleError("Candidate references a message outside the supplied Thread context.");
    }
    if (!candidate.sourceMessageIds.some((id) => availableUsers.has(id))) {
      throw new DomainRuleError("Every candidate must trace to at least one original user message.");
    }
    if (!Array.isArray(candidate.sourceReferences)) {
      throw new DomainRuleError("Candidate sourceReferences must be an array.");
    }
    const sourceKeys = new Set<string>();
    for (const reference of candidate.sourceReferences) {
      if (!reference || typeof reference !== "object") {
        throw new DomainRuleError("Candidate source references must be objects.");
      }
      if (reference.bookRevisionId !== context.bookRevisionId) {
        throw new DomainRuleError("Candidate citation belongs to a different BookRevision.");
      }
      if (!availableNodes.has(reference.structureNodeId)) {
        throw new DomainRuleError("Candidate citation references a structure node outside the supplied BookRevision.");
      }
      if (!reference.locator.trim()) throw new DomainRuleError("Candidate citation locator cannot be empty.");
      const key = JSON.stringify([reference.bookRevisionId, reference.structureNodeId, reference.locator]);
      if (sourceKeys.has(key)) throw new DomainRuleError("Candidate source references must be unique.");
      sourceKeys.add(key);
    }
    if (candidate.viewpoint === "author" && !candidate.requiresBookCitation) {
      throw new DomainRuleError("An author viewpoint must require a Book Citation.");
    }
    if (candidate.requiresBookCitation && candidate.sourceReferences.length === 0) {
      throw new DomainRuleError("A book-based candidate must include a Book Citation.");
    }
    const fingerprint = `${candidate.title.trim().toLocaleLowerCase()}::${candidate.content.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;
    if (contentFingerprints.has(fingerprint)) {
      throw new DomainRuleError("Duplicate candidates in one extraction result must be collapsed.");
    }
    contentFingerprints.add(fingerprint);
  }
  return structuredClone(output.candidates);
}

export function validateMemoryRelation(relation: MemoryRelation): MemoryRelation {
  if (!relation || typeof relation !== "object") {
    throw new DomainRuleError("MemoryRelation must be an object.");
  }
  if (typeof relation.id !== "string" || !relation.id.trim() ||
      typeof relation.fromVersionId !== "string" || !relation.fromVersionId.trim() ||
      typeof relation.toVersionId !== "string" || !relation.toVersionId.trim()) {
    throw new DomainRuleError("MemoryRelation requires id and both version endpoints.");
  }
  if (relation.fromVersionId === relation.toVersionId) {
    throw new DomainRuleError("A MemoryRelation cannot point to itself.");
  }
  if (typeof relation.createdAt !== "string" || !Number.isFinite(Date.parse(relation.createdAt))) {
    throw new DomainRuleError("MemoryRelation createdAt must be a valid date-time.");
  }
  if (!["supports", "contradicts", "extends", "supersedes", "retracts", "duplicate_of"].includes(relation.relationType)) {
    throw new DomainRuleError("MemoryRelation type is invalid.");
  }
  if (!Array.isArray(relation.sourceMessageIds) || relation.sourceMessageIds.length === 0) {
    throw new DomainRuleError("MemoryRelation requires source message provenance.");
  }
  if (new Set(relation.sourceMessageIds).size !== relation.sourceMessageIds.length ||
      relation.sourceMessageIds.some((id) => !id.trim())) {
    throw new DomainRuleError("MemoryRelation source message IDs must be unique and non-empty.");
  }
  if (!Array.isArray(relation.sourceReferences) || relation.sourceReferences.some((reference) =>
    !reference || typeof reference.bookRevisionId !== "string" || !reference.bookRevisionId.trim() ||
    typeof reference.structureNodeId !== "string" || !reference.structureNodeId.trim() ||
    typeof reference.locator !== "string" || !reference.locator.trim()
  )) {
    throw new DomainRuleError("MemoryRelation Book Citations must have complete locators.");
  }
  return structuredClone(relation);
}

/**
 * Validate an immutable version append and its optional cross-memory relation.
 * conflict/rejection/extension require explicit typed links; correction/supplement are
 * represented by the same memory's previousVersionId chain and need no cross-memory link.
 */
export function validateMemoryEvolution(
  previous: MemoryVersion | null,
  next: MemoryVersion,
  relation: MemoryRelation | null = null,
): { version: MemoryVersion; relation: MemoryRelation | null } {
  if (!["new", "supplement", "correction", "conflict", "rejection", "extension"].includes(next.changeKind)) {
    throw new DomainRuleError("MemoryVersion changeKind is invalid.");
  }
  const version = appendMemoryVersion(previous, next);
  const requiredRelation: Partial<Record<MemoryChangeKind, MemoryRelationType>> = {
    conflict: "contradicts",
    rejection: "retracts",
    extension: "extends",
  };
  const optionalRelation: Partial<Record<MemoryChangeKind, MemoryRelationType>> = {
    supplement: "supports",
    correction: "supersedes",
  };
  const required = requiredRelation[next.changeKind];
  const optional = optionalRelation[next.changeKind];

  if (required && relation === null) {
    throw new DomainRuleError(`Memory change "${next.changeKind}" requires a "${required}" relation.`);
  }
  if (relation === null) return { version, relation: null };

  const validatedRelation = validateMemoryRelation(relation);
  if (validatedRelation.fromVersionId !== next.id) {
    throw new DomainRuleError("MemoryRelation.fromVersionId must match the appended version.");
  }
  const expected = required || optional;
  if (!expected || validatedRelation.relationType !== expected) {
    throw new DomainRuleError(`Memory change "${next.changeKind}" cannot use relation "${validatedRelation.relationType}".`);
  }
  if (!validatedRelation.sourceMessageIds.some((id) => next.sourceMessageIds.includes(id))) {
    throw new DomainRuleError("MemoryRelation provenance must overlap the new MemoryVersion sources.");
  }
  return { version, relation: validatedRelation };
}
