import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


class DatasetIntegrityTests(unittest.TestCase):
    def test_dataset_has_three_fixture_formats_and_thirty_questions(self):
        corpus = read_jsonl(FIXTURES / "corpus.jsonl")
        questions = read_jsonl(FIXTURES / "questions.jsonl")
        self.assertEqual(len(corpus), 12)
        self.assertEqual(len(questions), 30)
        self.assertEqual(
            {row["source_format"] for row in corpus},
            {"epub_structure_fixture", "pdf_extraction_fixture", "txt_heading_fixture"}
        )
        self.assertTrue(all(row["sample_kind"] == "synthetic_fixture" for row in corpus))

    def test_question_ids_and_evidence_references_are_valid(self):
        corpus = read_jsonl(FIXTURES / "corpus.jsonl")
        questions = read_jsonl(FIXTURES / "questions.jsonl")
        chunk_ids = {row["chunk_id"] for row in corpus}
        question_ids = [row["question_id"] for row in questions]
        self.assertEqual(len(question_ids), len(set(question_ids)))
        for question in questions:
            self.assertTrue(question["gold_evidence_chunk_ids"] or not question["answerable"])
            self.assertTrue(set(question["gold_evidence_chunk_ids"]).issubset(chunk_ids))
            self.assertEqual(question["answerable"], bool(question["gold_evidence_chunk_ids"]))
            self.assertTrue(question["acceptable_answer_points"])

    def test_question_type_distribution_covers_six_categories(self):
        questions = read_jsonl(FIXTURES / "questions.jsonl")
        types = {row["question_type"] for row in questions}
        self.assertEqual(types, {
            "direct_fact", "cross_chunk", "concept_explanation",
            "author_counterargument", "unanswerable", "citation_locator"
        })


if __name__ == "__main__":
    unittest.main()
