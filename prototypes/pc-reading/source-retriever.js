const DEFAULT_STOPWORDS = new Set([
  "这个", "那个", "我们", "你们", "他们", "她们", "以及", "但是", "因为", "所以",
  "如果", "那么", "如何", "为什么", "什么", "怎么", "可以", "应该", "不是", "一个",
  "一些", "这种", "那种", "这里", "那里", "对于", "关于", "其中", "自己", "已经",
  "进行", "通过", "是否", "怎样", "为何", "哪些", "哪个", "时候", "的话", "而且",
]);

const MAX_RESULTS = 7;
const MAX_QUERY_TERMS = 96;
const MAX_QUERY_CHARACTERS = 4000;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function tokenize(value) {
  const segments = normalizeText(value).match(/[\u3400-\u9fff]+|[a-z0-9]+/g) || [];
  const tokens = [];
  for (const segment of segments) {
    if (/^[\u3400-\u9fff]+$/.test(segment)) {
      if (segment.length < 2) continue;
      for (let size = 2; size <= 3; size += 1) {
        for (let index = 0; index + size <= segment.length; index += 1) {
          const token = segment.slice(index, index + size);
          if (!DEFAULT_STOPWORDS.has(token)) tokens.push(token);
        }
      }
    } else if (segment.length > 1 && !DEFAULT_STOPWORDS.has(segment)) {
      tokens.push(segment);
    }
  }
  return tokens;
}

function countTerms(tokens) {
  const frequencies = new Map();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  return frequencies;
}

function validUnit(unit) {
  return Boolean(
    unit &&
    typeof unit.id === "string" &&
    unit.id.trim() &&
    typeof unit.text === "string" &&
    unit.text.trim() &&
    typeof unit.locator === "string" &&
    unit.locator.trim()
  );
}

/**
 * Builds a deterministic, local lexical retriever for one immutable BookRevision.
 * It ranks only supplied units; callers remain responsible for request limits and
 * the server remains responsible for validating every returned citation.
 */
export function createSourceRetriever(units, options = {}) {
  const seenIds = new Set();
  const documents = (Array.isArray(units) ? units : [])
    .filter((unit) => validUnit(unit) && !seenIds.has(unit.id) && seenIds.add(unit.id))
    .map((unit, index) => {
      const bodyTokens = tokenize(unit.text);
      const titleTokens = tokenize(unit.title || "");
      const chapterTokens = tokenize(unit.chapter || "");
      const frequencies = countTerms(bodyTokens);
      const metadataFrequencies = countTerms([...titleTokens, ...chapterTokens]);
      return {
        unit,
        index,
        frequencies,
        metadataFrequencies,
        length: bodyTokens.length,
        normalizedBody: normalizeText(unit.text),
        normalizedTitle: normalizeText(unit.title || ""),
      };
    });

  const documentFrequency = new Map();
  for (const document of documents) {
    const terms = new Set([
      ...document.frequencies.keys(),
      ...document.metadataFrequencies.keys(),
    ]);
    for (const token of terms) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const averageLength = documents.length
    ? documents.reduce((sum, document) => sum + document.length, 0) / documents.length
    : 0;
  const safeOptions = options && typeof options === "object" ? options : {};
  const configuredMinimumScore = Number(safeOptions.minimumScore);
  const minimumScore = Number.isFinite(configuredMinimumScore) && configuredMinimumScore >= 0
    ? configuredMinimumScore
    : 0.12;

  function retrieve(query, currentUnitId, limit = MAX_RESULTS) {
    const normalizedQuery = normalizeText(String(query ?? "").slice(0, MAX_QUERY_CHARACTERS)).trim();
    const queryTokens = [...new Set(tokenize(normalizedQuery))].slice(0, MAX_QUERY_TERMS);
    const requestedLimit = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : MAX_RESULTS;
    if (!queryTokens.length || !documents.length || requestedLimit <= 0) return [];
    const count = Math.min(MAX_RESULTS, requestedLimit);
    const currentDocument = documents.find((item) => item.unit.id === currentUnitId);
    const currentChapter = currentDocument?.unit.chapter;
    const scored = [];

    for (const document of documents) {
      if (document.unit.id === currentUnitId) continue;
      let score = 0;
      let matchedTerms = 0;
      for (const token of queryTokens) {
        const frequency = document.frequencies.get(token) || 0;
        const metadataFrequency = document.metadataFrequencies.get(token) || 0;
        if (!frequency && !metadataFrequency) continue;
        matchedTerms += 1;
        const df = documentFrequency.get(token) || 0;
        const inverseFrequency = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const lengthNorm = BM25_K1 * (
          1 - BM25_B + BM25_B * document.length / Math.max(averageLength, 1)
        );
        const bodyScore = frequency
          ? inverseFrequency * (frequency * (BM25_K1 + 1)) / (frequency + lengthNorm)
          : 0;
        const metadataScore = metadataFrequency
          ? inverseFrequency * Math.min(metadataFrequency, 3) * 1.8
          : 0;
        score += bodyScore + metadataScore;
      }
      if (!matchedTerms) continue;

      const coverage = matchedTerms / queryTokens.length;
      score *= 0.65 + 0.35 * coverage;
      if (currentChapter && document.unit.chapter === currentChapter) score *= 0.92;
      if (normalizedQuery.length >= 4 && document.normalizedBody.includes(normalizedQuery)) score *= 1.35;
      if (normalizedQuery.length >= 4 && document.normalizedTitle.includes(normalizedQuery)) score *= 1.6;
      if (score > 0) scored.push({ unit: document.unit, score, index: document.index });
    }

    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    const strongestScore = scored[0]?.score || 0;
    const threshold = Math.max(minimumScore, strongestScore * 0.35);

    // Prefer chapter diversity without discarding a substantially stronger match.
    const selected = [];
    const chapterCounts = new Map();
    for (const candidate of scored) {
      if (candidate.score < threshold) break;
      const chapter = candidate.unit.chapter || "";
      const sameChapterCount = chapterCounts.get(chapter) || 0;
      const strongestSelected = selected[0]?.score || candidate.score;
      const diversityPenalty = sameChapterCount > 0 ? 0.82 ** sameChapterCount : 1;
      if (selected.length >= 2 && candidate.score * diversityPenalty < strongestSelected * 0.28) continue;
      selected.push(candidate);
      chapterCounts.set(chapter, sameChapterCount + 1);
      if (selected.length >= count) break;
    }
    return selected.map((item) => item.unit);
  }

  return Object.freeze({
    documentCount: documents.length,
    retrieve,
  });
}
