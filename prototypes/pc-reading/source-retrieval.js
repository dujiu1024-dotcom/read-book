export function tokenizeSourceText(value) {
  const terms = [];
  const text = String(value || "").toLowerCase().normalize("NFKC");
  const segments = text.match(/[a-z0-9]+|[\u3400-\u9fff]+/g) || [];
  for (const segment of segments) {
    if (/^[a-z0-9]+$/.test(segment)) {
      if (segment.length > 1) terms.push(segment);
      continue;
    }
    if (segment.length === 1) terms.push(segment);
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= segment.length; index += 1) {
        terms.push(segment.slice(index, index + size));
      }
    }
  }
  return terms;
}

/**
 * Builds a deterministic, local lexical retriever over the current BookRevision.
 * Returned units are always selected from the supplied revision; callers should
 * still enforce request-level source limits and citation verification.
 */
export function createBookSourceSearch(units) {
  const documents = units.map((unit, index) => {
    const tokens = tokenizeSourceText([unit.title, unit.chapter, unit.text].join(" "));
    const frequencies = new Map();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
    return { unit, index, frequencies, length: tokens.length };
  });
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const token of document.frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(documents.length, 1);
  return (query, excludedUnitId, limit = 7) => {
    const queryTerms = new Set(tokenizeSourceText(query));
    if (!queryTerms.size || !documents.length || limit <= 0) return [];
    const ranked = [];
    for (const document of documents) {
      if (document.unit.id === excludedUnitId) continue;
      let score = 0;
      for (const token of queryTerms) {
        const frequency = document.frequencies.get(token) || 0;
        if (!frequency) continue;
        const df = documentFrequency.get(token) || 0;
        const inverseFrequency = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const lengthNorm = 1.2 * (0.25 + 0.75 * document.length / Math.max(averageLength, 1));
        score += inverseFrequency * (frequency * 2.2) / (frequency + lengthNorm);
      }
      if (score > 0) ranked.push({ unit: document.unit, score, index: document.index });
    }
    ranked.sort((left, right) => right.score - left.score || left.index - right.index);
    return ranked.slice(0, Math.min(limit, 7)).map(({ unit }) => unit);
  };
}
