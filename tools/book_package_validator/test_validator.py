import hashlib
import json
import stat
import tempfile
import unittest
import warnings
import zipfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from book_package_validator import (
    DirectoryPackage,
    PackageError,
    ZipPackage,
    main,
    validate_package,
)


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def create_valid_package(root: Path) -> Path:
    source = b"public domain sample source"
    source_path = root / "source" / "original.txt"
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(source)

    book = {
        "title": "Test Book",
        "authors": ["Test Author"],
        "language": "en",
        "description": None,
        "identifiers": None
    }
    chapters = [{
        "chapter_id": "chapter-001",
        "parent_chapter_id": None,
        "title": "Chapter One",
        "level": 1,
        "order_index": 0,
        "start_locator": {"char_offset": 0},
        "end_locator": {"char_offset": 27},
        "page_start": None,
        "page_end": None,
        "source_heading": "Chapter One"
    }]
    chunk_text = "A short sample passage."
    chunk = {
        "chunk_id": "chunk-001",
        "chapter_id": "chapter-001",
        "chapter_title": "Chapter One",
        "order_index": 0,
        "content": chunk_text,
        "content_sha256": hashlib.sha256(chunk_text.encode("utf-8")).hexdigest(),
        "locator_type": "txt_char_offset",
        "start_locator": {"char_offset": 0},
        "end_locator": {"char_offset": len(chunk_text)},
        "page_number": None,
        "paragraph_start": 0,
        "paragraph_end": 0,
        "parser_version": "1.0",
        "chunker_version": "1.0"
    }
    write_json(root / "content" / "book.json", book)
    write_json(root / "content" / "chapters.json", chapters)
    chunks_path = root / "content" / "chunks.jsonl"
    chunks_path.parent.mkdir(parents=True, exist_ok=True)
    chunks_path.write_text(json.dumps(chunk, ensure_ascii=False) + "\n", encoding="utf-8")

    manifest = {
        "schema_name": "read-book-package",
        "schema_version": "1.0.0",
        "package_id": "550e8400-e29b-41d4-a716-446655440000",
        "created_at": "2026-11-13T00:00:00Z",
        "source": {
            "file": "source/original.txt",
            "format": "txt",
            "sha256": hashlib.sha256(source).hexdigest(),
            "size_bytes": len(source)
        },
        "book": {"title": "Test Book", "authors": ["Test Author"], "language": "en"},
        "processing": {
            "processor_name": "test-processor",
            "processor_version": "1.0",
            "rules_version": "1.0",
            "parser": "text-parser",
            "parser_version": "1.0"
        },
        "artifacts": {
            "book": "content/book.json",
            "chapters": "content/chapters.json",
            "chunks": "content/chunks.jsonl",
            "embeddings": None,
            "local_report": None
        },
        "counts": {"chapters": 1, "chunks": 1, "assets": 0}
    }
    write_json(root / "manifest.json", manifest)
    return root


class PackageValidatorTests(unittest.TestCase):
    def test_valid_directory_package_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = create_valid_package(Path(tmp) / "package")
            package = DirectoryPackage(root, 1024 * 1024, 2 * 1024 * 1024, 100)
            try:
                report = validate_package(package)
            finally:
                package.close()
            self.assertEqual(report["overall_status"], "passed", report["issues"])

    def test_cli_returns_zero_for_valid_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = create_valid_package(Path(tmp) / "package")
            output = StringIO()
            with redirect_stdout(output):
                result = main(["validate", str(root)])
            self.assertEqual(result, 0)
            self.assertIn('"overall_status": "passed"', output.getvalue())

    def test_source_hash_mismatch_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = create_valid_package(Path(tmp) / "package")
            manifest_path = root / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["source"]["sha256"] = "0" * 64
            write_json(manifest_path, manifest)
            report = validate_package(DirectoryPackage(root, 1024 * 1024, 2 * 1024 * 1024, 100))
            codes = {issue["issue_code"] for issue in report["issues"]}
            self.assertIn("SOURCE_HASH_MISMATCH", codes)

    def test_chunk_hash_mismatch_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = create_valid_package(Path(tmp) / "package")
            chunks_path = root / "content" / "chunks.jsonl"
            chunk = json.loads(chunks_path.read_text(encoding="utf-8"))
            chunk["content_sha256"] = "0" * 64
            chunks_path.write_text(json.dumps(chunk) + "\n", encoding="utf-8")
            report = validate_package(DirectoryPackage(root, 1024 * 1024, 2 * 1024 * 1024, 100))
            codes = {issue["issue_code"] for issue in report["issues"]}
            self.assertIn("CHUNK_HASH_MISMATCH", codes)

    def test_manifest_count_mismatch_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = create_valid_package(Path(tmp) / "package")
            manifest_path = root / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["counts"]["chunks"] = 99
            write_json(manifest_path, manifest)
            report = validate_package(DirectoryPackage(root, 1024 * 1024, 2 * 1024 * 1024, 100))
            codes = {issue["issue_code"] for issue in report["issues"]}
            self.assertIn("PACKAGE_COUNT_MISMATCH", codes)

    def test_missing_manifest_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "package"
            root.mkdir()
            report = validate_package(DirectoryPackage(root, 1024 * 1024, 2 * 1024 * 1024, 100))
            self.assertIn("MANIFEST_MISSING", {x["issue_code"] for x in report["issues"]})

    def test_valid_zip_package_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = create_valid_package(Path(tmp) / "package")
            archive_path = Path(tmp) / "package.zip"
            with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
                for file in root.rglob("*"):
                    if file.is_file():
                        archive.write(file, file.relative_to(root).as_posix())
            package = ZipPackage(archive_path, 1024 * 1024, 2 * 1024 * 1024, 200, 100)
            try:
                report = validate_package(package)
            finally:
                package.close()
            self.assertEqual(report["overall_status"], "passed", report["issues"])

    def test_zip_path_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "bad.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("../outside.txt", "bad")
            with self.assertRaises(PackageError):
                ZipPackage(archive_path, 1024, 2048, 200, 100)

    def test_zip_traversal_directory_entry_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "bad-dir.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("../", "")
            with self.assertRaises(PackageError):
                ZipPackage(archive_path, 1024, 2048, 200, 100)

    def test_zip_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "symlink.zip"
            info = zipfile.ZipInfo("source/link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(info, "../../outside")
            with self.assertRaises(PackageError):
                ZipPackage(archive_path, 1024, 2048, 200, 100)

    def test_duplicate_zip_names_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "duplicate.zip"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                with zipfile.ZipFile(archive_path, "w") as archive:
                    archive.writestr("content/book.json", "{}")
                    archive.writestr("content/book.json", "{}")
            with self.assertRaises(PackageError):
                ZipPackage(archive_path, 1024, 2048, 200, 100)

    def test_case_insensitive_duplicate_zip_names_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "duplicate-case.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("content/Book.json", "{}")
                archive.writestr("content/book.json", "{}")
            with self.assertRaises(PackageError):
                ZipPackage(archive_path, 1024, 2048, 200, 100)

    def test_oversized_zip_entry_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "oversized.zip"
            with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_STORED) as archive:
                archive.writestr("large.txt", b"x" * 100)
            with self.assertRaises(PackageError):
                ZipPackage(archive_path, 10, 1000, 200, 100)

    def test_compression_bomb_ratio_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "bomb.zip"
            with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("bomb.txt", b"A" * 10000)
            with self.assertRaises(PackageError):
                ZipPackage(archive_path, 20000, 30000, 2, 100)

    def test_executable_file_type_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "script.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("assets/run.sh", "echo unsafe")
            with self.assertRaises(PackageError):
                ZipPackage(archive_path, 1024, 2048, 200, 100)

    def test_too_many_files_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "many.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("a.txt", "a")
                archive.writestr("b.txt", "b")
            with self.assertRaises(PackageError):
                ZipPackage(archive_path, 1024, 2048, 200, 1)


if __name__ == "__main__":
    unittest.main()
