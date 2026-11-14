export type GenerationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type AcceptedGenerationStatus = "queued" | "running" | "cancel_requested";

export interface GenerationRequest {
  client_generation_id: string;
  thread_id: string;
  book_revision_id: string;
  user_message: { local_message_id: string; content: string };
  context: {
    current_source: { structure_node_id: string; locator: string; excerpt: string };
    additional_sources?: Array<{ structure_node_id: string; locator: string; excerpt: string }>;
    recent_messages: Array<{ role: "user" | "assistant"; content: string }>;
    relevant_memory?: Array<Record<string, unknown>>;
    response_preferences?: { language?: string };
  };
}

export interface GenerationAccepted {
  generation_id: string;
  status: AcceptedGenerationStatus;
  expires_at: string;
}

export interface RelevantMemoryItem {
  memory_id: string;
  version_id: string;
  title: string;
  viewpoint: "user" | "author" | "assistant_inference";
  content: string;
  change_kind: string;
}

/**
 * Attach a small, already-selected memory slice to a generation request.
 * The full memory archive is never sent; recall must supply at most 5 effective versions.
 */
export function withRelevantMemory(
  request: GenerationRequest,
  memories: readonly RelevantMemoryItem[],
): GenerationRequest {
  if (memories.length > 5) {
    throw new GenerationProtocolError("relevant_memory must contain at most 5 items.");
  }
  const seen = new Set<string>();
  const relevant_memory = memories.map((memory) => {
    requiredString(memory.memory_id, "relevant_memory.memory_id");
    requiredString(memory.version_id, "relevant_memory.version_id");
    requiredString(memory.title, "relevant_memory.title");
    requiredString(memory.content, "relevant_memory.content");
    if (!["user", "author", "assistant_inference"].includes(memory.viewpoint)) {
      throw new GenerationProtocolError("relevant_memory.viewpoint is invalid.");
    }
    if (memory.content.length > 4000) {
      throw new GenerationProtocolError("relevant_memory.content exceeds 4000 characters.");
    }
    if (seen.has(memory.version_id)) {
      throw new GenerationProtocolError("relevant_memory contains a duplicate version.");
    }
    seen.add(memory.version_id);
    return {
      memory_id: memory.memory_id,
      version_id: memory.version_id,
      title: memory.title,
      viewpoint: memory.viewpoint,
      content: memory.content,
      change_kind: memory.change_kind,
    };
  });
  const next: GenerationRequest = {
    ...request,
    context: { ...request.context, relevant_memory },
  };
  validateGenerationRequest(next);
  return next;
}

export interface GenerationCitation {
  book_revision_id: string;
  structure_node_id: string;
  chunk_id: string;
  source_hash: string;
  locator: string;
  excerpt: string;
}

export interface GenerationResult {
  content: string;
  content_hash?: string;
  citations?: GenerationCitation[];
  usage?: Record<string, unknown> | null;
}

export interface GenerationSnapshot {
  generation_id: string;
  status: GenerationStatus;
  expires_at: string;
  result: GenerationResult | null;
  error_code?: string | null;
}

export type GenerationEvent =
  | { event_id: string; sequence: number; generation_id: string; type: "started" }
  | { event_id: string; sequence: number; generation_id: string; type: "delta"; text: string }
  | { event_id: string; sequence: number; generation_id: string; type: "completed"; result_available: true }
  | { event_id: string; sequence: number; generation_id: string; type: "failed"; code: string }
  | { event_id: string; sequence: number; generation_id: string; type: "cancelled" };

export interface GenerationEventCursor {
  generationId: string;
  lastSequence: number;
  lastEventId: string | null;
}

export interface PersistedUserMessage {
  id: string;
  threadId: string;
  content: string;
}

export interface GenerationTransport {
  createGeneration(request: GenerationRequest, idempotencyKey: string): Promise<unknown>;
  getGeneration(generationId: string): Promise<unknown>;
  cancelGeneration(generationId: string, idempotencyKey: string): Promise<unknown>;
  streamEvents(
    generationId: string,
    afterSequence: number,
    signal: AbortSignal,
    onEvent: (event: unknown) => void,
  ): Promise<void>;
}

export interface UserMessageRepository {
  /** Resolves only after the local transaction has committed. */
  saveUserMessage(message: PersistedUserMessage): Promise<void>;
}

export class GenerationProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationProtocolError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GenerationProtocolError("Expected an object response.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GenerationProtocolError(`"${field}" must be a non-empty string.`);
  }
  return value;
}

function boundedString(value: unknown, field: string, min: number, max: number): string {
  const text = requiredString(value, field);
  if (text.length < min || text.length > max) {
    throw new GenerationProtocolError(`"${field}" length must be between ${min} and ${max}.`);
  }
  return text;
}

function requiredUuid(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new GenerationProtocolError(`"${field}" must be a UUID.`);
  }
  return text;
}

function requiredSha256(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!/^[a-fA-F0-9]{64}$/.test(text)) {
    throw new GenerationProtocolError(`"${field}" must be a SHA-256 hex digest.`);
  }
  return text;
}

function validDate(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw new GenerationProtocolError(`"${field}" must be a valid date-time.`);
  }
  return text;
}

export function validateGenerationRequest(value: GenerationRequest): void {
  requiredString(value.client_generation_id, "client_generation_id");
  if (value.client_generation_id.length < 16 || value.client_generation_id.length > 128) {
    throw new GenerationProtocolError("client_generation_id length must be between 16 and 128.");
  }
  requiredUuid(value.thread_id, "thread_id");
  requiredUuid(value.book_revision_id, "book_revision_id");
  requiredUuid(value.user_message.local_message_id, "user_message.local_message_id");
  requiredString(value.user_message.content, "user_message.content");
  if (value.user_message.content.length > 50_000) {
    throw new GenerationProtocolError("user_message.content exceeds 50000 characters.");
  }
  requiredUuid(value.context.current_source.structure_node_id, "context.current_source.structure_node_id");
  boundedString(value.context.current_source.locator, "context.current_source.locator", 1, 512);
  if (typeof value.context.current_source.excerpt !== "string" || value.context.current_source.excerpt.length > 30_000) {
    throw new GenerationProtocolError("context.current_source.excerpt must be a string up to 30000 characters.");
  }
  if (value.context.additional_sources !== undefined) {
    if (!Array.isArray(value.context.additional_sources) || value.context.additional_sources.length > 7) {
      throw new GenerationProtocolError("context.additional_sources must contain at most 7 source nodes.");
    }
    const seen = new Set([
      value.context.current_source.structure_node_id + ":" + value.context.current_source.locator,
    ]);
    let sourceCharacters = value.context.current_source.excerpt.length;
    for (const [index, source] of value.context.additional_sources.entries()) {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new GenerationProtocolError("Every additional_sources item must be an object.");
      }
      requiredUuid(source.structure_node_id, `context.additional_sources[${index}].structure_node_id`);
      boundedString(source.locator, `context.additional_sources[${index}].locator`, 1, 512);
      if (typeof source.excerpt !== "string" || source.excerpt.length > 30_000) {
        throw new GenerationProtocolError("Each additional source excerpt must be a string up to 30000 characters.");
      }
      const key = source.structure_node_id + ":" + source.locator;
      if (seen.has(key)) throw new GenerationProtocolError("context.additional_sources contains a duplicate source node.");
      seen.add(key);
      sourceCharacters += source.excerpt.length;
    }
    if (sourceCharacters > 120_000) throw new GenerationProtocolError("Total source context exceeds 120000 characters.");
  }
  if (!Array.isArray(value.context.recent_messages) || value.context.recent_messages.length > 30) {
    throw new GenerationProtocolError("context.recent_messages must contain at most 30 messages.");
  }
  for (const message of value.context.recent_messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      throw new GenerationProtocolError("Recent message role must be user or assistant.");
    }
    if (typeof message.content !== "string" || message.content.length > 50_000) {
      throw new GenerationProtocolError("Recent message content must be a string up to 50000 characters.");
    }
  }
  if (value.context.relevant_memory && value.context.relevant_memory.length > 20) {
    throw new GenerationProtocolError("context.relevant_memory must contain at most 20 items.");
  }
  if (value.context.relevant_memory?.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new GenerationProtocolError("Every relevant_memory item must be an object.");
  }
  if (value.context.response_preferences) {
    const preferences = value.context.response_preferences;
    if (Object.keys(preferences).some((key) => key !== "language")) {
      throw new GenerationProtocolError("response_preferences only supports language.");
    }
    if (preferences.language !== undefined && typeof preferences.language !== "string") {
      throw new GenerationProtocolError("response_preferences.language must be a string.");
    }
  }
}

export function validateGenerationAccepted(value: unknown): GenerationAccepted {
  const item = record(value);
  const status = item.status;
  if (status !== "queued" && status !== "running" && status !== "cancel_requested") {
    throw new GenerationProtocolError("GenerationAccepted has an invalid status.");
  }
  return {
    generation_id: boundedString(item.generation_id, "generation_id", 16, 128),
    status,
    expires_at: validDate(item.expires_at, "expires_at"),
  };
}

export function validateGenerationSnapshot(value: unknown): GenerationSnapshot {
  const item = record(value);
  const statuses: GenerationStatus[] = [
    "queued", "running", "completed", "failed", "cancelled", "expired",
  ];
  if (!statuses.includes(item.status as GenerationStatus)) {
    throw new GenerationProtocolError("GenerationSnapshot has an invalid status.");
  }
  let result: GenerationResult | null = null;
  if (item.result !== null && item.result !== undefined) {
    const raw = record(item.result);
    if (typeof raw.content !== "string") {
      throw new GenerationProtocolError("Generation result content must be a string.");
    }
    let citations: GenerationCitation[] | undefined;
    if (raw.citations !== undefined) {
      if (!Array.isArray(raw.citations) || raw.citations.length > 20) {
        throw new GenerationProtocolError("Generation result citations must be an array with at most 20 items.");
      }
      citations = raw.citations.map((value, index) => {
        const citation = record(value);
        const excerpt = citation.excerpt;
        if (typeof excerpt !== "string" || !excerpt.trim() || excerpt.length > 2000) {
          throw new GenerationProtocolError("Generation citation excerpt must be a non-empty string up to 2000 characters.");
        }
        return {
          book_revision_id: requiredUuid(citation.book_revision_id, "result.citations[" + index + "].book_revision_id"),
          structure_node_id: requiredUuid(citation.structure_node_id, "result.citations[" + index + "].structure_node_id"),
          chunk_id: requiredUuid(citation.chunk_id, "result.citations[" + index + "].chunk_id"),
          source_hash: requiredSha256(citation.source_hash, "result.citations[" + index + "].source_hash"),
          locator: boundedString(citation.locator, "result.citations[" + index + "].locator", 1, 512),
          excerpt,
        };
      });
    }
    result = {
      content: raw.content,
      ...(typeof raw.content_hash === "string" ? { content_hash: raw.content_hash } : {}),
      ...(citations ? { citations } : {}),
      ...(raw.usage === undefined ? {} : { usage: raw.usage as Record<string, unknown> | null }),
    };
  }
  if (item.status === "completed" && result === null) {
    throw new GenerationProtocolError("A completed generation must expose its final result.");
  }
  return {
    generation_id: boundedString(item.generation_id, "generation_id", 16, 128),
    status: item.status as GenerationStatus,
    expires_at: validDate(item.expires_at, "expires_at"),
    result,
    ...(item.error_code === undefined ? {} : { error_code: item.error_code as string | null }),
  };
}

function generationSourceMap(request: GenerationRequest): Map<string, { bookRevisionId: string; structureNodeId: string; locator: string; excerpt: string }> {
  const sources = [request.context.current_source, ...(request.context.additional_sources || [])];
  return new Map(sources.map((source) => [
    source.structure_node_id + ":" + source.locator,
    {
      bookRevisionId: request.book_revision_id,
      structureNodeId: source.structure_node_id,
      locator: source.locator,
      excerpt: source.excerpt.replace(/\s+/g, " ").trim(),
    },
  ]));
}

function citationMatchesSource(
  citation: GenerationCitation,
  source: { bookRevisionId: string; structureNodeId: string; locator: string; excerpt: string } | undefined,
): boolean {
  if (!source || citation.book_revision_id !== source.bookRevisionId ||
      citation.structure_node_id !== source.structureNodeId || citation.locator !== source.locator ||
      !citation.excerpt?.trim()) return false;
  return source.excerpt.includes(citation.excerpt.replace(/\s+/g, " ").trim());
}

export function verifiedGenerationSourceReferences(
  result: GenerationResult,
  request: GenerationRequest,
): Array<{ bookRevisionId: string; structureNodeId: string; locator: string }> {
  const sources = generationSourceMap(request);
  const references = new Map<string, { bookRevisionId: string; structureNodeId: string; locator: string }>();
  for (const citation of result.citations || []) {
    const key = citation.structure_node_id + ":" + citation.locator;
    const source = sources.get(key);
    if (!citationMatchesSource(citation, source)) continue;
    references.set(key, {
      bookRevisionId: source!.bookRevisionId,
      structureNodeId: source!.structureNodeId,
      locator: source!.locator,
    });
  }
  return [...references.values()];
}

export function verifiedGenerationCitationRecords(
  result: GenerationResult,
  request: GenerationRequest,
  messageId: string,
  threadId: string,
  createdAt: string,
): Array<{
  id: string;
  threadId: string;
  messageId: string;
  bookRevisionId: string;
  structureNodeId: string;
  chunkId: string;
  locator: string;
  excerpt: string;
  excerptHash: string | null;
  sourceHash: string;
  createdAt: string;
}> {
  const sources = generationSourceMap(request);
  const references = verifiedGenerationSourceReferences(result, request);
  return references.flatMap((reference) => {
    const key = reference.structureNodeId + ":" + reference.locator;
    const source = sources.get(key);
    const citation = (result.citations || []).find((item) => citationMatchesSource(item, source));
    if (!citation?.excerpt) return [];
    return [{
      id: crypto.randomUUID(),
      threadId,
      messageId,
      bookRevisionId: reference.bookRevisionId,
      structureNodeId: reference.structureNodeId,
      chunkId: citation.chunk_id,
      locator: reference.locator,
      excerpt: citation.excerpt,
      excerptHash: null,
      sourceHash: citation.source_hash,
      createdAt,
    }];
  });
}

/** SSE deltas are provisional; only a completed GET snapshot is authoritative. */
export function authoritativeFinalResult(snapshot: GenerationSnapshot): GenerationResult | null {
  return snapshot.status === "completed" ? snapshot.result : null;
}

export function validateGenerationEvent(value: unknown): GenerationEvent {
  const item = record(value);
  const eventId = boundedString(item.event_id, "event_id", 1, 128);
  const generationId = boundedString(item.generation_id, "generation_id", 16, 128);
  if (!Number.isInteger(item.sequence) || (item.sequence as number) < 1) {
    throw new GenerationProtocolError("Generation event sequence must be a positive integer.");
  }
  switch (item.type) {
    case "started":
      return { event_id: eventId, generation_id: generationId, sequence: item.sequence as number, type: "started" };
    case "delta":
      if (typeof item.text !== "string") throw new GenerationProtocolError("Delta event text must be a string.");
      return { event_id: eventId, generation_id: generationId, sequence: item.sequence as number, type: "delta", text: item.text };
    case "completed":
      if (item.result_available !== true) throw new GenerationProtocolError("Completed event must signal result availability.");
      return { event_id: eventId, generation_id: generationId, sequence: item.sequence as number, type: "completed", result_available: true };
    case "failed":
      return { event_id: eventId, generation_id: generationId, sequence: item.sequence as number, type: "failed", code: requiredString(item.code, "code") };
    case "cancelled":
      return { event_id: eventId, generation_id: generationId, sequence: item.sequence as number, type: "cancelled" };
    default:
      throw new GenerationProtocolError("Unknown generation event type.");
  }
}

export function advanceGenerationEventCursor(
  cursor: GenerationEventCursor,
  value: unknown,
): { cursor: GenerationEventCursor; duplicate: boolean } {
  const item = validateGenerationEvent(value);
  const eventId = item.event_id;
  const generationId = item.generation_id;
  if (generationId !== cursor.generationId) {
    throw new GenerationProtocolError("Generation event belongs to a different generation.");
  }
  if (!Number.isSafeInteger(cursor.lastSequence) || cursor.lastSequence < 0) {
    throw new GenerationProtocolError("Event cursor lastSequence must be a non-negative integer.");
  }
  const sequence = item.sequence;
  if (eventId === cursor.lastEventId) {
    if (sequence !== cursor.lastSequence) {
      throw new GenerationProtocolError("A replayed event ID has a conflicting sequence.");
    }
    return { cursor, duplicate: true };
  }
  if (sequence < cursor.lastSequence) return { cursor, duplicate: true };
  if (sequence === cursor.lastSequence) {
    throw new GenerationProtocolError("Conflicting generation events share the same sequence.");
  }
  if (sequence !== cursor.lastSequence + 1) {
    throw new GenerationProtocolError("Generation event sequence gap detected.");
  }
  return {
    cursor: { generationId, lastSequence: sequence, lastEventId: eventId },
    duplicate: false,
  };
}

export function createGenerationClient(transport: GenerationTransport) {
  return Object.freeze({
    async create(request: GenerationRequest, idempotencyKey: string): Promise<GenerationAccepted> {
      validateGenerationRequest(request);
      boundedString(idempotencyKey, "Idempotency-Key", 16, 128);
      return validateGenerationAccepted(await transport.createGeneration(request, idempotencyKey));
    },
    async get(generationId: string): Promise<GenerationSnapshot> {
      boundedString(generationId, "generation_id", 16, 128);
      return validateGenerationSnapshot(await transport.getGeneration(generationId));
    },
    async cancel(generationId: string, idempotencyKey: string): Promise<GenerationAccepted> {
      boundedString(generationId, "generation_id", 16, 128);
      boundedString(idempotencyKey, "Idempotency-Key", 16, 128);
      return validateGenerationAccepted(await transport.cancelGeneration(generationId, idempotencyKey));
    },
    async stream(
      generationId: string,
      cursor: GenerationEventCursor,
      signal: AbortSignal,
      onEvent: (event: GenerationEvent) => void,
    ): Promise<GenerationEventCursor> {
      boundedString(generationId, "generation_id", 16, 128);
      boundedString(cursor.generationId, "cursor.generationId", 16, 128);
      if (cursor.generationId !== generationId) {
        throw new GenerationProtocolError("Event cursor belongs to a different generation.");
      }
      if (!Number.isSafeInteger(cursor.lastSequence) || cursor.lastSequence < 0) {
        throw new GenerationProtocolError("Event cursor lastSequence must be a non-negative integer.");
      }
      let currentCursor = { ...cursor };
      await transport.streamEvents(generationId, currentCursor.lastSequence, signal, (raw) => {
        const result = advanceGenerationEventCursor(currentCursor, raw);
        if (result.duplicate) return;
        currentCursor = result.cursor;
        onEvent(validateGenerationEvent(raw));
      });
      return currentCursor;
    },
  });
}

/** Enforces the product invariant: persist the user's original input before any generation request. */
export async function persistUserMessageBeforeGeneration(
  repository: UserMessageRepository,
  client: ReturnType<typeof createGenerationClient>,
  message: PersistedUserMessage,
  request: GenerationRequest,
  idempotencyKey: string,
): Promise<GenerationAccepted> {
  validateGenerationRequest(request);
  requiredString(idempotencyKey, "Idempotency-Key");
  requiredUuid(message.id, "persisted message id");
  if (message.id !== request.user_message.local_message_id) {
    throw new GenerationProtocolError("Persisted message id must match request.local_message_id.");
  }
  if (message.threadId !== request.thread_id || message.content !== request.user_message.content) {
    throw new GenerationProtocolError("Persisted user message must match the generation request.");
  }
  await repository.saveUserMessage(message);
  return client.create(request, idempotencyKey);
}

export interface GenerationTurnRepository {
  transaction<T>(datasetId: string, operation: (tx: {
    appendUserMessage(message: { id: string; threadId: string; content: string; createdAt: string; sourceReferences: Array<{ bookRevisionId: string; structureNodeId: string; locator: string }> ; idempotencyKey: string }): Promise<unknown>;
    appendAssistantMessage(message: { id: string; threadId: string; content: string; status: "generating"; createdAt: string; sourceReferences: Array<{ bookRevisionId: string; structureNodeId: string; locator: string }> ; idempotencyKey: string }): Promise<unknown>;
    transitionAssistantMessage(messageId: string, status: "completed" | "failed" | "cancelled", content?: string, sourceReferences?: Array<{ bookRevisionId: string; structureNodeId: string; locator: string }>): Promise<unknown>;
    saveCitation(citation: { id: string; threadId: string; messageId: string; bookRevisionId: string; structureNodeId: string; chunkId: string; locator: string; excerpt: string; excerptHash: string | null; sourceHash: string; createdAt: string }): Promise<unknown>;
    saveGenerationDelivery(delivery: { clientGenerationId: string; generationId: string | null; threadId: string; userMessageId: string; assistantMessageId: string; idempotencyKey: string; status: "queued" | "running" | "completed" | "failed" | "cancelled" | "expired"; lastSequence: number; lastEventId: string | null; expiresAt: string | null; updatedAt: string }): Promise<unknown>;
  }) => Promise<T>): Promise<T>;
  getGenerationDelivery(clientGenerationId: string): Promise<{ clientGenerationId: string; generationId: string | null; threadId: string; userMessageId: string; assistantMessageId: string; idempotencyKey: string; status: "queued" | "running" | "completed" | "failed" | "cancelled" | "expired"; lastSequence: number; lastEventId: string | null; expiresAt: string | null; updatedAt: string } | null>;
  listPendingGenerationDeliveries(): Promise<Array<{ clientGenerationId: string; generationId: string | null; threadId: string; userMessageId: string; assistantMessageId: string; idempotencyKey: string; status: "queued" | "running" | "completed" | "failed" | "cancelled" | "expired"; lastSequence: number; lastEventId: string | null; expiresAt: string | null; updatedAt: string }>>;
}

export interface GenerationTurnInput {
  datasetId: string;
  userMessage: PersistedUserMessage;
  assistantMessageId: string;
  request: GenerationRequest;
  idempotencyKey: string;
  sourceReferences: Array<{ bookRevisionId: string; structureNodeId: string; locator: string }>;
  now?: () => string;
  signal: AbortSignal;
  onDelta?: (text: string) => void;
  onStatus?: (status: GenerationStatus) => void;
  /** Called only after the local transaction containing both messages and delivery receipt commits. */
  onPersisted?: () => void;
  /** Reuses an already-persisted user message when creating a new assistant attempt. */
  reuseExistingUserMessage?: boolean;
}

export interface GenerationTurnResult {
  accepted: GenerationAccepted;
  snapshot: GenerationSnapshot;
  assistantMessageId: string;
  lastCursor: GenerationEventCursor;
}

/** Persists both sides of a conversation turn before network work; only GET completed results become durable assistant content. */
export async function runGenerationTurn(
  repository: GenerationTurnRepository,
  client: ReturnType<typeof createGenerationClient>,
  input: GenerationTurnInput,
): Promise<GenerationTurnResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.userMessage.threadId !== input.request.thread_id || input.userMessage.id !== input.request.user_message.local_message_id) {
    throw new GenerationProtocolError("Conversation turn message does not match generation request.");
  }
  // Repeated submit must reuse the durable delivery instead of appending a second pair of messages.
  const existing = await repository.getGenerationDelivery(input.request.client_generation_id);
  if (existing) {
    if (existing.idempotencyKey !== input.idempotencyKey || existing.userMessageId !== input.userMessage.id || existing.assistantMessageId !== input.assistantMessageId || existing.threadId !== input.userMessage.threadId) {
      throw new GenerationProtocolError("A generation delivery already exists with different message or idempotency identity.");
    }
    if (existing.status === "queued" || existing.status === "running") {
      return recoverGenerationTurn(repository, client, { datasetId: input.datasetId, clientGenerationId: input.request.client_generation_id, request: input.request, signal: input.signal, now: input.now, onDelta: input.onDelta, onStatus: input.onStatus });
    }
    if (!existing.generationId) throw new GenerationProtocolError("Terminal generation delivery has no server generation identity.");
    const snapshot = await client.get(existing.generationId);
    const accepted: GenerationAccepted = { generation_id: existing.generationId, status: "running", expires_at: existing.expiresAt ?? snapshot.expires_at };
    return { accepted, snapshot, assistantMessageId: existing.assistantMessageId, lastCursor: { generationId: existing.generationId, lastSequence: existing.lastSequence, lastEventId: existing.lastEventId } };
  }
  await repository.transaction(input.datasetId, async (tx) => {
    if (!input.reuseExistingUserMessage) {
      await tx.appendUserMessage({ ...input.userMessage, createdAt: now(), sourceReferences: input.sourceReferences, idempotencyKey: input.idempotencyKey });
    }
    await tx.appendAssistantMessage({ id: input.assistantMessageId, threadId: input.userMessage.threadId, content: "", status: "generating", createdAt: now(), sourceReferences: [], idempotencyKey: input.idempotencyKey + ":assistant" });
    await tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: null, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status: "queued", lastSequence: 0, lastEventId: null, expiresAt: null, updatedAt: now() });
  });
  input.onPersisted?.();
  let accepted: GenerationAccepted;
  try {
    accepted = await client.create(input.request, input.idempotencyKey);
  } catch (error) {
    // No server generation identity came back, so there is no session identity to resume: fail the
    // placeholder explicitly instead of leaving the user with a permanently "generating" message.
    await failUnidentifiedDelivery(repository, input.datasetId, {
      clientGenerationId: input.request.client_generation_id,
      generationId: null,
      threadId: input.userMessage.threadId,
      userMessageId: input.userMessage.id,
      assistantMessageId: input.assistantMessageId,
      idempotencyKey: input.idempotencyKey,
      status: "queued",
      lastSequence: 0,
      lastEventId: null,
      expiresAt: null,
      updatedAt: now(),
    }, now);
    throw error;
  }
  // If this local write fails, leave the queued receipt intact. Recovery retries create with the same idempotency key.
  await repository.transaction(input.datasetId, (tx) => tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: accepted.generation_id, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status: "running", lastSequence: 0, lastEventId: null, expiresAt: accepted.expires_at, updatedAt: now() }));
  let cursor: GenerationEventCursor = { generationId: accepted.generation_id, lastSequence: 0, lastEventId: null };
  let streamError: unknown = null;
  let persistEvents = Promise.resolve();
  try {
    cursor = await client.stream(accepted.generation_id, cursor, input.signal, (event) => {
      cursor = advanceGenerationEventCursor(cursor, event).cursor;
      const eventCursor = { ...cursor };
      const status = event.type === "started" ? "running" : event.type === "failed" ? "failed" : event.type === "cancelled" ? "cancelled" : "running";
      persistEvents = persistEvents.then(() => repository.transaction(input.datasetId, (tx) => tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: accepted.generation_id, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status, lastSequence: eventCursor.lastSequence, lastEventId: eventCursor.lastEventId, expiresAt: accepted.expires_at, updatedAt: now() })));
      if (event.type === "delta") input.onDelta?.(event.text);
      if (event.type === "started") input.onStatus?.("running");
      if (event.type === "failed") input.onStatus?.("failed");
      if (event.type === "cancelled") input.onStatus?.("cancelled");
    });
    await persistEvents;
  } catch (error) {
    streamError = error;
  }
  try {
    await persistEvents;
  } catch (error) {
    streamError ??= error;
  }
  if (input.signal.aborted) {
    await client.cancel(accepted.generation_id, input.idempotencyKey + ":cancel").catch(() => undefined);
  }
  let snapshot: GenerationSnapshot;
  try {
    snapshot = await client.get(accepted.generation_id);
  } catch (error) {
    if (input.signal.aborted) {
      await client.cancel(accepted.generation_id, input.idempotencyKey + ":cancel").catch(() => undefined);
      await repository.transaction(input.datasetId, async (tx) => {
        await tx.transitionAssistantMessage(input.assistantMessageId, "cancelled");
        await tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: accepted.generation_id, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status: "cancelled", lastSequence: cursor.lastSequence, lastEventId: cursor.lastEventId, expiresAt: accepted.expires_at, updatedAt: now() });
      });
    }
    throw streamError ?? error;
  }
  if (snapshot.status === "completed" && snapshot.result) {
    await repository.transaction(input.datasetId, async (tx) => {
      await tx.transitionAssistantMessage(input.assistantMessageId, "completed", snapshot.result!.content, verifiedGenerationSourceReferences(snapshot.result!, input.request));
      for (const citation of verifiedGenerationCitationRecords(snapshot.result!, input.request, input.assistantMessageId, input.userMessage.threadId, now())) await tx.saveCitation(citation);
      await tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: accepted.generation_id, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status: "completed", lastSequence: cursor.lastSequence, lastEventId: cursor.lastEventId, expiresAt: snapshot.expires_at, updatedAt: now() });
    });
  } else if (snapshot.status === "failed" || snapshot.status === "expired") {
    await repository.transaction(input.datasetId, async (tx) => {
      await tx.transitionAssistantMessage(input.assistantMessageId, "failed");
      await tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: accepted.generation_id, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status: snapshot.status, lastSequence: cursor.lastSequence, lastEventId: cursor.lastEventId, expiresAt: snapshot.expires_at, updatedAt: now() });
    });
  } else if (snapshot.status === "cancelled") {
    await repository.transaction(input.datasetId, async (tx) => {
      await tx.transitionAssistantMessage(input.assistantMessageId, "cancelled");
      await tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: accepted.generation_id, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status: "cancelled", lastSequence: cursor.lastSequence, lastEventId: cursor.lastEventId, expiresAt: snapshot.expires_at, updatedAt: now() });
    });
  }
  input.onStatus?.(snapshot.status);
  return { accepted, snapshot, assistantMessageId: input.assistantMessageId, lastCursor: cursor };
}

type PersistedGenerationDelivery = NonNullable<Awaited<ReturnType<GenerationTurnRepository["getGenerationDelivery"]>>>;

/**
 * A create request that never returned a server generation identity leaves nothing to resume:
 * land the placeholder and its receipt in an explicit failed state so the user can retry
 * instead of an assistant message that stays "generating" forever.
 */
async function failUnidentifiedDelivery(
  repository: GenerationTurnRepository,
  datasetId: string,
  delivery: PersistedGenerationDelivery,
  now: () => string,
): Promise<void> {
  await repository.transaction(datasetId, async (tx) => {
    await tx.transitionAssistantMessage(delivery.assistantMessageId, "failed");
    await tx.saveGenerationDelivery({ ...delivery, generationId: delivery.generationId, status: "failed", updatedAt: now() });
  });
}

/** Resume a queued/running delivery after reload using its durable generation identity and SSE cursor. */
export async function recoverGenerationTurn(
  repository: GenerationTurnRepository,
  client: ReturnType<typeof createGenerationClient>,
  input: { datasetId: string; clientGenerationId: string; request: GenerationRequest; signal: AbortSignal; now?: () => string; onDelta?: (text: string) => void; onStatus?: (status: GenerationStatus) => void },
): Promise<GenerationTurnResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const delivery = await repository.getGenerationDelivery(input.clientGenerationId);
  if (!delivery) throw new GenerationProtocolError("Generation delivery was not found locally.");
  if (delivery.status !== "queued" && delivery.status !== "running") throw new GenerationProtocolError("Only queued or running generation deliveries can be resumed.");
  if (delivery.clientGenerationId !== input.request.client_generation_id) throw new GenerationProtocolError("Recovery request does not match the persisted delivery.");
  const accepted = delivery.generationId
    ? { generation_id: delivery.generationId, status: "running" as const, expires_at: delivery.expiresAt ?? now() }
    : await client.create(input.request, delivery.idempotencyKey).catch(async (error: unknown) => {
      // Without a server identity this delivery cannot be resumed, so it must not stay queued forever.
      await failUnidentifiedDelivery(repository, input.datasetId, delivery, now);
      throw error;
    });
  let cursor: GenerationEventCursor = { generationId: accepted.generation_id, lastSequence: delivery.lastSequence, lastEventId: delivery.lastEventId };
  const persist = async (status: "running" | "failed" | "cancelled", sequence: number, eventId: string | null) =>
    repository.transaction(input.datasetId, (tx) => tx.saveGenerationDelivery({ ...delivery, generationId: accepted.generation_id, status, lastSequence: sequence, lastEventId: eventId, expiresAt: accepted.expires_at, updatedAt: now() }));
  await persist("running", cursor.lastSequence, cursor.lastEventId);
  let pendingWrites = Promise.resolve();
  try {
    await client.stream(accepted.generation_id, cursor, input.signal, (event) => {
      cursor = advanceGenerationEventCursor(cursor, event).cursor;
      const status = event.type === "failed" ? "failed" : event.type === "cancelled" ? "cancelled" : "running";
      const eventCursor = { ...cursor };
      pendingWrites = pendingWrites.then(() => persist(status, eventCursor.lastSequence, eventCursor.lastEventId));
      if (event.type === "delta") input.onDelta?.(event.text);
    });
    await pendingWrites;
  } catch (error) {
    await pendingWrites;
    if (!input.signal.aborted) throw error;
    await client.cancel(accepted.generation_id, delivery.idempotencyKey + ":cancel").catch(() => undefined);
  }
  const snapshot = await client.get(accepted.generation_id);
  if (snapshot.status === "completed" && snapshot.result) {
    await repository.transaction(input.datasetId, async (tx) => {
      await tx.transitionAssistantMessage(delivery.assistantMessageId, "completed", snapshot.result!.content, verifiedGenerationSourceReferences(snapshot.result!, input.request));
      for (const citation of verifiedGenerationCitationRecords(snapshot.result!, input.request, delivery.assistantMessageId, delivery.threadId, now())) await tx.saveCitation(citation);
      await tx.saveGenerationDelivery({ ...delivery, generationId: accepted.generation_id, status: "completed", lastSequence: cursor.lastSequence, lastEventId: cursor.lastEventId, expiresAt: snapshot.expires_at, updatedAt: now() });
    });
  } else if (snapshot.status === "failed" || snapshot.status === "expired" || snapshot.status === "cancelled") {
    const messageStatus = snapshot.status === "cancelled" ? "cancelled" : "failed";
    await repository.transaction(input.datasetId, async (tx) => {
      await tx.transitionAssistantMessage(delivery.assistantMessageId, messageStatus);
      await tx.saveGenerationDelivery({ ...delivery, generationId: accepted.generation_id, status: snapshot.status, lastSequence: cursor.lastSequence, lastEventId: cursor.lastEventId, expiresAt: snapshot.expires_at, updatedAt: now() });
    });
  }
  input.onStatus?.(snapshot.status);
  return { accepted, snapshot, assistantMessageId: delivery.assistantMessageId, lastCursor: cursor };
}

export interface GenerationTurnControllerOptions {
  onDelta?: (clientGenerationId: string, text: string) => void;
  onStatus?: (clientGenerationId: string, status: GenerationStatus) => void;
}

export interface GenerationTurnController {
  /** Submit one turn. The controller owns its AbortController so the caller can stop it explicitly. */
  send(input: Omit<GenerationTurnInput, "signal">): Promise<GenerationTurnResult>;
  /** Resume one durable queued/running delivery after the caller has rebuilt its request context. */
  resume(input: {
    datasetId: string;
    clientGenerationId: string;
    request: GenerationRequest;
    now?: () => string;
  }): Promise<GenerationTurnResult>;
  /** Resume all durable pending deliveries in creation order. */
  resumePending(
    requestForDelivery: (delivery: NonNullable<Awaited<ReturnType<GenerationTurnRepository["getGenerationDelivery"]>>>) => Promise<GenerationRequest>,
    options?: { now?: () => string; threadId?: string; onDelta?: (clientGenerationId: string, text: string) => void; onStatus?: (clientGenerationId: string, status: GenerationStatus) => void; onError?: (clientGenerationId: string, error: unknown) => void },
  ): Promise<GenerationTurnResult[]>;
  stop(): void;
  isBusy(): boolean;
}

/**
 * UI-facing lifecycle boundary for a single reader conversation.
 * It centralizes cancellation and reload recovery without coupling the UI to transport details.
 * The caller remains responsible for rendering provisional deltas and reloading persisted messages.
 */
export function createGenerationTurnController(
  repository: GenerationTurnRepository,
  client: ReturnType<typeof createGenerationClient>,
  datasetId: string,
  options: GenerationTurnControllerOptions = {},
): GenerationTurnController {
  let activeController: AbortController | null = null;

  async function execute<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (activeController) {
      throw new GenerationProtocolError("A generation turn is already active for this conversation.");
    }
    const controller = new AbortController();
    activeController = controller;
    try {
      return await operation(controller.signal);
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  return Object.freeze({
    send(input: Omit<GenerationTurnInput, "signal">) {
      if (input.datasetId !== datasetId) return Promise.reject(new GenerationProtocolError("Conversation controller is bound to a different local dataset."));
      return execute((signal) => runGenerationTurn(repository, client, {
        ...input,
        signal,
        onDelta: (text) => { input.onDelta?.(text); options.onDelta?.(input.request.client_generation_id, text); },
        onStatus: (status) => { input.onStatus?.(status); options.onStatus?.(input.request.client_generation_id, status); },
      }));
    },
    resume(input: { datasetId: string; clientGenerationId: string; request: GenerationRequest; now?: () => string }) {
      if (input.datasetId !== datasetId) return Promise.reject(new GenerationProtocolError("Conversation controller is bound to a different local dataset."));
      return execute((signal) => recoverGenerationTurn(repository, client, {
        ...input,
        signal,
        onDelta: (text) => { options.onDelta?.(input.clientGenerationId, text); },
        onStatus: (status) => options.onStatus?.(input.clientGenerationId, status),
      }));
    },
    resumePending(requestForDelivery, resumeOptions = {}) {
      return execute(async (signal) => {
        const pending = (await repository.listPendingGenerationDeliveries()).filter((delivery) => !resumeOptions.threadId || delivery.threadId === resumeOptions.threadId);
        const results: GenerationTurnResult[] = [];
        for (const delivery of pending) {
          if (signal.aborted) break;
          try {
            const request = await requestForDelivery(delivery);
            if (request.client_generation_id !== delivery.clientGenerationId) {
              throw new GenerationProtocolError("Recovery request does not match its pending delivery.");
            }
            results.push(await recoverGenerationTurn(repository, client, {
              datasetId,
              clientGenerationId: delivery.clientGenerationId,
              request,
              signal,
              now: resumeOptions.now,
              onDelta: (text) => { resumeOptions.onDelta?.(delivery.clientGenerationId, text); options.onDelta?.(delivery.clientGenerationId, text); },
              onStatus: (status) => { resumeOptions.onStatus?.(delivery.clientGenerationId, status); options.onStatus?.(delivery.clientGenerationId, status); },
            }));
          } catch (error) {
            // One broken delivery (for example an outdated task left by a previous app version) must not
            // stop the rest of the batch. The failing delivery is reported and already marked failed
            // when it has no server identity to resume from.
            resumeOptions.onError?.(delivery.clientGenerationId, error);
          }
        }
        return results;
      });
    },
    stop() {
      activeController?.abort();
    },
    isBusy() {
      return activeController !== null;
    },
  });
}

export * from "./memory-extraction.ts";
export * from "./openai-compatible-memory-provider.ts";
