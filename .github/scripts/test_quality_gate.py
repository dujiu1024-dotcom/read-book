import unittest

from quality_gate import github_slug, heading_anchors, validate_schema


class QualityGateTests(unittest.TestCase):
    def test_github_slug_keeps_unicode_and_normalizes_punctuation(self):
        self.assertEqual(github_slug("状态机：主线 / 轮次"), "状态机主线-轮次")

    def test_heading_anchors_handle_duplicate_headings(self):
        anchors = heading_anchors("# Overview\n## Overview\n## 第二章：原文")
        self.assertIn("overview", anchors)
        self.assertIn("overview-1", anchors)
        self.assertIn("第二章原文", anchors)

    def test_valid_schema_accepts_matching_instance(self):
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "required": ["id"],
            "properties": {"id": {"type": "string"}},
            "additionalProperties": False,
        }
        validator = validate_schema(schema)(schema)
        validator.validate({"id": "book-1"})

    def test_valid_schema_rejects_invalid_instance(self):
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "required": ["id"],
            "properties": {"id": {"type": "string"}},
        }
        validator = validate_schema(schema)(schema)
        with self.assertRaises(Exception):
            validator.validate({"id": 123})

    def test_invalid_schema_is_rejected(self):
        with self.assertRaises(Exception):
            validate_schema({"type": "not-a-json-schema-type"})


if __name__ == "__main__":
    unittest.main()
