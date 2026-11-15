/**
 * 回答正文的引文校验：模型写在引号里的片段必须能在本轮提供的原文中逐字找到。
 * 找不到的引文去掉引号（改成不带引号的转述）并计数；这是「引用可追溯」的硬门槛。
 * 单独成文件，便于直接测试。
 */

/** 逐字比对只看字符本身：空白差异（原文换行）不算改动。 */
export function normalizeQuoteText(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

/** 引文里常见的省略号会把一句话拆成多段，每段都必须逐字命中。 */
export function quoteFragments(inner) {
  return String(inner ?? "")
    .split(/(?:……|…|⋯+|\.{3,})/)
    .map(normalizeQuoteText)
    .filter((fragment) => fragment.length >= 4);
}

const QUOTE_SPAN = /「([^「」]{2,400})」|『([^『』]{2,400})』|“([^“”]{2,400})”|"([^"\n]{2,400})"/g;
const QUOTE_SOURCE_REF = /^[\s，,。；;：:]{0,4}(?:（|\()?原文\s*([1-9]\d?)/;

export function verifyAnswerQuotes(content, sources) {
  const texts = (Array.isArray(sources) ? sources : []).map((source) => normalizeQuoteText(source?.excerpt));
  const audit = { checked: 0, blocked: 0, samples: [] };
  if (!texts.length) return { content: String(content ?? ""), ...audit };
  const verified = (inner, sourceIndex) => {
    const fragments = quoteFragments(inner);
    if (!fragments.length) return true;
    // 引文后面紧跟「原文 N」时只认那一处来源；没有标注才允许多来源命中。
    const candidates = sourceIndex >= 1 && sourceIndex <= texts.length ? [texts[sourceIndex - 1]] : texts;
    return fragments.every((fragment) => candidates.some((text) => text.includes(fragment)));
  };
  const output = String(content ?? "").replace(QUOTE_SPAN, (whole, a, b, c, d, offset, original) => {
    const inner = a ?? b ?? c ?? d ?? "";
    if (normalizeQuoteText(inner).length < 2) return whole;
    audit.checked += 1;
    const reference = QUOTE_SOURCE_REF.exec(String(original).slice(offset + whole.length, offset + whole.length + 20));
    const sourceIndex = reference ? Number(reference[1]) : 0;
    if (verified(inner, sourceIndex)) return whole;
    audit.blocked += 1;
    if (audit.samples.length < 8) audit.samples.push(inner.slice(0, 80));
    return inner;
  });
  if (!audit.blocked) return { content: output, ...audit };
  return {
    content: output + "\n\n（说明：本回答有 " + audit.blocked + " 处引文未能在本轮提供的原文中逐字找到，已改为不带引号的转述。）",
    ...audit,
  };
}
