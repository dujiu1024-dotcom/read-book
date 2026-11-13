from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

FORBIDDEN_ACTIONS = {
    "proactive_question",
    "proactive_next_unit",
    "quiz",
    "score_understanding",
    "nag_user",
}


class EvaluationError(Exception):
    pass


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise EvaluationError(f"{path}:{line_number}: invalid JSON: {exc}") from exc
            if not isinstance(value, dict):
                raise EvaluationError(f"{path}:{line_number}: each JSONL row must be an object")
            rows.append(value)
    return rows


def require_unique(rows: list[dict[str, Any]], key: str, label: str) -> dict[str, dict[str, Any]]:
    result = {}
    for row in rows:
        value = row.get(key)
        if not isinstance(value, str) or not value:
            raise EvaluationError(f"{label}: missing string field {key}")
        if value in result:
            raise EvaluationError(f"{label}: duplicate {key}={value}")
        result[value] = row
    return result


def locator_matches(actual: Any, expected: Any) -> bool:
    return isinstance(actual, dict) and isinstance(expected, dict) and actual == expected


def evaluate(corpus_rows: list[dict[str, Any]], question_rows: list[dict[str, Any]],
             prediction_rows: list[dict[str, Any]], k: int = 3) -> dict[str, Any]:
    if k < 1:
        raise EvaluationError("k must be >= 1")
    corpus = require_unique(corpus_rows, "chunk_id", "corpus")
    questions = require_unique(question_rows, "question_id", "questions")
    predictions = require_unique(prediction_rows, "question_id", "predictions")
    unknown = set(predictions) - set(questions)
    missing = set(questions) - set(predictions)
    if unknown:
        raise EvaluationError(f"predictions contain unknown question IDs: {sorted(unknown)}")
    if missing:
        raise EvaluationError(f"predictions missing question IDs: {sorted(missing)}")

    recall_values = []
    citation_hits = citation_total = 0
    citation_covered = answerable_count = 0
    locator_total = locator_hits = 0
    author_claim_total = grounded_author_claims = 0
    unanswerable_total = correct_abstentions = 0
    answerable_abstentions = 0
    forbidden_events = []
    latencies, input_tokens, output_tokens = [], [], []
    by_type: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "questions": 0, "recall_values": [], "citation_hits": 0,
        "citation_total": 0, "citation_covered": 0, "answerable": 0
    })

    for qid, question in questions.items():
        prediction = predictions[qid]
        gold = set(question.get("gold_evidence_chunk_ids") or [])
        retrieved = prediction.get("retrieved_chunk_ids") or []
        if not isinstance(retrieved, list) or any(not isinstance(x, str) for x in retrieved):
            raise EvaluationError(f"{qid}: retrieved_chunk_ids must be a string array")
        for chunk_id in retrieved:
            if chunk_id not in corpus:
                raise EvaluationError(f"{qid}: unknown retrieved chunk {chunk_id}")
        retrieved_top_k = set(retrieved[:k])
        recall = len(gold & retrieved_top_k) / len(gold) if gold else None
        if recall is not None:
            recall_values.append(recall)

        citations = prediction.get("citations") or []
        if not isinstance(citations, list):
            raise EvaluationError(f"{qid}: citations must be an array")
        hits = 0
        for citation in citations:
            if not isinstance(citation, dict) or not isinstance(citation.get("chunk_id"), str):
                raise EvaluationError(f"{qid}: each citation needs chunk_id")
            chunk_id = citation["chunk_id"]
            if chunk_id not in corpus:
                raise EvaluationError(f"{qid}: citation references unknown chunk {chunk_id}")
            citation_total += 1
            hits += int(chunk_id in gold)
            citation_hits += int(chunk_id in gold)
        answerable = bool(question.get("answerable"))
        if answerable:
            answerable_count += 1
            if hits:
                citation_covered += 1
        else:
            unanswerable_total += 1
            if bool(prediction.get("abstained")):
                correct_abstentions += 1
        if answerable and bool(prediction.get("abstained")):
            answerable_abstentions += 1

        expected_locator = question.get("expected_locator")
        if expected_locator is not None:
            locator_total += 1
            locator_ok = any(
                citation.get("chunk_id") in gold
                and locator_matches(citation.get("locator"), expected_locator)
                for citation in citations
            )
            locator_hits += int(locator_ok)

        claims = prediction.get("claims") or []
        if not isinstance(claims, list):
            raise EvaluationError(f"{qid}: claims must be an array")
        for claim in claims:
            if not isinstance(claim, dict):
                raise EvaluationError(f"{qid}: claim must be an object")
            if claim.get("claim_type") == "author_fact":
                author_claim_total += 1
                grounded_author_claims += int(claim.get("human_adjudicated_supported") is True)

        for action in prediction.get("agent_actions") or []:
            if action in FORBIDDEN_ACTIONS:
                forbidden_events.append({"question_id": qid, "action": action})
        for key, target in (("latency_ms", latencies), ("input_tokens", input_tokens), ("output_tokens", output_tokens)):
            value = prediction.get(key)
            if value is not None:
                if not isinstance(value, (int, float)) or value < 0:
                    raise EvaluationError(f"{qid}: {key} must be a non-negative number")
                target.append(value)

        bucket = by_type[question.get("question_type", "unspecified")]
        bucket["questions"] += 1
        if recall is not None:
            bucket["recall_values"].append(recall)
        if answerable:
            bucket["answerable"] += 1
            bucket["citation_covered"] += int(hits > 0)
        bucket["citation_hits"] += hits
        bucket["citation_total"] += len(citations)

    mean = lambda values: round(statistics.mean(values), 4) if values else None
    metrics = {
        f"recall_at_{k}": mean(recall_values),
        "citation_precision": round(citation_hits / citation_total, 4) if citation_total else None,
        "citation_coverage": round(citation_covered / answerable_count, 4) if answerable_count else None,
        "locator_accuracy": round(locator_hits / locator_total, 4) if locator_total else None,
        "human_adjudicated_groundedness": round(grounded_author_claims / author_claim_total, 4) if author_claim_total else None,
        "unanswerable_abstention_accuracy": round(correct_abstentions / unanswerable_total, 4) if unanswerable_total else None,
        "answerable_abstention_rate": round(answerable_abstentions / answerable_count, 4) if answerable_count else None,
        "forbidden_agent_action_count": len(forbidden_events),
        "mean_latency_ms": mean(latencies),
        "mean_input_tokens": mean(input_tokens),
        "mean_output_tokens": mean(output_tokens),
        "total_questions": len(questions),
        "answerable_questions": answerable_count,
        "unanswerable_questions": unanswerable_total,
        "prediction_count": len(predictions),
    }
    type_metrics = {}
    for name, bucket in sorted(by_type.items()):
        type_metrics[name] = {
            "questions": bucket["questions"],
            f"recall_at_{k}": mean(bucket["recall_values"]),
            "citation_precision": round(bucket["citation_hits"] / bucket["citation_total"], 4) if bucket["citation_total"] else None,
            "citation_coverage": round(bucket["citation_covered"] / bucket["answerable"], 4) if bucket["answerable"] else None,
        }
    return {
        "report_version": "1.0.0",
        "evaluation_status": "measured_on_supplied_predictions",
        "dataset_provenance": "synthetic_fixture_not_real_book_baseline",
        "metric_notes": {
            "citation_precision": "Gold evidence chunk membership; semantic support still needs human review.",
            "citation_coverage": "Share of answerable questions with at least one gold evidence citation.",
            "locator_accuracy": "Exact structured locator equality for locator questions.",
            "human_adjudicated_groundedness": "Uses reviewer-supplied human_adjudicated_supported; not inferred by the script.",
            "agent_policy": "Counts prohibited actions only when the adapter records them in agent_actions.",
            "thresholds": "No pass threshold is set by this first baseline; values are measurements, not release gates."
        },
        "metrics": metrics,
        "by_question_type": type_metrics,
        "policy_violations": forbidden_events,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline evaluator for the read-book Agent/RAG JSONL protocol.")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("evaluate")
    run.add_argument("--corpus", type=Path, required=True)
    run.add_argument("--questions", type=Path, required=True)
    run.add_argument("--predictions", type=Path, required=True)
    run.add_argument("--output", type=Path)
    run.add_argument("-k", type=int, default=3)
    args = parser.parse_args(argv)
    try:
        report = evaluate(load_jsonl(args.corpus), load_jsonl(args.questions), load_jsonl(args.predictions), args.k)
        serialized = json.dumps(report, ensure_ascii=False, indent=2)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(serialized + "\n", encoding="utf-8")
        print(serialized)
        return 0
    except (EvaluationError, OSError) as exc:
        print(f"evaluation failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
