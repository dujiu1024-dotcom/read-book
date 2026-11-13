export type GenerationStatus =
  | "queued"
  | "running"
  | "cancel_requested"
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
  requiredString(value.thread_id, "thread_id");
  requiredString(value.book_revision_id, "book_revision_id");
  requiredString(value.user_message.local_message_id, "user_message.local_message_id");
  requiredString(value.user_message.content, "user_message.content");
  if (value.user_message.content.length > 50_000) {
    throw new GenerationProtocolError("user_message.content exceeds 50000 characters.");
  }
  requiredString(value.context.current_source.structure_node_id, "context.current_source.structure_node_id");
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
}

export function validateGenerationAccepted(value: unknown): GenerationAccepted {
  const item = record(value);
  const status = item.status;
  if (status !== "queued" && status !== "running" && status !== "cancel_requested") {
    throw new GenerationProtocolError("GenerationAccepted has an invalid status.");
  }
  return {
    generation_id: requiredString(item.generation_id, "generation_id"),
    status,
    expires_at: validDate(item.expires_at, "expires_at"),
  };
}

export function validateGenerationSnapshot(value: unknown): GenerationSnapshot {
  const item = record(value);
  const statuses: GenerationStatus[] = [
    "queued", "running", "cancel_requested", "completed", "failed", "cancelled", "expired",
  ];
  if (!statuses.includes(item.status as GenerationStatus)) {
    throw new GenerationProtocolError("GenerationSnapshot has an invalid status.");
  }
  let result: GenerationResult | null = null;
  if (item.result !== null && item.result !== undefined) {
    const raw = record(item.result);
    result = {
      content: typeof raw.content === "string" ? raw.content : "",
      ...(typeof raw.content_hash === "string" ? { content_hash: raw.content_hash } : {}),
      ...(raw.usage === undefined ? {} : { usage: raw.usage as Record<string, unknown> | null }),
    };
  }
  if (item.status === "completed" && result === null) {
    throw new GenerationProtocolError("A completed generation must expose its final result.");
  }
  return {
    generation_id: requiredString(item.generation_id, "generation_id"),
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
  const item = validateGenerationEvent(value);
  const eventId = item.event_id;
  const generationId = item.generation_id;
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
  const item = record(value);
  const eventId = requiredString(item.event_id, "event_id");
  const generationId = requiredString(item.generation_id, "generation_id");
  if (generationId !== cursor.generationId) {
    throw new GenerationProtocolError("Generation event belongs to a different generation.");
  }
  const sequence = item.sequence;
  if (sequence < cursor.lastSequence || eventId === cursor.lastEventId) {
    return { cursor, duplicate: true };
  }
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
      requiredString(idempotencyKey, "Idempotency-Key");
      return validateGenerationAccepted(await transport.createGeneration(request, idempotencyKey));
    },
    async get(generationId: string): Promise<GenerationSnapshot> {
      requiredString(generationId, "generation_id");
      return validateGenerationSnapshot(await transport.getGeneration(generationId));
    },
    async cancel(generationId: string, idempotencyKey: string): Promise<GenerationAccepted> {
      requiredString(generationId, "generation_id");
      requiredString(idempotencyKey, "Idempotency-Key");
      return validateGenerationAccepted(await transport.cancelGeneration(generationId, idempotencyKey));
    },
    async stream(
      generationId: string,
      cursor: GenerationEventCursor,
      signal: AbortSignal,
      onEvent: (event: GenerationEvent) => void,
    ): Promise<GenerationEventCursor> {
      if (cursor.generationId !== generationId) {
        throw new GenerationProtocolError("Event cursor belongs to a different generation.");
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
  if (message.id !== request.user_message.local_message_id) {
    throw new GenerationProtocolError("Persisted message id must match request.local_message_id.");
  }
  if (message.threadId !== request.thread_id || message.content !== request.user_message.content) {
    throw new GenerationProtocolError("Persisted user message must match the generation request.");
  }
  await repository.saveUserMessage(message);
  return client.create(request, idempotencyKey);
}
