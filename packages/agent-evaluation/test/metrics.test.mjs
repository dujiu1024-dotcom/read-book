import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRecords } from "../src/metrics.mjs";

const source = { source_type: "licensed", source_ref: "license-record-001", sha256: "a".repeat(64), authorization_status: "approved" };
const record = (overrides = {}) => ({
  id: "case-1", sample_id: "sample-1", source,
  expected_evidence_ids: ["chunk-a", "chunk-b"],
  retrieved_evidence_ids: ["chunk-a", "chunk-x"],
  answer_point_ids: ["point-1", "point-2"],
  citations: [{ evidence_id: "chunk-a", locator_correct: true, supports_point_ids: ["point-1"] }],
  should_abstain: false, abstained: false,
  latency_ms: 100, input_tokens: 10, output_tokens: 20,
  behavior_violations: [],
  ...overrides
});

test("calculates retrieval, citation, groundedness, abstention and performance metrics", () => {
  const report = evaluateRecords([record()], { k: 2, pricing: { input_per_million: 1, output_per_million: 2, currency: "USD" }, now: () => "2026-11-14T00:00:00.000Z" });
  assert.equal(report.retrieval.recall_at_k_macro, 0.5);
  assert.equal(report.citations.precision, 1);
  assert.equal(report.citations.coverage, 1);
  assert.equal(report.citations.locator_accuracy, 1);
  assert.equal(report.groundedness.supported_answer_point_ratio, 0.5);
  assert.equal(report.abstention.decision_accuracy, 1);
  assert.equal(report.performance.latency_ms.p95, 100);
  assert.equal(report.performance.estimated_token_cost, 0.00005);
});

test("reports unsupported answers and behavior violations", () => {
  const report = evaluateRecords([record({
    should_abstain: true, abstained: false, citations: [],
    behavior_violations: ["UNSOLICITED_QUESTION", "AUTO_CONTINUE"]
  })]);
  assert.equal(report.abstention.unsupported_answer_rate, 1);
  assert.equal(report.citations.precision, null);
  assert.equal(report.behavior.violation_count, 2);
});

test("rejects missing provenance, invalid locators and empty datasets", () => {
  assert.throws(() => evaluateRecords([record({ source: { ...source, sha256: "bad" } })]), /SHA-256/);
  assert.throws(() => evaluateRecords([record({ citations: [{ evidence_id: "chunk-a", locator_correct: "yes", supports_point_ids: [] }] })]), /locator_correct/);
  assert.throws(() => evaluateRecords([]), /At least one/);
});
