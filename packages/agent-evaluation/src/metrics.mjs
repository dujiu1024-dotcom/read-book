function unique(values) {
  return [...new Set(values)];
}

function validateRecord(record, index) {
  const prefix = "record[" + index + "]";
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(prefix + " must be an object");
  for (const key of ["id", "sample_id"]) {
    if (typeof record[key] !== "string" || !record[key].trim()) throw new Error(prefix + "." + key + " must be a non-empty string");
  }
  if (!record.source || typeof record.source !== "object") throw new Error(prefix + ".source is required");
  if (!["synthetic", "licensed", "public_domain", "user_provided"].includes(record.source.source_type)) throw new Error(prefix + ".source.source_type is invalid");
  if (typeof record.source.source_ref !== "string" || !record.source.source_ref.trim()) throw new Error(prefix + ".source.source_ref is required");
  if (typeof record.source.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.source.sha256)) throw new Error(prefix + ".source.sha256 must be a SHA-256 hex digest");
  if (!["approved", "pending", "not_required"].includes(record.source.authorization_status)) throw new Error(prefix + ".source.authorization_status is invalid");
  if (!Array.isArray(record.expected_evidence_ids) || !Array.isArray(record.retrieved_evidence_ids)) throw new Error(prefix + " evidence ID fields must be arrays");
  if (!Array.isArray(record.answer_point_ids) || !Array.isArray(record.citations)) throw new Error(prefix + " answer_point_ids and citations must be arrays");
  if (typeof record.should_abstain !== "boolean" || typeof record.abstained !== "boolean") throw new Error(prefix + " abstention fields must be booleans");
  for (const key of ["latency_ms", "input_tokens", "output_tokens"]) {
    if (!Number.isFinite(record[key]) || record[key] < 0) throw new Error(prefix + "." + key + " must be a non-negative number");
  }
  for (const citation of record.citations) {
    if (!citation || typeof citation.evidence_id !== "string" || !citation.evidence_id.trim()) throw new Error(prefix + " citation evidence_id is required");
    if (typeof citation.locator_correct !== "boolean") throw new Error(prefix + " citation locator_correct must be a boolean adjudication");
    if (!Array.isArray(citation.supports_point_ids)) throw new Error(prefix + " citation supports_point_ids must be an array");
  }
  if (record.behavior_violations !== undefined && (!Array.isArray(record.behavior_violations) || record.behavior_violations.some((item) => typeof item !== "string"))) {
    throw new Error(prefix + ".behavior_violations must be an array of strings");
  }
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

export function evaluateRecords(records, options = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("At least one evaluation record is required");
  const k = options.k ?? 5;
  if (!Number.isInteger(k) || k < 1 || k > 100) throw new Error("k must be an integer between 1 and 100");
  records.forEach(validateRecord);

  const retrievalCases = records.filter((record) => record.expected_evidence_ids.length > 0);
  const recallValues = retrievalCases.map((record) => {
    const expected = new Set(record.expected_evidence_ids);
    const retrieved = unique(record.retrieved_evidence_ids.slice(0, k));
    return ratio(retrieved.filter((id) => expected.has(id)).length, expected.size);
  });
  const allCitations = records.flatMap((record) => record.citations.map((citation) => ({ ...citation, expected: new Set(record.expected_evidence_ids) })));
  const validCitations = allCitations.filter((citation) => citation.expected.has(citation.evidence_id));
  const citationCases = retrievalCases;
  const coveredCases = citationCases.filter((record) =>
    record.citations.some((citation) => record.expected_evidence_ids.includes(citation.evidence_id))
  );
  let totalAnswerPoints = 0;
  let supportedAnswerPoints = 0;
  for (const record of records) {
    const valid = record.citations.filter((citation) => record.expected_evidence_ids.includes(citation.evidence_id));
    const supported = new Set(valid.flatMap((citation) => citation.supports_point_ids));
    const points = new Set(record.answer_point_ids);
    totalAnswerPoints += points.size;
    supportedAnswerPoints += [...points].filter((id) => supported.has(id)).length;
  }
  const answerable = records.filter((record) => !record.should_abstain);
  const abstentionRequired = records.filter((record) => record.should_abstain);
  const violations = records.flatMap((record) => (record.behavior_violations || []).map((code) => ({ record_id: record.id, code })));
  const latency = records.map((record) => record.latency_ms);
  const inputTokens = records.reduce((sum, record) => sum + record.input_tokens, 0);
  const outputTokens = records.reduce((sum, record) => sum + record.output_tokens, 0);
  const pricing = options.pricing || null;
  const tokenCost = pricing && Number.isFinite(pricing.input_per_million) && Number.isFinite(pricing.output_per_million)
    ? (inputTokens * pricing.input_per_million + outputTokens * pricing.output_per_million) / 1_000_000
    : null;

  return {
    schema_version: "1.0.0",
    generated_at: (options.now || (() => new Date().toISOString()))(),
    sample_count: records.length,
    retrieval: {
      k,
      evaluated_cases: retrievalCases.length,
      recall_at_k_macro: ratio(recallValues.reduce((sum, value) => sum + (value ?? 0), 0), recallValues.length)
    },
    citations: {
      citation_count: allCitations.length,
      precision: ratio(validCitations.length, allCitations.length),
      coverage: ratio(coveredCases.length, citationCases.length),
      locator_accuracy: ratio(allCitations.filter((citation) => citation.locator_correct).length, allCitations.length)
    },
    groundedness: {
      answer_point_count: totalAnswerPoints,
      supported_answer_point_count: supportedAnswerPoints,
      supported_answer_point_ratio: ratio(supportedAnswerPoints, totalAnswerPoints)
    },
    abstention: {
      answerable_cases: answerable.length,
      should_abstain_cases: abstentionRequired.length,
      correct_decisions: records.filter((record) => record.abstained === record.should_abstain).length,
      decision_accuracy: ratio(records.filter((record) => record.abstained === record.should_abstain).length, records.length),
      unsupported_answer_rate: ratio(abstentionRequired.filter((record) => !record.abstained).length, abstentionRequired.length)
    },
    behavior: { violation_count: violations.length, violations },
    performance: {
      latency_ms: { p50: percentile(latency, 0.50), p95: percentile(latency, 0.95), max: latency.length ? Math.max(...latency) : null },
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_token_cost: tokenCost,
      currency: pricing?.currency || null
    },
    limitations: [
      "Recall, citation precision and groundedness depend on human-authored expected evidence and answer-point annotations.",
      "Locator accuracy is an explicit human adjudication field, not inferred from string similarity.",
      "Estimated token cost is null unless caller supplies model-specific pricing."
    ]
  };
}
