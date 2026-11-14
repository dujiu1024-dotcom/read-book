# Agent Evaluation Runner

A dependency-free Node 22 CLI for evaluating retrieval, citation, groundedness, abstention behavior, policy violations, latency and token usage from human-annotated JSONL records.

## Run

```sh
node src/cli.mjs --input ./dataset.jsonl --output ./report.json --k 5
node src/cli.mjs --input ./dataset.jsonl --k 5 --inputPricePerMillion 0.15 --outputPricePerMillion 0.60 --currency USD
node --test test/*.test.mjs
```

Each JSONL row represents one question/model run and must include:
- stable case and sample IDs;
- sample provenance, SHA-256 and authorization status;
- expected evidence IDs and ordered retrieved evidence IDs;
- annotated answer-point IDs and citations, including human-adjudicated locator correctness;
- whether the question should be refused and whether the model actually abstained;
- latency and token counts;
- optional behavior violation codes.

## Metric definitions

- Recall@K: expected evidence IDs found in the first K retrieved evidence IDs, macro-averaged over evidence-bearing cases.
- Citation precision: citations pointing to one of the case's expected evidence IDs divided by all citations.
- Citation coverage: evidence-bearing cases with at least one valid citation divided by evidence-bearing cases.
- Groundedness: annotated answer points supported by at least one valid citation divided by all annotated answer points.
- Locator accuracy: human-adjudicated correct locators divided by all citations.
- Abstention decision accuracy: exact match between should_abstain and abstained; unsupported-answer rate is the share of should-abstain cases that the model answered.
- Behavior violations: explicit reviewer-coded violations such as unsolicited prompting, automatic continuation, quiz/scoring behavior or viewpoint attribution confusion.
- Latency: p50, p95 and max; token cost is only estimated when model-specific prices are supplied.

## Data and quality boundary

The runner does not create annotations, infer ground truth, or define production pass thresholds. A report based on synthetic fixtures is not a production baseline. Licensed/public-domain/user-provided sample provenance must be recorded; pending authorization is visible in the source metadata and must not be treated as approved. Real Chinese book samples and human annotations remain a separate data-collection requirement.
