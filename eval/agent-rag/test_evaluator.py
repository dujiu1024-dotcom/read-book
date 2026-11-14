import unittest
from evaluator import EvaluationError, evaluate
class EvaluatorTests(unittest.TestCase):
    def setUp(self):
        self.corpus = [{"chunk_id": "c1", "locator": {"page": 1}}, {"chunk_id": "c2", "locator": {"page": 2}}]
        self.questions = [
            {"question_id": "q1", "question_type": "direct_fact", "answerable": True, "gold_evidence_chunk_ids": ["c1"], "expected_locator": {"page": 1}},
            {"question_id": "q2", "question_type": "unanswerable", "answerable": False, "gold_evidence_chunk_ids": [], "expected_locator": None}]
        self.predictions = [
            {"question_id": "q1", "retrieved_chunk_ids": ["c1", "c2"], "citations": [{"chunk_id": "c1", "locator": {"page": 1}}],
             "claims": [{"claim_type": "author_fact", "human_adjudicated_supported": True}], "abstained": False, "agent_actions": [], "latency_ms": 100, "input_tokens": 10, "output_tokens": 20},
            {"question_id": "q2", "retrieved_chunk_ids": ["c2"], "citations": [], "claims": [], "abstained": True, "agent_actions": ["proactive_next_unit"]}]
    def test_metrics_are_calculated(self):
        report = evaluate(self.corpus, self.questions, self.predictions, k=2)
        metrics = report["metrics"]
        self.assertEqual(metrics["recall_at_2"], 1.0)
        self.assertEqual(metrics["citation_precision"], 1.0)
        self.assertEqual(metrics["citation_coverage"], 1.0)
        self.assertEqual(metrics["locator_accuracy"], 1.0)
        self.assertEqual(metrics["human_adjudicated_groundedness"], 1.0)
        self.assertEqual(metrics["unanswerable_abstention_accuracy"], 1.0)
        self.assertEqual(metrics["forbidden_agent_action_count"], 1)
        self.assertEqual(report["dataset_provenance"], "synthetic_fixture_not_real_book_baseline")
    def test_missing_prediction_fails(self):
        with self.assertRaises(EvaluationError): evaluate(self.corpus, self.questions, self.predictions[:1])
    def test_unknown_citation_fails(self):
        broken = [dict(row) for row in self.predictions]
        broken[0] = dict(broken[0], citations=[{"chunk_id": "missing", "locator": {}}])
        with self.assertRaises(EvaluationError): evaluate(self.corpus, self.questions, broken)
    def test_duplicate_question_id_fails(self):
        with self.assertRaises(EvaluationError): evaluate(self.corpus, self.questions + [dict(self.questions[0])], self.predictions)
    def test_k_must_be_positive(self):
        with self.assertRaises(EvaluationError): evaluate(self.corpus, self.questions, self.predictions, k=0)
if __name__ == "__main__":
    unittest.main()
