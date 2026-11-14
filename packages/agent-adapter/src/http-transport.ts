import type { GenerationRequest, GenerationTransport } from "./index.ts";

export class GenerationTransportError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, requestId: string | null, retryable: boolean) {
    super(message);
    this.name = "GenerationTransportError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
  }
}

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string.`);
  return value;
}

function validateIdempotencyKey(value: string): string {
  const key = requiredText(value, "Idempotency-Key");
  if (key.length < 16 || key.length > 128) throw new TypeError("Idempotency-Key length must be 16..128.");
  return key;
}

async function parseApiError(response: Response): Promise<GenerationTransportError> {
  let payload: Record<string, unknown> | null = null;
  try {
    const raw: unknown = await response.json();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) payload = raw as Record<string, unknown>;
  } catch {}
  const error = payload?.error && typeof payload.error === "object"
    ? payload.error as Record<string, unknown>
    : {};
  return new GenerationTransportError(
    response.status,
    typeof error.code === "string" ? error.code : "GENERATION_TRANSPORT_ERROR",
    typeof error.message === "string" ? error.message : `Generation API request failed (${response.status}).`,
    typeof payload?.request_id === "string" ? payload.request_id : null,
    error.retryable === true,
  );
}

function decodeSseFrame(frame: { id: string; event: string; data: string[] }): unknown {
  if (!frame.id) throw new Error("SSE frame is missing id.");
  if (!frame.event) throw new Error("SSE frame is missing event type.");
  if (frame.data.length === 0) throw new Error("SSE frame is missing data.");
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data.join("\n"));
  } catch {
    throw new Error("SSE frame data is not valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("SSE frame payload must be an object.");
  }
  const item = payload as Record<string, unknown>;
  if (item.event_id !== frame.id) throw new Error("SSE id does not match payload.event_id.");
  if (item.type !== frame.event) throw new Error("SSE event name does not match payload.type.");
  return item;
}

async function consumeSse(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: unknown) => void,
  maxFrameCharacters: number,
): Promise<void> {
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "text/event-stream") throw new Error("Generation events response must be text/event-stream.");
  if (!response.body) throw new Error("Generation events response has no readable body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id = "";
  let event = "";
  let data: string[] = [];

  const dispatch = () => {
    if (id || event || data.length) {
      onEvent(decodeSseFrame({ id, event, data }));
    }
    id = "";
    event = "";
    data = [];
  };

  const processLine = (line: string) => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      if (value.includes("\0")) throw new Error("SSE id contains a null character.");
      id = value;
    } else if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
    if (buffer.length + data.join("\n").length > maxFrameCharacters) {
      throw new Error("SSE event frame exceeds the configured size limit.");
    }
  };

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > maxFrameCharacters && !buffer.includes("\n\n")) {
        throw new Error("SSE buffer exceeds the configured size limit.");
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        processLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.length) {
      let line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      processLine(line);
    }
    if (id || event || data.length) dispatch();
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createHttpGenerationTransport({
  baseUrl,
  getAccessToken,
  fetchImpl = globalThis.fetch as FetchLike,
  maxSseFrameCharacters = 256_000,
}: {
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  fetchImpl?: FetchLike;
  maxSseFrameCharacters?: number;
}): GenerationTransport {
  requiredText(baseUrl, "baseUrl");
  if (typeof getAccessToken !== "function") throw new TypeError("getAccessToken must be a function.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  if (!Number.isInteger(maxSseFrameCharacters) || maxSseFrameCharacters < 1024) {
    throw new RangeError("maxSseFrameCharacters must be an integer >= 1024.");
  }
  const root = baseUrl.replace(/\/+$/, "") + "/";

  async function headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = requiredText(await getAccessToken(), "access token");
    return { Accept: "application/json", Authorization: `Bearer ${token}`, ...extra };
  }

  async function jsonRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetchImpl(new URL(path.replace(/^\/+/, ""), root), {
      ...init,
      headers: await headers((init.headers || {}) as Record<string, string>),
    });
    if (!response.ok) throw await parseApiError(response);
    try { return await response.json(); } catch { throw new Error("Generation API returned invalid JSON."); }
  }

  return {
    async createGeneration(request: GenerationRequest, idempotencyKey: string): Promise<unknown> {
      return jsonRequest("v1/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": validateIdempotencyKey(idempotencyKey) },
        body: JSON.stringify(request),
      });
    },

    async getGeneration(generationId: string): Promise<unknown> {
      const id = encodeURIComponent(requiredText(generationId, "generationId"));
      return jsonRequest(`v1/generations/${id}`, { method: "GET" });
    },

    async cancelGeneration(generationId: string, idempotencyKey: string): Promise<unknown> {
      const id = encodeURIComponent(requiredText(generationId, "generationId"));
      return jsonRequest(`v1/generations/${id}/cancel`, {
        method: "POST",
        headers: { "Idempotency-Key": validateIdempotencyKey(idempotencyKey) },
      });
    },

    async streamEvents(
      generationId: string,
      afterSequence: number,
      signal: AbortSignal,
      onEvent: (event: unknown) => void,
    ): Promise<void> {
      const id = encodeURIComponent(requiredText(generationId, "generationId"));
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError("afterSequence must be a non-negative integer.");
      if (signal.aborted) return;
      const url = new URL(`v1/generations/${id}/events`, root);
      url.searchParams.set("after", String(afterSequence));
      const response = await fetchImpl(url, {
        method: "GET",
        headers: await headers({ Accept: "text/event-stream", "Cache-Control": "no-cache" }),
        signal,
      });
      if (!response.ok) throw await parseApiError(response);
      await consumeSse(response, signal, onEvent, maxSseFrameCharacters);
    },
  };
}
