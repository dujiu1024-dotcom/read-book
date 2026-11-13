from __future__ import annotations

import argparse
import json
import re
import time
from collections import Counter
from pathlib import Path


def tokens(text: str) -> set[str]:
    text = text.lower()
    words = set(re.findall(r"[a-z0-9_]+", text))
    cjk = "".join(re.findall(r"[\u3400-\u9fff]", text))
    words.update(cjk[i:i + 2] for i in range(max(0, len(cjk) - 1)))
    words.update(cjk[i:i + 3] for i in range(max(0, len(cjk) - 2)))
    return words


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def build_predictions(corpus: list[dict], questions: list[dict], top_k: int) -> list[dict]:
    indexed = [(row, tokens(row["text"])) for row in corpus]
    predictions = []
    for question in questions:
        started = time.perf_counter()
        query_tokens = tokens(question["question"])
        ranked = []
        for chunk, chunk_tokens in indexed:
            overlap = len(query_tokens & chunk_tokens)
            score = overlap / max(1, len(query_tokens))
            ranked.append((score, chunk["chunk_id"], chunk))
        ranked.sort(key=lambda item: (-item[0], item[1]))
        selected = [item for item in ranked[:top_k] if item[0] > 0]
        latency_ms = round((time.perf_counter() - started) * 1000, 3)
        predictions.append({
            "question_id": question["question_id"],
            "retrieved_chunk_ids": [item[1] for item in ranked[:top_k]],
            "citations": [],
            "claims": [],
            "abstained": not bool(selected),
            "agent_actions": [],
            "latency_ms": latency_ms,
            "input_tokens": None,
            "output_tokens": None,
            "run_metadata": {
                "adapter": "lexical-mock",
                "adapter_version": "0.1.0",
                "run_kind": "mock_retrieval_only",
                "answer_generation": "none",
                "citation_generation": "none",
                "agent_policy_events": "none",
                "gold_labels_used_for_retrieval": False
            }
        })
    return predictions


def main() -> int:
    parser = argparse.ArgumentParser(description="Gold-blind lexical mock retriever for harness smoke tests.")
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--top-k", type=int, default=3)
    args = parser.parse_args()
    if args.top_k < 1:
        parser.error("--top-k must be >= 1")
    corpus = read_jsonl(args.corpus)
    questions = read_jsonl(args.questions)
    predictions = build_predictions(corpus, questions, args.top_k)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in predictions), encoding="utf-8")
    print(json.dumps({
        "adapter": "lexical-mock",
        "run_kind": "mock_retrieval_only",
        "question_count": len(predictions),
        "output": str(args.output)
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
