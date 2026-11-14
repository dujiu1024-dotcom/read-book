import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../..");

function loadEnvFile(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return; }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(resolve(repositoryRoot, ".env"));

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.SENSENOVA_API_KEY || "";
const BASE_URL = (process.env.SENSENOVA_BASE_URL || "https://token.sensenova.cn/v1").replace(/\/+$/, "");
const MODEL = process.env.SENSENOVA_MODEL || "sensenova-6.8-flash";
const THINKING = process.env.SENSENOVA_THINKING === "enabled" ? "enabled" : "disabled";
const LOCAL_AUTH_TOKEN = process.env.LOCAL_AUTH_TOKEN || "local-dev-token";
const CORS_ORIGINS = new Set((process.env.CORS_ORIGINS || "http://127.0.0.1:5178,http://localhost:5178").split(",").map((item) => item.trim()).filter(Boolean));
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 120_000;

if (!API_KEY) {
  console.error("缺少 SENSENOVA_API_KEY：请在仓库根目录 .env 中配置后再启动。");
  process.exit(1);
}

const tasks = new Map();
const idempotency = new Map();

function log(event, fields = {}) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + "\n");
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function apiError(res, status, code, message, retryable = false) {
  json(res, status, { error: { code, message, retryable }, request_id: randomUUID() });
}
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.has(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "Authorization,Content-Type,Idempotency-Key,Cache-Control,Last-Event-ID");
    res.setHeader("access-control-max-age", "600");
    res.setHeader("vary", "Origin");
  }
}
function authorized(req) {
  const header = req.headers.authorization || "";
  return header === "Bearer " + LOCAL_AUTH_TOKEN;
}
async function readBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function validateRequest(body) {
  if (!body || typeof body !== "object") throw new Error("请求体必须是 JSON 对象。");
  if (typeof body.client_generation_id !== "string" || body.client_generation_id.length < 16) throw new Error("client_generation_id 非法。");
  if (!isUuid(body.thread_id)) throw new Error("thread_id 必须是 UUID。");
  if (!isUuid(body.book_revision_id)) throw new Error("book_revision_id 必须是 UUID。");
  if (!body.user_message || typeof body.user_message.content !== "string" || !body.user_message.content.trim()) {
    throw new Error("user_message.content 不能为空。");
  }
  const context = body.context;
  if (!context || !context.current_source || !Array.isArray(context.recent_messages)) {
    throw new Error("context.current_source 与 context.recent_messages 为必填项。");
  }
  if (!isUuid(context.current_source.structure_node_id) || typeof context.current_source.locator !== "string" || typeof context.current_source.excerpt !== "string") {
    throw new Error("context.current_source 字段不完整。");
  }
  return body;
}

const SYSTEM_PROMPT = [
  "你是「知行」阅读 Agent，任务是和用户一起读一本书。",
  "回答必须依据本轮提供的原书片段和最近讨论；不要编造原文、页码或作者没有表达的观点。",
  "如果原文不足以回答，直接说明缺少依据，并指出还需要哪一段原文。",
  "回答保持简洁、具体，使用中文；可以先回应问题，再引述原文中的关键句（用引号）。",
].join("\n");

function normalizeSpace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}
function buildMessages(request) {
  const context = request.context;
  const sources = [context.current_source, ...(Array.isArray(context.additional_sources) ? context.additional_sources : [])];
  const sourceText = sources.map((source, index) =>
    `【原文 ${index + 1}｜${source.locator}】\n${String(source.excerpt || "").slice(0, 12000)}`,
  ).join("\n\n");
  const history = (request.context.recent_messages || []).slice(-12)
    .map((message) => `${message.role === "user" ? "用户" : "Agent"}：${String(message.content || "").slice(0, 4000)}`)
    .join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: [
      "本轮阅读到的原文：",
      sourceText,
      "",
      history ? "之前的讨论：\n" + history : "之前没有讨论。",
      "",
      "用户现在的问题：" + request.user_message.content,
    ].join("\n") },
  ];
}
function uuidFromHash(text) {
  const hex = createHash("sha256").update(text, "utf8").digest("hex");
  const chars = hex.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const joined = chars.join("");
  return [joined.slice(0, 8), joined.slice(8, 12), joined.slice(12, 16), joined.slice(16, 20), joined.slice(20)].join("-");
}
function buildCitations(request) {
  const sources = [request.context.current_source, ...(Array.isArray(request.context.additional_sources) ? request.context.additional_sources : [])];
  const seen = new Set();
  const citations = [];
  for (const source of sources) {
    if (!isUuid(source.structure_node_id) || typeof source.locator !== "string" || !source.locator.trim()) continue;
    const normalized = normalizeSpace(source.excerpt);
    if (!normalized) continue;
    const key = source.structure_node_id + ":" + source.locator;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      book_revision_id: request.book_revision_id,
      structure_node_id: source.structure_node_id,
      chunk_id: uuidFromHash([request.book_revision_id, source.structure_node_id, source.locator].join("|")),
      source_hash: createHash("sha256").update(normalized, "utf8").digest("hex"),
      locator: source.locator,
      excerpt: normalized.slice(0, 160),
    });
    if (citations.length >= 3) break;
  }
  return citations;
}

function pushEvent(task, event) {
  task.events.push(event);
  for (const subscriber of task.subscribers) {
    try { writeEvent(subscriber, event); } catch { task.subscribers.delete(subscriber); }
  }
  if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
    for (const subscriber of task.subscribers) {
      try { subscriber.end(); } catch {}
    }
    task.subscribers.clear();
  }
}
function nextEvent(task, type, extra = {}) {
  const sequence = task.events.length + 1;
  pushEvent(task, { event_id: task.id + "-" + sequence, sequence, generation_id: task.id, type, ...extra });
}
function writeEvent(res, event) {
  res.write("id: " + event.event_id + "\n");
  res.write("event: " + event.type + "\n");
  res.write("data: " + JSON.stringify(event) + "\n\n");
}

function retryDelayMs(response, attempt) {
  const header = response?.headers?.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(1000 * 2 ** (attempt - 1), 15_000);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function streamModel(task) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (task.cancelled) return;
    const requestSignal = AbortSignal.any([task.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    try {
      const response = await fetch(BASE_URL + "/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + API_KEY,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: buildMessages(task.request),
          temperature: 0.3,
          stream: true,
          thinking: { type: THINKING },
        }),
        signal: requestSignal,
      });
      if (response.status === 429) {
        const delay = retryDelayMs(response, attempt);
        log("model_rate_limited", { generationId: task.id, attempt, retryInMs: delay });
        await response.text().catch(() => "");
        if (attempt === MAX_ATTEMPTS) {
          lastError = { code: "rate_limited", message: "模型服务限流（429），已重试 " + attempt + " 次仍失败。", retryable: true };
          break;
        }
        await sleep(delay);
        continue;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        log("model_error", { generationId: task.id, attempt, status: response.status });
        lastError = { code: "provider_error", message: "模型服务返回 HTTP " + response.status + "。", retryable: response.status >= 500, detail: detail.slice(0, 300) };
        if (response.status >= 500 && attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(response, attempt)); continue; }
        break;
      }
      let text = "";
      let usage = null;
      let buffer = "";
      const consumeLine = (line) => {
        if (!line.startsWith("data:")) return;
        const value = line.slice(5).trim();
        if (!value || value === "[DONE]") return;
        let parsed;
        try { parsed = JSON.parse(value); } catch { return; }
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta || {};
        // Reasoning models may emit a separate reasoning field; only answer text is delivered.
        const piece = typeof delta.content === "string" ? delta.content : "";
        if (!piece) return;
        text += piece;
        nextEvent(task, "delta", { text: piece });
      };
      for await (const chunk of response.body) {
        if (task.cancelled) return;
        buffer += Buffer.from(chunk).toString("utf8");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          consumeLine(line);
        }
      }
      if (buffer.trim()) consumeLine(buffer);
      if (!text.trim()) {
        lastError = { code: "empty_result", message: "模型返回了空回答。", retryable: true };
        if (attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(null, attempt)); continue; }
        break;
      }
      task.status = "completed";
      task.result = {
        content: text.trim(),
        content_hash: createHash("sha256").update(text.trim(), "utf8").digest("hex"),
        citations: buildCitations(task.request),
        usage,
      };
      log("model_completed", { generationId: task.id, model: MODEL, characters: text.length, citations: task.result.citations.length });
      nextEvent(task, "completed", { result_available: true });
      return;
    } catch (error) {
      if (task.cancelled) return;
      if (error.name === "AbortError") { lastError = { code: "timeout", message: "模型请求超时。", retryable: true }; }
      else { lastError = { code: "provider_error", message: "模型请求失败：" + error.message, retryable: true }; }
      log("model_error", { generationId: task.id, attempt, code: lastError.code });
      if (attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(null, attempt)); continue; }
      break;
    }
  }
  if (task.cancelled) return;
  task.status = "failed";
  task.error = lastError || { code: "provider_error", message: "模型调用失败。", retryable: false };
  log("generation_failed", { generationId: task.id, code: task.error.code });
  nextEvent(task, "failed", { code: task.error.code });
}

async function callModelJson(instruction, payload, schema) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(BASE_URL + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          stream: false,
          messages: [
            { role: "system", content: instruction + "\n\n只输出符合以下 JSON Schema 的 JSON，不要输出解释或代码块标记：\n" + JSON.stringify(schema) },
            { role: "user", content: JSON.stringify(payload) },
          ],
          response_format: { type: "json_object" },
          thinking: { type: THINKING },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (response.status === 429) {
        const delay = retryDelayMs(response, attempt);
        log("memory_model_rate_limited", { attempt, retryInMs: delay });
        await response.text().catch(() => "");
        if (attempt < MAX_ATTEMPTS) { await sleep(delay); continue; }
        throw Object.assign(new Error("模型服务限流"), { code: "rate_limited" });
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        if (response.status >= 500 && attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(response, attempt)); continue; }
        throw Object.assign(new Error("模型服务返回 HTTP " + response.status + ": " + detail), { code: "provider_error" });
      }
      const body = await response.json();
      const message = body?.choices?.[0]?.message;
      if (message?.refusal) throw Object.assign(new Error("模型拒绝执行该结构化请求。"), { code: "provider_error" });
      let text = typeof message?.content === "string" ? message.content : "";
      if (!text.trim()) throw Object.assign(new Error("模型返回了空的结构化内容。"), { code: "empty_result" });
      text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      try { return JSON.parse(text); } catch { throw Object.assign(new Error("模型返回的内容不是合法 JSON。"), { code: "provider_error" }); }
    } catch (error) {
      lastError = error;
      if (error.code === "rate_limited") throw error;
      if (attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(null, attempt)); continue; }
      throw error;
    }
  }
  throw lastError || new Error("模型调用失败");
}

async function handleMemoryExtract(req, res) {
  let body;
  try { body = await readBody(req); } catch { return apiError(res, 422, "INVALID_REQUEST", "请求体不是合法 JSON。"); }
  if (typeof body.instruction !== "string" || !body.instruction.trim() || typeof body.outputSchema !== "object" || body.outputSchema === null) {
    return apiError(res, 422, "INVALID_REQUEST", "instruction 与 outputSchema 为必填项。");
  }
  try {
    const parsed = await callModelJson(body.instruction, { context: body.context, messages: body.messages }, body.outputSchema);
    json(res, 200, parsed);
  } catch (error) {
    const code = error.code || "provider_error";
    apiError(res, code === "rate_limited" ? 429 : 502, code, error.message, code === "rate_limited");
  }
}
async function handleMemoryPlan(req, res) {
  let body;
  try { body = await readBody(req); } catch { return apiError(res, 422, "INVALID_REQUEST", "请求体不是合法 JSON。"); }
  if (!Array.isArray(body.candidates) || !Array.isArray(body.existingVersions)) {
    return apiError(res, 422, "INVALID_REQUEST", "candidates 与 existingVersions 为必填数组。");
  }
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["candidate_id", "change_kind", "target_memory_id", "duplicate_of_memory_id", "rationale"],
          properties: {
            candidate_id: { type: "string" },
            change_kind: { type: "string", enum: ["new", "supplement", "correction", "conflict", "rejection", "extension"] },
            target_memory_id: { type: ["string", "null"] },
            duplicate_of_memory_id: { type: ["string", "null"] },
            rationale: { type: "string" },
          },
        },
      },
    },
  };
  try {
    const parsed = await callModelJson(
      "你是认知版本演变规划器。只比较候选认知与已存在的最新版本。不得改写候选正文，不得自行生成或猜测 memory ID。新认知使用 change_kind=new 且 target_memory_id=null；补充、修正、冲突、撤回、延伸必须选择 existing_latest_versions 中真实存在的 memory_id。只有明确重复时才设置 duplicate_of_memory_id，且 change_kind 必须为 new。证据不足或无法判断时，仍返回 new，不得虚构关系。每项必须给出简短、可审阅的 rationale。",
      { candidates: body.candidates, existing_latest_versions: body.existingVersions },
      schema,
    );
    json(res, 200, parsed);
  } catch (error) {
    const code = error.code || "provider_error";
    apiError(res, code === "rate_limited" ? 429 : 502, code, error.message, code === "rate_limited");
  }
}

async function handleCreate(req, res) {
  let body;
  try { body = validateRequest(await readBody(req)); } catch (error) { return apiError(res, 422, "INVALID_REQUEST", error.message); }
  const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : "";
  if (key.length < 16) return apiError(res, 422, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 长度必须为 16..128。");
  if (idempotency.has(key)) {
    const existing = idempotency.get(key);
    if (existing.requestHash !== hashRequest(body)) return apiError(res, 409, "IDEMPOTENCY_CONFLICT", "同一 Idempotency-Key 对应的请求内容不一致。");
    const task = tasks.get(existing.id);
    return json(res, 202, { generation_id: task.id, status: task.status === "running" ? "running" : task.status === "queued" ? "queued" : task.status, expires_at: task.expiresAt });
  }
  const id = randomUUID();
  const task = {
    id,
    status: "queued",
    request: body,
    events: [],
    result: null,
    error: null,
    cancelled: false,
    subscribers: new Set(),
    controller: new AbortController(),
    expiresAt: new Date(Date.now() + TASK_TTL_MS).toISOString(),
  };
  tasks.set(id, task);
  idempotency.set(key, { id, requestHash: hashRequest(body) });
  task.status = "running";
  const accepted = { generation_id: id, status: "queued", expires_at: task.expiresAt };
  nextEvent(task, "started");
  json(res, 202, accepted);
  log("generation_started", { generationId: id, model: MODEL });
  void streamModel(task).catch((error) => {
    if (task.cancelled) return;
    task.status = "failed";
    task.error = { code: "provider_error", message: "未预期的生成错误：" + error.message, retryable: false };
    nextEvent(task, "failed", { code: "provider_error" });
  });
}
function hashRequest(body) {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

function handleStatus(res, task) {
  json(res, 200, {
    generation_id: task.id,
    status: task.status,
    expires_at: task.expiresAt,
    ...(task.status === "completed" ? { result: task.result } : { result: null }),
    ...(task.error ? { error_code: task.error.code } : {}),
  });
}

function handleEvents(req, res, task, after) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  const replay = task.events.filter((event) => event.sequence > after);
  for (const event of replay) writeEvent(res, event);
  const terminal = task.events.find((event) => ["completed", "failed", "cancelled"].includes(event.type));
  if (terminal) { res.end(); return; }
  task.subscribers.add(res);
  const heartbeat = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch {} }, 15_000);
  req.on("close", () => { clearInterval(heartbeat); task.subscribers.delete(res); });
}

function handleCancel(res, task) {
  if (["completed", "failed", "cancelled", "expired"].includes(task.status)) {
    return json(res, 202, { generation_id: task.id, status: task.status, expires_at: task.expiresAt });
  }
  task.cancelled = true;
  task.status = "cancelled";
  task.controller.abort();
  nextEvent(task, "cancelled");
  json(res, 202, { generation_id: task.id, status: "cancel_requested", expires_at: task.expiresAt });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url, "http://127.0.0.1:" + PORT);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (url.pathname === "/health") { json(res, 200, { status: "ok", model: MODEL, thinking: THINKING }); return; }
  if (!authorized(req)) return apiError(res, 401, "UNAUTHORIZED", "缺少有效的本地访问令牌。");
  if (url.pathname === "/v1/memory/extract") {
    if (req.method !== "POST") return apiError(res, 405, "METHOD_NOT_ALLOWED", "仅支持 POST。");
    return handleMemoryExtract(req, res);
  }
  if (url.pathname === "/v1/memory/plan") {
    if (req.method !== "POST") return apiError(res, 405, "METHOD_NOT_ALLOWED", "仅支持 POST。");
    return handleMemoryPlan(req, res);
  }
  const match = url.pathname.match(/^\/v1\/generations(?:\/([^/]+))?(?:\/(events|cancel))?$/);
  if (!match) return apiError(res, 404, "NOT_FOUND", "未找到该接口。");
  const [, generationId, action] = match;
  if (!generationId) {
    if (req.method !== "POST") return apiError(res, 405, "METHOD_NOT_ALLOWED", "仅支持 POST。");
    return handleCreate(req, res);
  }
  const task = tasks.get(generationId);
  if (!task) return apiError(res, 404, "GENERATION_NOT_FOUND", "生成任务不存在。");
  if (action === "events") {
    if (req.method !== "GET") return apiError(res, 405, "METHOD_NOT_ALLOWED", "仅支持 GET。");
    const after = Number(url.searchParams.get("after") || 0);
    return handleEvents(req, res, task, Number.isSafeInteger(after) && after >= 0 ? after : 0);
  }
  if (action === "cancel") {
    if (req.method !== "POST") return apiError(res, 405, "METHOD_NOT_ALLOWED", "仅支持 POST。");
    return handleCancel(res, task);
  }
  if (req.method !== "GET") return apiError(res, 405, "METHOD_NOT_ALLOWED", "仅支持 GET。");
  return handleStatus(res, task);
});

server.listen(PORT, "127.0.0.1", () => {
  log("listening", { url: "http://127.0.0.1:" + PORT, model: MODEL, thinking: THINKING });
});
