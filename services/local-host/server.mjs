import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAnswerQuotes } from "./answer-quotes.mjs";

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
// 知识抽取可按请求切换模型做对照，但仍只允许服务端配置过的模型名。
const KNOWLEDGE_MODELS = new Set(
  (process.env.KNOWLEDGE_MODELS || [MODEL, "glm-5.3", "deepseek-v4-flash"].join(","))
    .split(",").map((item) => item.trim()).filter(Boolean),
);
const THINKING = process.env.SENSENOVA_THINKING === "enabled" ? "enabled" : "disabled";
const LOCAL_AUTH_TOKEN = process.env.LOCAL_AUTH_TOKEN || "local-dev-token";
// 向量通道：浏览器访问不到 11434，统一由本地宿主代理到 Ollama。
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "bge-m3";
const EMBED_TIMEOUT_MS = Number(process.env.OLLAMA_EMBED_TIMEOUT_MS || 120_000);
const MAX_EMBED_INPUTS = 64;
const MAX_EMBED_CHARACTERS = 4000;
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

const BOOK_SCOPE_NOTE = [
  "本轮问题按“全书检索”处理：下面列出的原文片段是全书中与问题最相关的若干段，已按相关度排序。",
  "只能依据这些片段回答；片段不足以支撑时，必须明确说“提供的原文片段没有覆盖这个问题”，不要用常识或先验知识补答。",
  "引用原文时说明它来自第几段片段（例如“原文 2”）。",
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
  const bookScope = context.retrieval?.mode === "book";
  const memory = Array.isArray(context.relevant_memory) ? context.relevant_memory : [];
  const memoryText = memory.map((item, index) =>
    `【记忆 ${index + 1}｜${item.title || "长期认知"}｜${item.change_kind || "new"}】\n${String(item.content || "").slice(0, 4000)}`,
  ).join("\n\n");
  const knowledge = Array.isArray(context.knowledge)
    ? context.knowledge.filter((item) => typeof item === "string" && item.trim()).slice(0, 8).map((item) => item.slice(0, 200).trim())
    : [];
  const knowledgeText = knowledge.map((item) => "- " + item).join("\n");
  const history = (request.context.recent_messages || []).slice(-12)
    .map((message) => `${message.role === "user" ? "用户" : "Agent"}：${String(message.content || "").slice(0, 4000)}`)
    .join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT + (bookScope ? "\n" + BOOK_SCOPE_NOTE : "") },
    { role: "user", content: [
      bookScope ? "以下是全书检索命中的原文片段（按相关度排序）：" : "本轮阅读到的原文：",
      sourceText,
      "",
      ...(memoryText ? ["与当前讨论相关的长期认知：\n" + memoryText, ""] : []),
      ...(knowledgeText ? ["已审核的书籍知识（只作为理解线索；引用原文时必须依据上面的原文片段）：\n" + knowledgeText, ""] : []),
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
      // 客户端随来源一起送来真实切片 ID；只有缺失或非法时才退回按来源派生的哈希。
      chunk_id: isUuid(source.chunk_id)
        ? source.chunk_id
        : uuidFromHash([request.book_revision_id, source.structure_node_id, source.locator].join("|")),
      source_hash: createHash("sha256").update(normalized, "utf8").digest("hex"),
      locator: source.locator,
      excerpt: normalized.slice(0, 160),
    });
    if (citations.length >= 8) break;
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
      const sources = [task.request.context.current_source, ...(Array.isArray(task.request.context.additional_sources) ? task.request.context.additional_sources : [])];
      const audit = verifyAnswerQuotes(text.trim(), sources);
      task.result = {
        content: audit.content,
        content_hash: createHash("sha256").update(audit.content, "utf8").digest("hex"),
        citations: buildCitations(task.request),
        quote_audit: { checked: audit.checked, blocked: audit.blocked, samples: audit.samples },
        usage,
      };
      log("model_completed", {
        generationId: task.id, model: MODEL, characters: text.length,
        citations: task.result.citations.length,
        quotesChecked: audit.checked, quotesBlocked: audit.blocked,
      });
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

async function callModelJson(instruction, payload, schema, options = {}) {
  const model = options.model || MODEL;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 90_000;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(BASE_URL + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          stream: false,
          messages: [
            { role: "system", content: instruction + "\n\n只输出符合以下 JSON Schema 的 JSON，不要输出解释或代码块标记：\n" + JSON.stringify(schema) },
            { role: "user", content: JSON.stringify(payload) },
          ],
          response_format: { type: "json_object" },
          // 只有默认模型接受 thinking 开关；对照模型（如 glm-5.3）不接受 disabled。
          ...(model === MODEL ? { thinking: { type: THINKING } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
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

const KNOWLEDGE_INSTRUCTION = "你是书籍知识抽取器，只允许抽取三类知识：chapter_intent（章节意图）、thesis（作者主张）、concept（术语 + 书中原句定义）。只依据本次提供的原文切片，不得使用先验知识，也不得补写书名或书中没有的观点。每个条目的 source_chunk_ids 必须从本次提供的 chunk_id 中选择，至少一个；指不回切片的条目不要输出。concept：凡切片中出现对某一术语的界定或解释句式（如“X者，Y也”“X即Y”“所谓X，是Y”“X只是Y”），就要抽取 term（术语本身）与 definition_quote（原文中逐字出现的解释句，不得改写），definition_quote 必须能在所引用的切片原文中找到；每批最多 4 条。thesis 只抽作者明确表达的主张，content 必须是你自己概括的一句话，不得整句照抄原文，不得编造因果，也不要把问句或弟子转述当成作者主张。chapter_intent 只有在这些切片本身足以说明本章要解决的问题时才输出，每批最多 1 条；只能使用切片中出现过的术语，如果只是章中一段，不要概括整章。同一批次重复条目必须合并。每条 content 不超过 120 字。最多输出 12 条；信息不足时宁可不输出，不要凑数。";
const KNOWLEDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item_type", "content", "term", "definition_quote", "source_chunk_ids", "confidence"],
        properties: {
          item_type: { type: "string", enum: ["chapter_intent", "thesis", "concept"] },
          content: { type: "string" },
          term: { type: ["string", "null"] },
          definition_quote: { type: ["string", "null"] },
          source_chunk_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
          confidence: { type: "number" },
        },
      },
    },
  },
};
const KNOWLEDGE_ITEM_TYPES = new Set(["chapter_intent", "thesis", "concept"]);
const MAX_KNOWLEDGE_ITEMS = 12;

// 只保留能指回本次切片、且原句确实能在切片中找到的条目；非法条目直接丢弃。
function filterKnowledgeItems(parsed, chunks) {
  const chunkIds = new Set(chunks.map((chunk) => chunk.chunk_id));
  const chunkText = new Map(chunks.map((chunk) => [chunk.chunk_id, normalizeSpace(chunk.text)]));
  const raw = Array.isArray(parsed?.items) ? parsed.items : [];
  const items = [];
  let dropped = 0;
  // 引文常带“○先生曰，”“爱曰：”这类说话人前缀和成对引号，抽取时先清掉再看是否逐字命中。
  // 语料里还有「」『』错位（如“格物」者”），只删右引号多于左引号的残片。
  const balanceBrackets = (value) => {
    let text = String(value ?? "");
    for (const [open, close] of [["「", "」"], ["『", "』"]]) {
      const count = (source, mark) => (source.split(mark).length - 1);
      if (count(text, close) <= count(text, open)) continue;
      text = text.replace(new RegExp("^([^" + open + close + "]{1,24})" + close), "$1");
      let extra = count(text, close) - count(text, open);
      while (extra > 0) {
        text = text.replace(close, "");
        extra -= 1;
      }
    }
    return text.trim();
  };
  const isBalanced = (value) => {
    const text = String(value ?? "");
    return [["「", "」"], ["『", "』"]].every(([open, close]) =>
      (text.split(close).length - 1) === (text.split(open).length - 1));
  };
  const trimLeaders = (value) => String(value ?? "")
    .replace(/^[○〇●\s]+/, "")
    .replace(/^[\u4e00-\u9fa5]{0,3}曰[，,：:]?\s*/, "")
    .replace(/^[「『"]/, "")
    .replace(/([」』"])([。；])$/, "$2")
    .replace(/[」』"]$/, "")
    .trim();
  for (const item of raw) {
    if (items.length >= MAX_KNOWLEDGE_ITEMS) { dropped += 1; continue; }
    if (!item || typeof item !== "object" || Array.isArray(item)) { dropped += 1; continue; }
    if (!KNOWLEDGE_ITEM_TYPES.has(item.item_type)) { dropped += 1; continue; }
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content || content.length > 400) { dropped += 1; continue; }
    // 私用区异体字、替换符与夹字会破坏“可点回原文”的可读性，直接丢弃。
    if (/[\uE000-\uF8FF\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) { dropped += 1; continue; }
    const sourceIds = item.source_chunk_ids;
    if (!Array.isArray(sourceIds) || !sourceIds.length) { dropped += 1; continue; }
    if (sourceIds.some((id) => typeof id !== "string" || !chunkIds.has(id))) { dropped += 1; continue; }
    const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence)
      ? Math.min(1, Math.max(0, item.confidence))
      : 0;
    let term = null;
    let definitionQuote = null;
    if (item.item_type === "concept") {
      const rawTerm = balanceBrackets(typeof item.term === "string" ? item.term.trim() : "")
        .replace(/[「」『』]/g, "").trim();
      const rawQuote = typeof item.definition_quote === "string" ? item.definition_quote.trim() : "";
      if (!rawTerm || !rawQuote) { dropped += 1; continue; }
      const cleanedQuote = trimLeaders(rawQuote);
      const matchesChunk = (value) => sourceIds.some((id) => chunkText.get(id).includes(normalizeSpace(value)));
      // 引号不配对多半是模型截断或语料错位，宁可回原文重新取句，也不把残片写进审核界面。
      let quote = "";
      if (cleanedQuote && isBalanced(cleanedQuote) && matchesChunk(cleanedQuote)) {
        quote = cleanedQuote;
      } else if (isBalanced(rawQuote) && matchesChunk(rawQuote)) {
        quote = rawQuote;
      } else {
        // 模型常把定义句改写；只从所引切片里取回“术语 + 界定句式”的原句，避免抓到无关句子。
        const definitional = (sentence, term) => [
          term + "者", term + "即", term + "便是", term + "只是", term + "是", "所谓" + term,
        ].some((pattern) => sentence.includes(pattern));
        for (const id of sourceIds) {
          const original = chunks.find((chunk) => chunk.chunk_id === id)?.text || "";
          const sentence = (original.match(/[^。！？；!?;\n]+[。！？；!?;]?/g) || [])
            .map((part) => trimLeaders(part))
            .find((part) => part && isBalanced(part) &&
              !/^[^，,。]{1,4}问[，,]/.test(part) &&
              part.includes(rawTerm) && part.length >= rawTerm.length + 2 && definitional(part, rawTerm));
          if (sentence) {
            quote = sentence.slice(0, 200);
            break;
          }
        }
      }
      if (!quote) { dropped += 1; continue; }
      quote = balanceBrackets(quote);
      // 截断到 200 字后仍可能留下半个引号，宁可丢掉也不要脏引文。
      if (!isBalanced(quote)) { dropped += 1; continue; }
      // 引文里混入异体/私用区字符时丢弃，避免脏数据流到审核界面。
      if (/[\uE000-\uF8FF\uFFFD]/.test(quote)) { dropped += 1; continue; }
      // 引文必须包含该术语，否则只是“术语 + 无关原句”。
      if (!normalizeSpace(quote).includes(normalizeSpace(rawTerm))) { dropped += 1; continue; }
      term = rawTerm.slice(0, 80);
      definitionQuote = quote.slice(0, 200);
    }
    items.push({ item_type: item.item_type, content, term, definition_quote: definitionQuote, source_chunk_ids: sourceIds, confidence });
  }
  return { items, dropped };
}

function validateKnowledgeRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求体必须是 JSON 对象。");
  if (typeof body.book_revision_id !== "string" || !body.book_revision_id.trim()) throw new Error("book_revision_id 必须是非空字符串。");
  if (typeof body.chapter !== "string" || !body.chapter.trim()) throw new Error("chapter 必须是非空字符串。");
  if (!Array.isArray(body.chunks) || body.chunks.length < 1 || body.chunks.length > 12) throw new Error("chunks 必须是长度 1..12 的数组。");
  if (body.focus !== undefined && body.focus !== "chapter_intent" && body.focus !== "concept") throw new Error("focus 只支持 chapter_intent 或 concept。");
  if (body.genre !== undefined && body.genre !== "narrative" && body.genre !== "expository") throw new Error("genre 只支持 narrative 或 expository。");
  if (body.model !== undefined && !KNOWLEDGE_MODELS.has(body.model)) throw new Error("model 不在允许列表中。");
  const chunks = body.chunks.map((chunk) => {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) throw new Error("chunks 中的每一项必须是对象。");
    for (const field of ["chunk_id", "structure_node_id", "locator"]) {
      if (typeof chunk[field] !== "string" || !chunk[field].trim()) throw new Error("chunks." + field + " 必须是非空字符串。");
    }
    if (typeof chunk.title !== "string") throw new Error("chunks.title 必须是字符串。");
    if (typeof chunk.text !== "string" || !chunk.text.trim()) throw new Error("chunks.text 必须是非空字符串。");
    if (chunk.text.length > 4000) throw new Error("chunks.text 不能超过 4000 字符。");
    return {
      chunk_id: chunk.chunk_id,
      structure_node_id: chunk.structure_node_id,
      locator: chunk.locator,
      title: chunk.title,
      text: chunk.text,
    };
  });
  return { book_revision_id: body.book_revision_id, chapter: body.chapter, chunks, focus: body.focus || null, model: body.model || null, genre: body.genre || null };
}

async function handleKnowledgeExtract(req, res) {
  let body;
  try { body = await readBody(req); } catch { return apiError(res, 422, "INVALID_REQUEST", "请求体不是合法 JSON。"); }
  let request;
  try { request = validateKnowledgeRequest(body); } catch (error) { return apiError(res, 422, "INVALID_REQUEST", error.message); }
  let parsed;
  try {
    const focusInstruction = request.focus === "chapter_intent"
      ? " 本次只输出 chapter_intent，最多 1 条；不要输出 thesis 或 concept。"
      : request.focus === "concept"
        ? " 本次只输出 concept，最多 4 条；只抽原文中出现逐字解释句的术语，term 与 definition_quote 必须齐全，不要输出 thesis 或 chapter_intent。"
        : "";
    // 叙事文体不产“作者主张”：剧情概括不是作者观点，宁可少一条也不冒充。
    const genreInstruction = request.genre === "narrative"
      ? " 本章是叙事文体（小说/章回）：禁止输出 thesis。只允许 chapter_intent（本章要讲的事件脉络，不超过 1 条）与 concept（专名与术语：人名、地名、法宝、官职、称谓，或原文中确有解释句的词语）。concept 不得复述情节，content 只写“该专名指什么”，definition_quote 必须能在切片中逐字找到。"
      : "";
    parsed = await callModelJson(KNOWLEDGE_INSTRUCTION + focusInstruction + genreInstruction, {
      book_revision_id: request.book_revision_id,
      chapter: request.chapter,
      chunks: request.chunks,
    }, KNOWLEDGE_SCHEMA, { model: request.model || MODEL, timeoutMs: 240_000 });
  } catch (error) {
    const code = error.code || "provider_error";
    return apiError(res, code === "rate_limited" ? 429 : 502, code, error.message, code === "rate_limited");
  }
  let filtered = filterKnowledgeItems(parsed, request.chunks);
  if (request.genre === "narrative") {
    // 双保险：模型偶尔仍会返回 thesis，服务端直接拦掉。
    const onlyAllowed = filtered.items.filter((item) => item.item_type !== "thesis");
    filtered = { items: onlyAllowed, dropped: filtered.dropped + filtered.items.length - onlyAllowed.length };
  }
  if (request.focus) {
    const onlyFocused = filtered.items.filter((item) => item.item_type === request.focus);
    filtered = { items: onlyFocused, dropped: filtered.dropped + filtered.items.length - onlyFocused.length };
  }
  json(res, 200, { model: request.model || MODEL, items: filtered.items, dropped: filtered.dropped });
}

async function handleEmbeddings(req, res) {
  let body;
  try { body = await readBody(req, 2_000_000); } catch { return apiError(res, 422, "INVALID_REQUEST", "请求体不是合法 JSON。"); }
  let inputs;
  try {
    inputs = Array.isArray(body.input) ? body.input : typeof body.input === "string" ? [body.input] : null;
    if (!inputs || !inputs.length) throw new Error("input 必须是非空字符串或字符串数组。");
    if (inputs.length > MAX_EMBED_INPUTS) throw new Error("单次最多向量化 " + MAX_EMBED_INPUTS + " 段文本。");
    inputs = inputs.map((value) => {
      if (typeof value !== "string" || !value.trim()) throw new Error("input 中的文本必须是非空字符串。");
      if (value.length > MAX_EMBED_CHARACTERS) throw new Error("单段文本不能超过 " + MAX_EMBED_CHARACTERS + " 字符。");
      return value;
    });
  } catch (error) {
    return apiError(res, 422, "INVALID_REQUEST", error.message);
  }
  let response;
  try {
    response = await fetch(OLLAMA_BASE_URL + "/api/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
  } catch (error) {
    log("embedding_unreachable", { code: error?.name || "fetch_error" });
    return apiError(res, 503, "EMBEDDING_UNAVAILABLE", "本机向量服务不可用（" + (error?.name === "TimeoutError" ? "请求超时" : "无法连接 Ollama") + "）。可继续使用关键词检索。", true);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    log("embedding_error", { status: response.status });
    return apiError(res, 502, "EMBEDDING_FAILED", "向量服务返回 HTTP " + response.status + "。" + (detail ? " " + detail : ""), response.status >= 500);
  }
  let payload;
  try { payload = await response.json(); } catch { return apiError(res, 502, "EMBEDDING_FAILED", "向量服务返回了非 JSON 响应。", true); }
  const embeddings = payload?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== inputs.length ||
      embeddings.some((vector) => !Array.isArray(vector) || !vector.length || vector.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
    return apiError(res, 502, "EMBEDDING_FAILED", "向量服务返回的向量格式不合法。", true);
  }
  const dimensions = embeddings[0].length;
  if (embeddings.some((vector) => vector.length !== dimensions)) {
    return apiError(res, 502, "EMBEDDING_FAILED", "向量服务返回了维度不一致的向量。", true);
  }
  json(res, 200, { model: typeof payload.model === "string" && payload.model ? payload.model : EMBED_MODEL, dimensions, embeddings });
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
  if (url.pathname === "/health") { json(res, 200, { status: "ok", model: MODEL, thinking: THINKING, embedding: { model: EMBED_MODEL }, knowledge: { model: MODEL } }); return; }
  if (!authorized(req)) return apiError(res, 401, "UNAUTHORIZED", "缺少有效的本地访问令牌。");
  if (url.pathname === "/v1/embeddings") {
    if (req.method !== "POST") return apiError(res, 405, "METHOD_NOT_ALLOWED", "仅支持 POST。");
    return handleEmbeddings(req, res);
  }
  if (url.pathname === "/v1/memory/extract") {
    if (req.method !== "POST") return apiError(res, 405, "METHOD_NOT_ALLOWED", "仅支持 POST。");
    return handleMemoryExtract(req, res);
  }
  if (url.pathname === "/v1/knowledge/extract") {
    if (req.method !== "POST") return apiError(res, 405, "METHOD_NOT_ALLOWED", "仅支持 POST。");
    return handleKnowledgeExtract(req, res);
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

// 知识抽取用对照模型时单批可能超过 90 秒，给足超时并放宽 Node 默认 5 分钟请求上限。
server.requestTimeout = 10 * 60 * 1000;

server.listen(PORT, "127.0.0.1", () => {
  log("listening", { url: "http://127.0.0.1:" + PORT, model: MODEL, thinking: THINKING });
});
