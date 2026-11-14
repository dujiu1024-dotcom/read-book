const DEFAULT_STOPWORDS = new Set([
  "这个", "那个", "我们", "你们", "他们", "她们", "以及", "但是", "因为", "所以",
  "如果", "那么", "如何", "为什么", "什么", "怎么", "可以", "应该", "不是", "一个",
  "一些", "这种", "那种", "这里", "那里", "对于", "关于", "其中", "自己", "已经",
]);

function tokenize(value) {
  const segments = String(value || "").toLocaleLowerCase().match(/[\u3400-\u9fff]+|[a-z0-9]+/g) || [];
  const tokens = [];
  for (const segment of segments) {
    if (/^[\u3400-\u9fff]+$/.test(segment)) {
      if (segment.length > 1) {
        for (let index = 0; index < segment.length - 1; index += 1) {
          const token = segment.slice(index, index + 2);
          if (!DEFAULT_STOPWORDS.has(token)) tokens.push(token);
        }
      }
    } else if (segment.length > 1 && !DEFAULT_STOPWORDS.has(segment)) {
      tokens.push(segment);
    }
  }
  return tokens;
}

export function createSourceRetriever(units) {
  const documents = (Array.isArray(units) ? units : [])
    .filter((unit) => unit && typeof unit.id === "string" && typeof unit.text === "string" && unit.text.trim())
    .map((unit, index) => {
      const tokens = tokenize([unit.title, unit.chapter, unit.text].filter(Boolean).join("\n"));
      const frequencies = new Map();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
      return { unit, index, length: tokens.length, frequencies };
    });
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const token of document.frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const averageLength = documents.length
    ? documents.reduce((sum, document) => sum + document.length, 0) / documents.length
    : 0;

  function retrieve(query, currentUnitId, limit = 3) {
    const queryTokens = [...new Set(tokenize(query))];
    if (!queryTokens.length || !documents.length || limit <= 0) return [];
    const count = Math.min(7, Math.floor(limit));
    const currentChapter = documents.find((item) => item.unit.id === currentUnitId)?.unit.chapter;
    const scored = [];
    for (const document of documents) {
      if (document.unit.id === currentUnitId) continue;
      let score = 0;
      for (const token of queryTokens) {
        const frequency = document.frequencies.get(token) || 0;
        if (!frequency) continue;
        const df = documentFrequency.get(token) || 0;
        const inverseFrequency = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const denominator = frequency + 1.2 * (0.25 + 0.75 * document.length / Math.max(averageLength, 1));
        score += inverseFrequency * (frequency * 2.2) / denominator;
      }
      if (currentChapter && document.unit.chapter === currentChapter) score *= 0.9;
      if (score > 0) scored.push({ unit: document.unit, score, index: document.index });
    }
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    const strongestScore = scored[0]?.score || 0;
    const minimumScore = Math.max(0.12, strongestScore * 0.45);
    return scored.filter((item) => item.score >= minimumScore).slice(0, count).map((item) => item.unit);
  }

  return Object.freeze({
    documentCount: documents.length,
    retrieve,
  });
}
