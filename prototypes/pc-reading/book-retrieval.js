/**
 * 全书检索的纯函数层：语义段落切块、中文关键词、RRF 融合、无结果判定与预算裁剪。
 *
 * 约定：
 * - unit 仍是对外展示与引用粒度；chunk 只是检索粒度，二者通过 unitIds / structureNodeId 互相定位。
 * - 切块按句末对齐，目标 300–600 字，相邻切片保留约 15% 重叠；跨章节不重叠。
 * - 关键词不使用分词词典：FTS5 trigram + 2/3-gram 兜底，短查询靠关键词，长问句靠向量。
 */

const STOPWORDS = new Set([
  "这个", "那个", "我们", "你们", "他们", "她们", "以及", "但是", "因为", "所以",
  "如果", "那么", "如何", "为什么", "什么", "怎么", "可以", "应该", "不是", "一个",
  "一些", "这种", "那种", "这里", "那里", "对于", "关于", "其中", "自己", "已经",
  "进行", "通过", "是否", "怎样", "为何", "哪些", "哪个", "时候", "的话", "而且",
  "请问", "能否", "告诉", "认为", "觉得", "一下", "是不是", "有没有", "这段", "这句",
  "书中", "书里", "全书", "这本", "本书", "这部", "作者", "书中", "讨论", "谈到",
  "提到", "关系", "地方", "内容", "问题", "观点", "看法", "意思", "解释", "介绍",
  "知道", "理解", "具体", "实际", "相关", "主要", "说过", "讲过", "写道", "哪些地方",
  "没有", "有没", "是不是", "能不能", "会不会", "这本书", "本书", "书上",
]);

// 提问框架词的所有 2/3-gram 都不作为关键词：避免“有没有提到”“这本书里”把
// 无关问题误判为书里有依据。内容词（如“知行”“心即理”）不受影响。
const FRAMING_PHRASES = [
  "这本书", "这书", "本书", "全书", "书中", "书里", "书上", "作者", "先生",
  "有没有", "是否", "哪些", "哪里", "如何", "怎样", "怎么", "什么", "为什么",
  "请问", "告诉我", "提到", "谈到", "讨论", "关系", "内容", "观点", "看法",
  "意思", "解释", "介绍", "知道", "理解", "一下", "地方", "地方吗", "吗",
];
const FRAMING_TOKENS = new Set();
for (const phrase of FRAMING_PHRASES) {
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index + size <= phrase.length; index += 1) {
      FRAMING_TOKENS.add(phrase.slice(index, index + size));
    }
  }
}

export const CHUNK_MIN_CHARACTERS = 300;
export const CHUNK_MAX_CHARACTERS = 600;
export const CHUNK_OVERLAP_RATIO = 0.15;
export const RRF_K = 60;
/** 没有关键词命中时，向量余弦必须达到该阈值才算“书里有依据”。 */
export const MIN_VECTOR_SCORE = 0.58;

const BOOK_SCOPE_MARKERS = /(全书|整本书|整部书|通篇|贯穿|哪些章节|哪几章|所有章节|各章|书里|书中|全文|前后文|全书范围)/;
const CURRENT_SCOPE_MARKERS = /(这一段|这段|这一句|这句|这段话|这句话|当前段|当前单元|此处|本段|本文|上面这段)/;
const EVIDENCE_MARKERS = /(证据|原文|出处|在哪里|在哪|哪里提到|有没有提到|找一?找|列举|归纳|梳理|比较|对照|脉络|主张)/;

export function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

/** 2/3-gram 关键词（中文）+ 英文数字词，供 FTS5 trigram 与 LIKE 兜底共用。 */
export function tokenize(value) {
  const segments = normalizeText(value).match(/[\u3400-\u9fff]+|[a-z0-9]+/g) || [];
  const tokens = [];
  for (const segment of segments) {
    if (/^[\u3400-\u9fff]+$/.test(segment)) {
      if (segment.length < 2) continue;
      for (let size = 2; size <= 3; size += 1) {
        for (let index = 0; index + size <= segment.length; index += 1) {
          const token = segment.slice(index, index + size);
          if (!STOPWORDS.has(token) && !FRAMING_TOKENS.has(token)) tokens.push(token);
        }
      }
    } else if (segment.length > 1 && !STOPWORDS.has(segment)) {
      tokens.push(segment);
    }
  }
  return tokens;
}

/** 关键词检索词：先剥掉提问框架词，再取 2/3-gram，去重后优先较长的词，最多 64 个。 */
export function keywordTerms(question) {
  let text = normalizeText(question);
  // 长词优先，避免“这本书”被“本书”拆掉后留下跨词噪声。
  for (const phrase of [...FRAMING_PHRASES].sort((left, right) => right.length - left.length)) {
    text = text.split(normalizeText(phrase)).join(" ");
  }
  const seen = new Set();
  const ordered = tokenize(text).filter((token) => {
    if (seen.has(token)) return false;
    seen.add(token);
    return true;
  });
  ordered.sort((left, right) => right.length - left.length);
  return ordered.slice(0, 64);
}

/** 把文本切成带偏移的句子；超长句按 maxSentence 硬切，保证切块可控。 */
export function splitSentences(text, maxSentence = CHUNK_MAX_CHARACTERS) {
  const source = String(text ?? "");
  const sentences = [];
  const pattern = /[^。！？；!?;\n]+[。！？；!?;]?/g;
  let match;
  while ((match = pattern.exec(source))) {
    const raw = match[0];
    if (!raw.trim()) continue;
    let start = match.index;
    let piece = raw;
    while (piece.length > maxSentence) {
      sentences.push({ start, end: start + maxSentence, text: piece.slice(0, maxSentence) });
      start += maxSentence;
      piece = piece.slice(maxSentence);
    }
    if (piece.trim()) sentences.push({ start, end: start + piece.length, text: piece });
  }
  return sentences;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function uuidFromText(value) {
  const hex = (await sha256Hex(value)).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return joined.slice(0, 8) + "-" + joined.slice(8, 12) + "-" + joined.slice(12, 16) + "-" +
    joined.slice(16, 20) + "-" + joined.slice(20, 32);
}

function segmentsFromUnit(unit) {
  return splitSentences(unit.text).map((sentence) => ({
    unitId: unit.id,
    chapter: unit.chapter,
    title: unit.title,
    locator: unit.locator,
    start: sentence.start,
    end: sentence.end,
    text: sentence.text,
  }));
}

function overlapSegments(segments, ratio) {
  if (!segments.length) return [];
  const target = Math.round(CHUNK_MAX_CHARACTERS * ratio);
  const carried = [];
  let characters = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (carried.length && characters + segment.text.length > target * 1.6) break;
    carried.unshift(segment);
    characters += segment.text.length;
    if (characters >= target) break;
  }
  // 重叠不能把整个切片都带进下一块，否则会形成重复切片。
  return carried.length === segments.length ? carried.slice(1) : carried;
}

/**
 * 按章节内的连续 unit 组块，按句末对齐，约 15% 重叠。
 * @returns {Promise<Array<{id:string,chunkIndex:number,structureNodeId:string,locator:string,chapter:string,title:string,unitIds:string[],text:string,charLength:number}>>}
 */
export async function buildChunks(units, options = {}) {
  const list = (Array.isArray(units) ? units : []).filter((unit) =>
    unit && typeof unit.id === "string" && typeof unit.text === "string" && unit.text.trim() &&
    typeof unit.locator === "string" && typeof unit.chapter === "string");
  const minChars = Number(options.minCharacters) || CHUNK_MIN_CHARACTERS;
  const maxChars = Number(options.maxCharacters) || CHUNK_MAX_CHARACTERS;
  const overlapRatio = Number.isFinite(options.overlapRatio) ? options.overlapRatio : CHUNK_OVERLAP_RATIO;
  const revisionId = String(options.bookRevisionId || "");
  const chunks = [];
  let buffer = [];

  const pushSegment = (segment) => {
    buffer.push(segment);
  };
  const bufferLength = () => buffer.reduce((sum, segment) => sum + segment.text.length, 0);
  const flush = () => {
    if (!buffer.length) return;
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    const text = buffer.map((segment) => segment.text).join("\n");
    const unitIds = [...new Set(buffer.map((segment) => segment.unitId))];
    chunks.push({
      id: null,
      chunkIndex: chunks.length,
      structureNodeId: first.unitId,
      locator: first.locator,
      chapter: first.chapter,
      title: first.title,
      unitIds,
      text,
      charLength: text.length,
      _identity: [revisionId, first.unitId, first.start, last.unitId, last.end].join("\n"),
    });
    buffer = overlapSegments(buffer, overlapRatio);
  };

  let currentChapter = null;
  for (const unit of list) {
    if (currentChapter !== null && unit.chapter !== currentChapter) {
      flush();
      buffer = [];
    }
    currentChapter = unit.chapter;
    for (const segment of segmentsFromUnit(unit)) {
      const projected = bufferLength() + segment.text.length;
      if (buffer.length && projected > maxChars && bufferLength() >= minChars) {
        flush();
      }
      pushSegment(segment);
    }
  }
  flush();

  for (const chunk of chunks) {
    chunk.id = await uuidFromText("read-book-chunk\n" + chunk._identity);
    delete chunk._identity;
  }
  return chunks;
}

/** FTS5 trigram 只接受 >=3 字符的查询词；其余交给 LIKE 兜底。 */
export function splitKeywordTerms(terms) {
  const unique = [...new Set((terms || []).filter((term) => typeof term === "string" && term.trim()))];
  return {
    fts: unique.filter((term) => term.length >= 3),
    like: unique.filter((term) => term.length < 3),
  };
}

/**
 * 关键词证据的“具体性”过滤：高频通用 2-gram（如“讨论”“关系”）不能单独算命中，
 * 否则“书里有没有红烧肉”会因“这本/书中”之类噪声被误判为有依据。
 * 短查询（<=4 字）例外：用户就是按这个短词找的，只要原文包含它就算命中。
 */
export function assessKeywordSpecificity(question, chunks, terms) {
  const list = Array.isArray(chunks) ? chunks : [];
  const normalizedQuestion = normalizeText(question).replace(/[^\u3400-\u9fff a-z0-9]/g, "");
  const shortQuery = normalizedQuestion.length > 0 && normalizedQuestion.length <= 4;
  const frequencyLimit = Math.max(3, Math.ceil(list.length * 0.12));
  const documentFrequency = new Map();
  const strongTerms = [];
  for (const term of new Set(terms || [])) {
    let count = 0;
    for (const chunk of list) {
      if (String(chunk.text || "").includes(term)) count += 1;
    }
    documentFrequency.set(term, count);
    if (!count) continue;
    if (shortQuery && normalizedQuestion.includes(term)) {
      strongTerms.push(term);
    } else if (count <= frequencyLimit) {
      strongTerms.push(term);
    }
  }
  return { strongTerms, documentFrequency, frequencyLimit, shortQuery };
}

export function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Reciprocal Rank Fusion：两路召回只使用名次，不做手工加权。 */
export function rrfFuse(rankings, k = RRF_K) {
  const scores = new Map();
  for (const ranking of rankings) {
    if (!Array.isArray(ranking)) continue;
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + index + 1));
    });
  }
  return scores;
}

/**
 * 自动判断问题范围。只有明确的“全书/书中/哪些章节/找证据”等信号才升级为全书检索，
 * 其余保持当前段讨论，避免破坏既有阅读节奏。
 */
export function analyzeQuestion(question) {
  const text = String(question || "").trim();
  if (!text) return { mode: "current", reason: "empty" };
  if (CURRENT_SCOPE_MARKERS.test(text)) return { mode: "current", reason: "explicit_current" };
  if (BOOK_SCOPE_MARKERS.test(text)) return { mode: "book", reason: "explicit_book" };
  if (EVIDENCE_MARKERS.test(text) && /(作者|书|章|篇|篇目)/.test(text)) {
    return { mode: "book", reason: "evidence_request" };
  }
  if (text.length >= 18 && /(作者|贯穿|思想|体系|核心观点|整体)/.test(text)) {
    return { mode: "book", reason: "long_scope_question" };
  }
  return { mode: "current", reason: "default_current" };
}

/**
 * 无结果判定：关键词有命中即有依据；只有向量时必须过阈值。
 * 返回 hasEvidence=false 时调用方必须明说“书里没找到”，不能让模型凭先验作答。
 */
export function evaluateEvidence({ keywordHits, vectorHits, minimumVectorScore = MIN_VECTOR_SCORE }) {
  const keywordCount = Array.isArray(keywordHits) ? keywordHits.length : 0;
  if (keywordCount > 0) return { hasEvidence: true, reason: "keyword", topVectorScore: vectorHits?.[0]?.score ?? 0 };
  const topVectorScore = Array.isArray(vectorHits) && vectorHits.length ? vectorHits[0].score : 0;
  if (topVectorScore >= minimumVectorScore) return { hasEvidence: true, reason: "vector", topVectorScore };
  return { hasEvidence: false, reason: "no_match", topVectorScore };
}

/** 在句末截断，避免把一句话从中间切掉；超长单句才硬截。 */
export function truncateAtSentence(text, maxCharacters) {
  const source = String(text ?? "");
  if (source.length <= maxCharacters) return { text: source, truncated: false };
  const window = source.slice(0, maxCharacters);
  const boundary = Math.max(
    window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"),
    window.lastIndexOf("；"), window.lastIndexOf("\n"),
  );
  const cut = boundary >= Math.floor(maxCharacters * 0.55) ? boundary + 1 : maxCharacters;
  return { text: source.slice(0, cut), truncated: true };
}

/**
 * 检索片段选择：当前段永远保留；命中片段按融合分数去重（同一 unit 只取最佳切片）。
 * 超预算时先截片段，再从最低分开始丢弃，并返回被丢弃数量供界面说明。
 */
export function selectRetrievalPassages(hits, { limit = 6, maxCharacters = 12_000 } = {}) {
  const selected = [];
  const seenUnits = new Set();
  let characters = 0;
  let omitted = 0;
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (selected.length >= limit) { omitted += 1; continue; }
    const chunk = hit?.chunk;
    if (!chunk || seenUnits.has(chunk.structureNodeId)) { omitted += 1; continue; }
    const remaining = maxCharacters - characters;
    if (remaining < 120) { omitted += 1; continue; }
    const excerpt = truncateAtSentence(chunk.text, Math.min(remaining, CHUNK_MAX_CHARACTERS * 2));
    seenUnits.add(chunk.structureNodeId);
    characters += excerpt.text.length;
    selected.push({ chunk, score: hit.score, excerpt: excerpt.text, truncated: excerpt.truncated });
  }
  return { passages: selected, omitted, characters };
}

/**
 * 提示词预算：当前段 → 记忆 → 最旧聊天 → 低分检索片段 的顺序丢弃。
 * 返回带入请求的片段、聊天与记忆，以及可展示给用户的裁剪说明。
 */
export function planPromptBudget({
  currentUnit,
  passages,
  messages,
  memories,
  maxSourceCharacters = 18_000,
  maxMessageCharacters = 6_000,
  maxMemoryCharacters = 4_000,
}) {
  const notices = [];
  const currentExcerpt = truncateAtSentence(currentUnit?.text || "", Math.min(maxSourceCharacters, 12_000));
  let sourceCharacters = currentExcerpt.text.length;
  if (currentExcerpt.truncated) notices.push("当前原文过长，已按句末截断");

  const keptPassages = [];
  for (const passage of passages) {
    const remaining = maxSourceCharacters - sourceCharacters;
    if (remaining < 120) {
      notices.push("检索片段超出上下文预算，已省略低分片段 " + (passages.length - keptPassages.length) + " 条");
      break;
    }
    const excerpt = truncateAtSentence(passage.excerpt, Math.min(remaining, passage.excerpt.length));
    keptPassages.push({ ...passage, excerpt: excerpt.text, truncated: passage.truncated || excerpt.truncated });
    sourceCharacters += excerpt.text.length;
  }

  const keptMessages = [];
  let messageCharacters = 0;
  for (let index = (messages || []).length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (messageCharacters + message.content.length > maxMessageCharacters) break;
    keptMessages.unshift(message);
    messageCharacters += message.content.length;
  }
  if ((messages || []).length > keptMessages.length) {
    notices.push("为控制上下文，已省略较早的 " + ((messages || []).length - keptMessages.length) + " 条讨论");
  }

  const keptMemories = [];
  let memoryCharacters = 0;
  for (const memory of memories || []) {
    if (keptMemories.length >= 5) { notices.push("记忆召回超出 5 条上限，已截断"); break; }
    const content = truncateAtSentence(memory.content || "", 4000);
    if (memoryCharacters + content.text.length > maxMemoryCharacters) {
      notices.push("记忆召回超出上下文预算，已截断");
      break;
    }
    keptMemories.push({ ...memory, content: content.text });
    memoryCharacters += content.text.length;
  }

  return {
    currentExcerpt,
    passages: keptPassages,
    messages: keptMessages,
    memories: keptMemories,
    notices,
  };
}
