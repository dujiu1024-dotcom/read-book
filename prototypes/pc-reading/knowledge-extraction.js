/**
 * 书籍知识库的纯函数层：分章分批、模型输出校验、条目身份计算与进 prompt 的三层取用。
 *
 * 约定（口径先窄）：
 * - 只处理三类知识：chapter_intent（章节意图）、thesis（作者主张）、concept（术语 + 书中原句定义）。
 * - 每条知识必须能指回本次提供的原文切片 chunk_id；指不回的一律丢弃。
 * - 概念的定义引文必须逐字出现在所引切片的原文里，否则丢弃。
 * - 只有已接受（accepted）的知识才会进入 prompt，每层最多 2 条，压成一句并带出处。
 */

export const KNOWLEDGE_ITEM_TYPES = ["chapter_intent", "thesis", "concept"];
export const KNOWLEDGE_TYPE_LABELS = {
  chapter_intent: "章节意图",
  thesis: "作者主张",
  concept: "概念",
};
export const KNOWLEDGE_REVIEW_STATUSES = ["pending", "accepted", "rejected"];

/** 单批最多送 6 个切片、约 4200 字，避免一次请求过大导致整章失败。 */
export const KNOWLEDGE_BATCH_CHUNKS = 6;
export const KNOWLEDGE_BATCH_CHARACTERS = 4200;
export const KNOWLEDGE_MAX_ITEMS_PER_BATCH = 12;

export function normalizeSpace(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

/** 按章节分组切片，保持书内顺序。 */
export function groupChunksByChapter(chunks) {
  const groups = new Map();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!chunk || typeof chunk.chapter !== "string" || typeof chunk.id !== "string") continue;
    const key = chunk.chapter;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chunk);
  }
  return groups;
}

/**
 * 把一章的切片切成可独立重试的批次。
 * 批次 id 使用章名 + 起始/结束切片 id，便于失败续跑时判断批次是否仍然是同一批。
 */
export function planKnowledgeBatches(chunks, options = {}) {
  const limit = Number.isInteger(options.chunkLimit) && options.chunkLimit > 0 ? options.chunkLimit : KNOWLEDGE_BATCH_CHUNKS;
  const maxChars = Number.isFinite(options.maxCharacters) && options.maxCharacters > 0 ? options.maxCharacters : KNOWLEDGE_BATCH_CHARACTERS;
  const list = (Array.isArray(chunks) ? chunks : []).filter((chunk) => chunk && typeof chunk.id === "string" && String(chunk.text || "").trim());
  const batches = [];
  let buffer = [];
  let characters = 0;
  const flush = () => {
    if (!buffer.length) return;
    batches.push({
      index: batches.length,
      total: 0,
      firstChunkId: buffer[0].id,
      lastChunkId: buffer[buffer.length - 1].id,
      chunks: buffer,
    });
    buffer = [];
    characters = 0;
  };
  for (const chunk of list) {
    const length = String(chunk.text || "").length;
    if (buffer.length && (buffer.length >= limit || characters + length > maxChars)) flush();
    buffer.push(chunk);
    characters += length;
  }
  flush();
  for (const batch of batches) batch.total = batches.length;
  return batches;
}

function uuidFromHex(hex) {
  const chars = hex.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const joined = chars.join("");
  return joined.slice(0, 8) + "-" + joined.slice(8, 12) + "-" + joined.slice(12, 16) + "-" +
    joined.slice(16, 20) + "-" + joined.slice(20, 32);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 内容哈希用于去重：概念以“术语 + 原句定义”为身份，其余类型以内容为身份。 */
export function knowledgeContentIdentity({ bookRevisionId, itemType, content, term, definitionQuote, sourceChunkIds }) {
  const sources = [...new Set(sourceChunkIds || [])].sort().join("|");
  const body = itemType === "concept"
    ? [String(term || ""), normalizeSpace(definitionQuote)].join("\n")
    : normalizeSpace(content);
  return [bookRevisionId, itemType, body, sources].join("\n");
}

export async function knowledgeContentHash(item) {
  return sha256Hex(knowledgeContentIdentity(item));
}

export async function knowledgeIdFor(item) {
  return uuidFromHex(await knowledgeContentHash(item));
}

/**
 * 校验并归一化模型输出。传入的 chunks 必须正好是本批次送出的切片。
 * 返回可以直接写库的记录数组（不含审核状态默认值之外的业务判断）与被丢弃数量。
 */
export async function validateKnowledgeItems(rawItems, chunks, options = {}) {
  const bookRevisionId = String(options.bookRevisionId || "");
  const chapter = String(options.chapter || "");
  const modelVersion = String(options.modelVersion || "");
  const extractionMethod = String(options.extractionMethod || "llm");
  const now = String(options.now || new Date().toISOString());
  const chunkById = new Map((Array.isArray(chunks) ? chunks : []).map((chunk) => [chunk.id, chunk]));
  const items = [];
  let dropped = 0;
  const raw = Array.isArray(rawItems) ? rawItems : [];
  for (const item of raw) {
    if (items.length >= KNOWLEDGE_MAX_ITEMS_PER_BATCH) { dropped += 1; continue; }
    if (!item || typeof item !== "object" || Array.isArray(item)) { dropped += 1; continue; }
    if (!KNOWLEDGE_ITEM_TYPES.includes(item.item_type)) { dropped += 1; continue; }
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content || content.length > 400) { dropped += 1; continue; }
    const sourceChunkIds = Array.isArray(item.source_chunk_ids)
      ? [...new Set(item.source_chunk_ids.filter((id) => typeof id === "string" && id.trim()))]
      : [];
    if (!sourceChunkIds.length) { dropped += 1; continue; }
    if (sourceChunkIds.some((id) => !chunkById.has(id))) { dropped += 1; continue; }
    const cited = sourceChunkIds.map((id) => chunkById.get(id));
    let term = null;
    let definitionQuote = null;
    if (item.item_type === "concept") {
      const rawTerm = typeof item.term === "string" ? item.term.trim() : "";
      const rawQuote = typeof item.definition_quote === "string" ? item.definition_quote.trim() : "";
      if (!rawTerm || !rawQuote) { dropped += 1; continue; }
      const normalizedQuote = normalizeSpace(rawQuote);
      const quoted = cited.some((chunk) => normalizeSpace(chunk.text).includes(normalizedQuote));
      // 引文必须真的包含这个术语，避免“术语 + 无关原句”凑成一条概念。
      if (!quoted || !normalizedQuote.includes(normalizeSpace(rawTerm))) { dropped += 1; continue; }
      term = rawTerm.slice(0, 80);
      definitionQuote = rawQuote.slice(0, 200);
    }
    const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence)
      ? Math.min(1, Math.max(0, item.confidence))
      : 0;
    const record = {
      id: null,
      bookRevisionId,
      chapter,
      structureNodeId: cited[0].structureNodeId,
      itemType: item.item_type,
      content,
      term,
      definitionQuote,
      sourceChunkIds,
      sourceLocator: cited[0].title || cited[0].locator || cited[0].chapter || chapter,
      extractionMethod,
      modelVersion,
      confidence,
      reviewStatus: "pending",
      contentHash: null,
      createdAt: now,
      updatedAt: now,
      reviewedAt: null,
    };
    record.contentHash = await knowledgeContentHash(record);
    record.id = uuidFromHex(record.contentHash);
    // 同一批次内的重复条目只保留一条，避免把模型重复输出当成多条知识。
    if (items.some((existing) => existing.contentHash === record.contentHash)) { dropped += 1; continue; }
    items.push(record);
  }
  return { items, dropped };
}

function truncate(value, limit) {
  const text = String(value ?? "").trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

export function formatKnowledgeLine(item) {
  const locator = String(item.sourceLocator || "");
  // 切块标题本身可能已经带了章节前缀，避免出现“卷上 · 卷上 · 第1段”。
  const source = locator.startsWith(String(item.chapter || "") + " · ")
    ? locator
    : [item.chapter, locator].filter(Boolean).join(" · ");
  if (item.itemType === "concept") {
    return "概念「" + truncate(item.term, 24) + "」：" + truncate(item.definitionQuote || item.content, 110) +
      (source ? "（" + truncate(source, 60) + "）" : "");
  }
  if (item.itemType === "chapter_intent") {
    return "本章意图：" + truncate(item.content, 120) + (item.chapter ? "（" + item.chapter + "）" : "");
  }
  return "作者主张：" + truncate(item.content, 120) + (source ? "（" + truncate(source, 60) + "）" : "");
}

/**
 * 只取已接受的知识，按三层各最多 2 条：
 * 1) 当前单元直接相关的条目；
 * 2) 本章的章节意图与其余主张/概念；
 * 3) 跨章节的同名概念。
 * 返回压成一句话的 lines（可直接进 prompt）与命中的条目（用于调试/验收）。
 */
export function selectKnowledgeForPrompt({ items, currentUnit, limitPerLayer = 2 }) {
  const accepted = (Array.isArray(items) ? items : []).filter((item) =>
    item && item.reviewStatus === "accepted" && KNOWLEDGE_ITEM_TYPES.includes(item.itemType));
  const picked = [];
  const seen = new Set();
  const layerOf = new Map();
  const take = (candidates, layer, cap = limitPerLayer) => {
    let count = 0;
    for (const item of candidates) {
      if (count >= cap) break;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      picked.push(item);
      layerOf.set(item.id, layer);
      count += 1;
    }
  };
  if (currentUnit) {
    take(accepted.filter((item) => item.structureNodeId === currentUnit.id), "current");
    const sameChapter = accepted.filter((item) => item.chapter === currentUnit.chapter);
    take(sameChapter.filter((item) => item.itemType === "chapter_intent"), "chapter", 1);
    // 本章层优先取当前单元之外的条目，避免和第一层重复占位。
    take(sameChapter.filter((item) => item.itemType !== "chapter_intent" && item.structureNodeId !== currentUnit.id), "chapter", 1);
    const terms = new Set(accepted
      .filter((item) => item.itemType === "concept" && item.term && item.chapter === currentUnit.chapter)
      .map((item) => item.term));
    take(accepted.filter((item) => item.itemType === "concept" && item.term &&
      item.chapter !== currentUnit.chapter && terms.has(item.term)), "cross_chapter");
  }
  return {
    lines: picked.map(formatKnowledgeLine),
    items: picked.map((item) => ({ ...item, layer: layerOf.get(item.id) })),
  };
}

/** 抽取进度汇总文案（界面复用）。 */
export function knowledgeProgressText(state) {
  if (!state) return "";
  if (state.status === "completed") return state.chapter + "：已完成，" + state.itemCount + " 条待审核";
  if (state.status === "failed") return state.chapter + "：已抽 " + state.doneBatches + "/" + state.totalBatches + " 批，可续跑";
  return state.chapter + "：正在抽取 " + state.doneBatches + "/" + state.totalBatches + " 批";
}
