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
    current_source: { structure_node_id: string; excerpt: string };
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

export interface GenerationResult {
  content: string;
  content_hash?: string;
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
  if (typeof value.context.current_source.excerpt !== "string" || value.context.current_source.excerpt.length > 30_000) {
    throw new GenerationProtocolError("context.current_source.excerpt must be a string up to 30000 characters.");
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
    result = {
      content: raw.content,
      ...(typeof raw.content_hash === "string" ? { content_hash: raw.content_hash } : {}),
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
    transitionAssistantMessage(messageId: string, status: "completed" | "failed" | "cancelled", content?: string): Promise<unknown>;
    saveGenerationDelivery(delivery: { clientGenerationId: string; generationId: string | null; threadId: string; userMessageId: string; assistantMessageId: string; idempotencyKey: string; status: "queued" | "running" | "completed" | "failed" | "cancelled" | "expired"; lastSequence: number; lastEventId: string | null; expiresAt: string | null; updatedAt: string }): Promise<unknown>;
  }) => Promise<T>): Promise<T>;
  getGenerationDelivery(clientGenerationId: string): Promise<{ clientGenerationId: string; generationId: string | null; threadId: string; userMessageId: string; assistantMessageId: string; idempotencyKey: string; status: "queued" | "running" | "completed" | "failed" | "cancelled" | "expired"; lastSequence: number; lastEventId: string | null; expiresAt: string | null; updatedAt: string } | null>;  listPendingGenerationDeliveries(): Promise<Array<{ clientGenerationId: string; generationId: string | null; threadId: string; userMessageId: string; assistantMessageId: string; idempotencyKey: string; status: "queued" | "running" | "completed" | "failed" | "cancelled" | "expired"; lastSequence: number; lastEventId: string | null; expiresAt: string | null; updatedAt: string }>>;
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
  await repository.transaction(input.datasetId, async (tx) => {
    await tx.appendUserMessage({ ...input.userMessage, createdAt: now(), sourceReferences: input.sourceReferences, idempotencyKey: input.idempotencyKey });
    await tx.appendAssistantMessage({ id: input.assistantMessageId, threadId: input.userMessage.threadId, content: "", status: "generating", createdAt: now(), sourceReferences: [], idempotencyKey: input.idempotencyKey + ":assistant" });
    await tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: null, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status: "queued", lastSequence: 0, lastEventId: null, expiresAt: null, updatedAt: now() });
  });
  let accepted: GenerationAccepted;
  try {
    accepted = await client.create(input.request, input.idempotencyKey);
  } catch (error) {
    await repository.transaction(input.datasetId, async (tx) => {
      await tx.transitionAssistantMessage(input.assistantMessageId, "failed");
      await tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: null, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status: "failed", lastSequence: 0, lastEventId: null, expiresAt: null, updatedAt: now() });
    });
    throw error;
  }
  // If this local write fails, leave the queued receipt intact. Recovery retries create with the same idempotency key.
  await repository.transaction(input.datasetId, (tx) => tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: accepted.generation_id, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status: "running", lastSequence: 0, lastEventId: null, expiresAt: accepted.expires_at, updatedAt: now() }));
  let cursor: GenerationEventCursor = { generationId: accepted.generation_id, lastSequence: 0, lastEventId: null };
  let streamError: unknown = null;
  let persistEvents = Promise.resolve();
  try {
    cursor = await client.stream(accepted.generation_id, cursor, input.signal, (event) => {
      const next = advanceGenerationEventCursor({ generationId: accepted.generation_id, lastSequence: event.sequence - 1, lastEventId: null }, event).cursor;
      const status = event.type === "started" ? "running" : event.type === "failed" ? "failed" : event.type === "cancelled" ? "cancelled" : "running";
      persistEvents = persistEvents.then(() => repository.transaction(input.datasetId, (tx) => tx.saveGenerationDelivery({ clientGenerationId: input.request.client_generation_id, generationId: accepted.generation_id, threadId: input.userMessage.threadId, userMessageId: input.userMessage.id, assistantMessageId: input.assistantMessageId, idempotencyKey: input.idempotencyKey, status, lastSequence: next.lastSequence, lastEventId: event.event_id, expiresAt: accepted.expires_at, updatedAt: now() })));
      if (event.type === "delta") input.onDelta?.(event.text);
      if (event.type === "started") input.onStatus?.("running");
      if (event.type === "failed") input.onStatus?.("failed");
      if (event.type === "cancelled") input.onStatus?.("cancelled");
    });
    await persistEvents;
  } catch (error) {
    streamError = error;
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
      await tx.transitionAssistantMessage(input.assistantMessageId, "completed", snapshot.result!.content);
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
    : await client.create(input.request, delivery.idempotencyKey);
  let cursor: GenerationEventCursor = { generationId: accepted.generation_id, lastSequence: delivery.lastSequence, lastEventId: delivery.lastEventId };
  const persist = async (status: "running" | "failed" | "cancelled", sequence: number, eventId: string | null) =>
    repository.transaction(input.datasetId, (tx) => tx.saveGenerationDelivery({ ...delivery, generationId: accepted.generation_id, status, lastSequence: sequence, lastEventId: eventId, expiresAt: accepted.expires_at, updatedAt: now() }));
  await persist("running", cursor.lastSequence, cursor.lastEventId);
  let pendingWrites = Promise.resolve();
  await client.stream(accepted.generation_id, cursor, input.signal, (event) => {
    cursor = advanceGenerationEventCursor(cursor, event).cursor;
    const status = event.type === "failed" ? "failed" : event.type === "cancelled" ? "cancelled" : "running";
    const eventCursor = { ...cursor };
    pendingWrites = pendingWrites.then(() => persist(status, eventCursor.lastSequence, eventCursor.lastEventId));
    if (event.type === "delta") input.onDelta?.(event.text);
  });
  await pendingWrites;
  const snapshot = await client.get(accepted.generation_id);
  if (snapshot.status === "completed" && snapshot.result) {
    await repository.transaction(input.datasetId, async (tx) => {
      await tx.transitionAssistantMessage(delivery.assistantMessageId, "completed", snapshot.result!.content);
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
