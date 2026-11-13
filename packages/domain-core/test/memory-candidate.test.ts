import test from "node:test";
import assert from "node:assert/strict";
import {
  DomainRuleError,
  evaluateMemoryCandidate,
  type MemoryCandidate,
  type MemoryCandidatePolicy,
} from "../src/index.ts";

const candidate: MemoryCandidate = {
  id: "candidate-1",
  title: "目标一致性比沟通频率更重要",
  content: "协同质量取决于目标一致和交接清晰，而不是沟通次数本身。",
  viewpoint: "user",
  confidence: 0.9,
  ambiguity: 0.1,
  value: {
    novelty: 0.8,
    stability: 0.7,
    explanatoryPower: 0.9,
    discussionDepth: 0.6,
    relationStrength: 0.8,
  },
  sourceMessageIds: ["message-1"],
  sourceReferences: [],
};

const policy: MemoryCandidatePolicy = {
  weights: {
    novelty: 1,
    stability: 1,
    explanatoryPower: 1,
    discussionDepth: 1,
    relationStrength: 1,
  },
  minimumValueScore: 0.7,
  minimumConfidence: 0.75,
  maximumAmbiguity: 0.25,
  minimumSourceMessages: 1,
};

test("accepts a valuable, grounded candidate and preserves viewpoint", () => {
  const result = evaluateMemoryCandidate(candidate, policy);
  assert.equal(result.decision, "accept");
  assert.equal(candidate.viewpoint, "user");
  assert.ok(result.score >= policy.minimumValueScore);
});

test("does not use repeated discussion as the sole acceptance condition", () => {
  const lowValue = {
    ...candidate,
    value: { novelty: 0.1, stability: 0.1, explanatoryPower: 0.1, discussionDepth: 1, relationStrength: 0.1 },
  };
  const result = evaluateMemoryCandidate(lowValue, policy);
  assert.equal(result.decision, "reject");
  assert.deepEqual(result.reasons, ["insufficient_cognitive_value"]);
});

test("routes uncertain or ambiguous candidates to confirmation", () => {
  const result = evaluateMemoryCandidate({ ...candidate, confidence: 0.4, ambiguity: 0.8 }, policy);
  assert.equal(result.decision, "needs_confirmation");
  assert.deepEqual(result.reasons, ["low_confidence", "high_ambiguity"]);
});

test("rejects candidates without traceable source messages", () => {
  const result = evaluateMemoryCandidate({ ...candidate, sourceMessageIds: [] }, policy);
  assert.equal(result.decision, "reject");
  assert.ok(result.reasons.includes("insufficient_source_messages"));
});

test("supports author and assistant-inference viewpoints without merging them", () => {
  assert.equal(evaluateMemoryCandidate({ ...candidate, viewpoint: "author" }, policy).decision, "accept");
  assert.equal(evaluateMemoryCandidate({ ...candidate, viewpoint: "assistant_inference" }, policy).decision, "accept");
});

test("rejects invalid scores and policy thresholds", () => {
  assert.throws(() => evaluateMemoryCandidate({ ...candidate, confidence: 1.2 }, policy), DomainRuleError);
  assert.throws(() => evaluateMemoryCandidate(candidate, { ...policy, minimumValueScore: 2 }), DomainRuleError);
  assert.throws(() => evaluateMemoryCandidate(candidate, { ...policy, weights: { ...policy.weights, novelty: -1 } }), DomainRuleError);
});
