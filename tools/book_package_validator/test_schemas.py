import copy
import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = ROOT / "schemas" / "book-package" / "1.0.0"


class BookPackageSchemaTests(unittest.TestCase):
    def test_all_schemas_are_valid_and_examples_match(self):
        schemas = list(SCHEMA_DIR.glob("*.schema.json"))
        self.assertGreaterEqual(len(schemas), 7)
        for schema_path in schemas:
            with self.subTest(schema=schema_path.name):
                schema = json.loads(schema_path.read_text(encoding="utf-8"))
                Draft202012Validator.check_schema(schema)
                example_path = SCHEMA_DIR / schema_path.name.replace(".schema.json", ".example.json")
                self.assertTrue(example_path.exists(), f"missing example for {schema_path.name}")
                example = json.loads(example_path.read_text(encoding="utf-8"))
                Draft202012Validator(schema, format_checker=FormatChecker()).validate(example)

    def test_manifest_rejects_missing_required_identity(self):
        schema = json.loads((SCHEMA_DIR / "manifest.schema.json").read_text(encoding="utf-8"))
        example = json.loads((SCHEMA_DIR / "manifest.example.json").read_text(encoding="utf-8"))
        invalid = copy.deepcopy(example)
        invalid.pop("package_id")
        with self.assertRaises(Exception):
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(invalid)

    def test_manifest_rejects_parent_traversal_source_path(self):
        schema = json.loads((SCHEMA_DIR / "manifest.schema.json").read_text(encoding="utf-8"))
        example = json.loads((SCHEMA_DIR / "manifest.example.json").read_text(encoding="utf-8"))
        invalid = copy.deepcopy(example)
        invalid["source"]["file"] = "source/../../outside.txt"
        with self.assertRaises(Exception):
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(invalid)

    def test_book_rejects_empty_title(self):
        schema = json.loads((SCHEMA_DIR / "book.schema.json").read_text(encoding="utf-8"))
        example = json.loads((SCHEMA_DIR / "book.example.json").read_text(encoding="utf-8"))
        invalid = copy.deepcopy(example)
        invalid["title"] = ""
        with self.assertRaises(Exception):
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(invalid)

    def test_chapters_reject_negative_order_index(self):
        schema = json.loads((SCHEMA_DIR / "chapters.schema.json").read_text(encoding="utf-8"))
        example = json.loads((SCHEMA_DIR / "chapters.example.json").read_text(encoding="utf-8"))
        invalid = copy.deepcopy(example)
        invalid[0]["order_index"] = -1
        with self.assertRaises(Exception):
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(invalid)

    def test_chunk_rejects_missing_locator(self):
        schema = json.loads((SCHEMA_DIR / "chunk.schema.json").read_text(encoding="utf-8"))
        example = json.loads((SCHEMA_DIR / "chunk.example.json").read_text(encoding="utf-8"))
        invalid = copy.deepcopy(example)
        invalid.pop("start_locator")
        with self.assertRaises(Exception):
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(invalid)

    def test_embeddings_reject_zero_dimension(self):
        schema = json.loads((SCHEMA_DIR / "embeddings.schema.json").read_text(encoding="utf-8"))
        example = json.loads((SCHEMA_DIR / "embeddings.example.json").read_text(encoding="utf-8"))
        invalid = copy.deepcopy(example)
        invalid["embedding_dimension"] = 0
        with self.assertRaises(Exception):
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(invalid)

    def test_failure_report_rejects_unknown_severity(self):
        schema = json.loads((SCHEMA_DIR / "failure-report.schema.json").read_text(encoding="utf-8"))
        example = json.loads((SCHEMA_DIR / "failure-report.example.json").read_text(encoding="utf-8"))
        invalid = copy.deepcopy(example)
        invalid["issues"][0]["severity"] = "fatal"
        with self.assertRaises(Exception):
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(invalid)

    def test_local_report_rejects_negative_error_count(self):
        schema = json.loads((SCHEMA_DIR / "local-report.schema.json").read_text(encoding="utf-8"))
        example = json.loads((SCHEMA_DIR / "local-report.example.json").read_text(encoding="utf-8"))
        invalid = copy.deepcopy(example)
        invalid["summary"]["error_count"] = -1
        with self.assertRaises(Exception):
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(invalid)


if __name__ == "__main__":
    unittest.main()
