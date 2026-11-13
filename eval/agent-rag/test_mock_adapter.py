import unittest
from pathlib import Path

from mock_adapter import build_predictions, read_jsonl
from evaluator import evaluate

ROOT = Path(__file__).resolve().parent


class MockAdapterTests(unittest.TestCase):
    def test_mock_adapter_runs_without_using_gold_labels(self):
        corpus = read_jsonl(ROOT / "fixtures" / "corpus.jsonl")
        questions = read_jsonl(ROOT / "fixtures" / "questions.jsonl")
        predictions = build_predictions(corpus, questions, 3)
        self.assertEqual(len(predictions), 30)
        self.assertTrue(all(row["run_metadata"]["gold_labels_used_for_retrieval"] is False for row in predictions))
        self.assertTrue(all(row["run_metadata"]["run_kind"] == "mock_retrieval_only" for row in predictions))
        report = evaluate(corpus, questions, predictions, 3)
        self.assertEqual(report["metrics"]["total_questions"], 30)
        self.assertEqual(report["prediction_provenance"][0]["adapter"], "lexical-mock")
        self.assertIsNone(report["metrics"]["human_adjudicated_groundedness"])


if __name__ == "__main__":
    unittest.main()
