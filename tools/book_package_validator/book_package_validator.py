from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import stat
import sys
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterator

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = ROOT / "schemas" / "book-package" / "1.0.0"
BLOCKED_EXTENSIONS = {
    ".exe", ".dll", ".so", ".dylib", ".bat", ".cmd", ".ps1",
    ".sh", ".py", ".js", ".jar", ".class", ".com", ".msi",
}


class PackageError(Exception):
    pass


def safe_package_path(value: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise PackageError("package path is empty or contains a null byte")
    if "\\" in value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise PackageError(f"absolute or platform-specific path is forbidden: {value}")
    parts = PurePosixPath(value).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise PackageError(f"non-normalized or traversal path is forbidden: {value}")
    normalized = posixpath.normpath(value)
    if normalized in {"", ".", ".."} or normalized.startswith("../"):
        raise PackageError(f"path traversal is forbidden: {value}")
    return normalized


class PackageView:
    def names(self) -> list[str]:
        raise NotImplementedError

    def exists(self, name: str) -> bool:
        raise NotImplementedError

    def size(self, name: str) -> int:
        raise NotImplementedError

    @contextmanager
    def open(self, name: str) -> Iterator[BinaryIO]:
        raise NotImplementedError

    def close(self) -> None:
        return None


class DirectoryPackage(PackageView):
    def __init__(self, root: Path, max_file_size: int, max_total_size: int, max_files: int):
        self.root = root.resolve()
        if not self.root.is_dir():
            raise PackageError("package path is not a directory")
        self._sizes: dict[str, int] = {}
        total = 0
        for path in self.root.rglob("*"):
            if path.is_symlink():
                raise PackageError(f"symlink is forbidden: {path.relative_to(self.root)}")
            if not path.is_file():
                continue
            relative = safe_package_path(path.relative_to(self.root).as_posix())
            key = relative.casefold()
            if key in self._sizes:
                raise PackageError(f"duplicate normalized path: {relative}")
            size = path.stat().st_size
            if size > max_file_size:
                raise PackageError(f"file exceeds size limit: {relative}")
            if path.suffix.lower() in BLOCKED_EXTENSIONS:
                raise PackageError(f"executable or script file type is forbidden: {relative}")
            self._sizes[key] = size
            total += size
            if len(self._sizes) > max_files:
                raise PackageError("package contains too many files")
            if total > max_total_size:
                raise PackageError("package exceeds total size limit")

    def names(self) -> list[str]:
        return [path.relative_to(self.root).as_posix() for path in self.root.rglob("*") if path.is_file()]

    def _path(self, name: str) -> Path:
        normalized = safe_package_path(name)
        target = (self.root / normalized).resolve()
        try:
            target.relative_to(self.root)
        except ValueError as exc:
            raise PackageError(f"path escapes package root: {name}") from exc
        return target

    def exists(self, name: str) -> bool:
        return self._path(name).is_file()

    def size(self, name: str) -> int:
        return self._path(name).stat().st_size

    @contextmanager
    def open(self, name: str) -> Iterator[BinaryIO]:
        with self._path(name).open("rb") as stream:
            yield stream


class ZipPackage(PackageView):
    def __init__(self, path: Path, max_file_size: int, max_total_size: int, max_ratio: float, max_files: int):
        self.archive = zipfile.ZipFile(path, "r")
        self._entries: dict[str, zipfile.ZipInfo] = {}
        total = 0
        file_count = 0
        try:
            for info in self.archive.infolist():
                if info.is_dir():
                    continue
                normalized = safe_package_path(info.filename)
                key = normalized.casefold()
                if key in self._entries:
                    raise PackageError(f"duplicate normalized ZIP path: {normalized}")
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise PackageError(f"ZIP symlink entry is forbidden: {normalized}")
                if info.flag_bits & 0x1:
                    raise PackageError(f"encrypted ZIP entry is forbidden: {normalized}")
                if PurePosixPath(normalized).suffix.lower() in BLOCKED_EXTENSIONS:
                    raise PackageError(f"executable or script file type is forbidden: {normalized}")
                if info.file_size > max_file_size:
                    raise PackageError(f"ZIP entry exceeds size limit: {normalized}")
                total += info.file_size
                file_count += 1
                if total > max_total_size:
                    raise PackageError("ZIP exceeds total uncompressed size limit")
                if file_count > max_files:
                    raise PackageError("ZIP contains too many files")
                if info.file_size > 0:
                    if info.compress_size == 0:
                        raise PackageError(f"suspicious zero-size compressed entry: {normalized}")
                    ratio = info.file_size / info.compress_size
                    if ratio > max_ratio:
                        raise PackageError(f"ZIP compression ratio exceeds limit: {normalized}")
                self._entries[key] = info
        except Exception:
            self.archive.close()
            raise

    def names(self) -> list[str]:
        return [info.filename for info in self._entries.values()]

    def _info(self, name: str) -> zipfile.ZipInfo:
        normalized = safe_package_path(name)
        info = self._entries.get(normalized.casefold())
        if info is None:
            raise PackageError(f"required package file is missing: {normalized}")
        return info

    def exists(self, name: str) -> bool:
        try:
            self._info(name)
            return True
        except PackageError:
            return False

    def size(self, name: str) -> int:
        return self._info(name).file_size

    @contextmanager
    def open(self, name: str) -> Iterator[BinaryIO]:
        with self.archive.open(self._info(name), "r") as stream:
            yield stream

    def close(self) -> None:
        self.archive.close()


def read_bytes(package: PackageView, name: str, max_bytes: int = 20 * 1024 * 1024) -> bytes:
    if package.size(name) > max_bytes:
        raise PackageError(f"structured artifact exceeds read limit: {name}")
    with package.open(name) as stream:
        data = stream.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise PackageError(f"structured artifact exceeds read limit: {name}")
    return data


def sha256_of(package: PackageView, name: str) -> str:
    digest = hashlib.sha256()
    with package.open(name) as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def load_schema(name: str) -> dict:
    path = SCHEMA_DIR / name
    schema = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return schema


def validate_instance(instance: object, schema_name: str, artifact: str, issues: list[dict]) -> list[str]:
    validator = Draft202012Validator(load_schema(schema_name), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(instance), key=lambda item: list(item.absolute_path))
    messages = []
    for error in errors:
        location = ".".join(str(part) for part in error.absolute_path) or "$"
        message = f"{artifact}:{location}: {error.message}"
        messages.append(message)
        issues.append({
            "issue_code": "SCHEMA_VALIDATION_FAILED",
            "severity": "error",
            "stage": "package_inspection",
            "artifact": artifact,
            "record_id": None,
            "chapter_id": None,
            "page_number": None,
            "message": message,
            "evidence": {"schema": schema_name, "path": location},
            "suggested_action": "修正字段结构或类型后重新校验"
        })
    return messages


def parse_json(package: PackageView, name: str, issues: list[dict]) -> object | None:
    try:
        return json.loads(read_bytes(package, name).decode("utf-8"))
    except Exception as exc:
        issues.append({
            "issue_code": "INVALID_JSON",
            "severity": "error",
            "stage": "package_inspection",
            "artifact": name,
            "record_id": None,
            "chapter_id": None,
            "page_number": None,
            "message": f"{name}: invalid UTF-8 JSON: {exc}",
            "evidence": {},
            "suggested_action": "修复 JSON 编码或语法后重新校验"
        })
        return None


def add_issue(issues: list[dict], code: str, stage: str, message: str, artifact: str | None = None, evidence: dict | None = None, severity: str = "error", suggested_action: str | None = None, record_id: str | None = None, chapter_id: str | None = None, page_number: int | None = None) -> None:
    issues.append({
        "issue_code": code,
        "severity": severity,
        "stage": stage,
        "artifact": artifact,
        "record_id": record_id,
        "chapter_id": chapter_id,
        "page_number": page_number,
        "message": message,
        "evidence": evidence or {},
        "suggested_action": suggested_action
    })


def validate_package(package: PackageView) -> dict:
    issues: list[dict] = []
    if not package.exists("manifest.json"):
        add_issue(issues, "MANIFEST_MISSING", "package_inspection", "manifest.json is required", "manifest.json")
        return build_report(issues)

    manifest = parse_json(package, "manifest.json", issues)
    if not isinstance(manifest, dict):
        return build_report(issues)
    validate_instance(manifest, "manifest.schema.json", "manifest.json", issues)

    source = manifest.get("source") if isinstance(manifest.get("source"), dict) else {}
    source_path = source.get("file")
    if isinstance(source_path, str):
        try:
            source_path = safe_package_path(source_path)
            if not package.exists(source_path):
                add_issue(issues, "SOURCE_FILE_MISSING", "source_verification", "manifest source file does not exist", source_path)
            else:
                actual_size = package.size(source_path)
                actual_hash = sha256_of(package, source_path)
                if actual_size != source.get("size_bytes"):
                    add_issue(issues, "SOURCE_SIZE_MISMATCH", "source_verification", "source size does not match manifest", source_path, {"declared": source.get("size_bytes"), "actual": actual_size})
                if actual_hash.lower() != str(source.get("sha256", "")).lower():
                    add_issue(issues, "SOURCE_HASH_MISMATCH", "source_verification", "source SHA-256 does not match manifest", source_path, {"declared": source.get("sha256"), "actual": actual_hash})
        except PackageError as exc:
            add_issue(issues, "SOURCE_PATH_INVALID", "package_inspection", str(exc), str(source_path))

    artifacts = manifest.get("artifacts") if isinstance(manifest.get("artifacts"), dict) else {}
    parsed: dict[str, object] = {}
    schema_by_key = {"book": "book.schema.json", "chapters": "chapters.schema.json", "embeddings": "embeddings.schema.json", "local_report": "local-report.schema.json"}
    for key in ("book", "chapters", "chunks"):
        artifact_path = artifacts.get(key)
        if not isinstance(artifact_path, str):
            continue
        try:
            artifact_path = safe_package_path(artifact_path)
        except PackageError as exc:
            add_issue(issues, "ARTIFACT_PATH_INVALID", "package_inspection", str(exc), str(artifact_path))
            continue
        if not package.exists(artifact_path):
            add_issue(issues, "ARTIFACT_MISSING", "package_inspection", f"required artifact is missing: {key}", artifact_path)
            continue
        if key == "chunks":
            chunks = []
            try:
                with package.open(artifact_path) as stream:
                    for line_number, raw_line in enumerate(stream, start=1):
                        if not raw_line.strip():
                            continue
                        try:
                            instance = json.loads(raw_line.decode("utf-8"))
                        except Exception as exc:
                            add_issue(issues, "INVALID_JSONL", "package_inspection", f"invalid JSONL at line {line_number}: {exc}", artifact_path, {"line": line_number})
                            continue
                        validate_instance(instance, "chunk.schema.json", artifact_path, issues)
                        chunks.append(instance)
                parsed["chunks"] = chunks
            except Exception as exc:
                add_issue(issues, "CHUNK_READ_FAILED", "package_inspection", str(exc), artifact_path)
        else:
            instance = parse_json(package, artifact_path, issues)
            parsed[key] = instance
            if instance is not None:
                validate_instance(instance, schema_by_key[key], artifact_path, issues)

    embedding_path = artifacts.get("embeddings")
    if isinstance(embedding_path, str):
        try:
            embedding_path = safe_package_path(embedding_path)
            if not package.exists(embedding_path):
                add_issue(issues, "EMBEDDING_MANIFEST_MISSING", "package_inspection", "embedding metadata file is missing", embedding_path)
            else:
                embedding_manifest = parse_json(package, embedding_path, issues)
                if embedding_manifest is not None:
                    validate_instance(embedding_manifest, "embeddings.schema.json", embedding_path, issues)
                    vector_file = embedding_manifest.get("file") if isinstance(embedding_manifest, dict) else None
                    if isinstance(vector_file, str):
                        vector_file = safe_package_path(vector_file)
                        if not package.exists(vector_file):
                            add_issue(issues, "EMBEDDING_FILE_MISSING", "source_verification", "embedding vector file is missing", vector_file)
                        else:
                            actual_hash = sha256_of(package, vector_file)
                            if actual_hash.lower() != str(embedding_manifest.get("sha256", "")).lower():
                                add_issue(issues, "EMBEDDING_HASH_MISMATCH", "source_verification", "embedding vector file hash does not match metadata", vector_file)
        except PackageError as exc:
            add_issue(issues, "EMBEDDING_PATH_INVALID", "package_inspection", str(exc), str(embedding_path))

    local_report_path = artifacts.get("local_report")
    if isinstance(local_report_path, str):
        try:
            local_report_path = safe_package_path(local_report_path)
            if not package.exists(local_report_path):
                add_issue(issues, "LOCAL_REPORT_MISSING", "package_inspection", "declared local report file is missing", local_report_path, severity="warning")
            else:
                local_report = parse_json(package, local_report_path, issues)
                if local_report is not None:
                    validate_instance(local_report, "local-report.schema.json", local_report_path, issues)
        except PackageError as exc:
            add_issue(issues, "LOCAL_REPORT_PATH_INVALID", "package_inspection", str(exc), str(local_report_path))

    book = parsed.get("book")
    if isinstance(book, dict) and isinstance(manifest.get("book"), dict):
        for field in ("title", "authors", "language"):
            if book.get(field) != manifest["book"].get(field):
                add_issue(issues, "BOOK_METADATA_MISMATCH", "metadata_normalization", f"manifest and book.json differ on {field}", artifacts.get("book"), {"manifest": manifest["book"].get(field), "book": book.get(field)})

    chapters = parsed.get("chapters")
    chunks = parsed.get("chunks")
    chapter_ids: set[str] = set()
    if isinstance(chapters, list):
        for chapter in chapters:
            if isinstance(chapter, dict) and isinstance(chapter.get("chapter_id"), str):
                if chapter["chapter_id"] in chapter_ids:
                    add_issue(issues, "DUPLICATE_CHAPTER_ID", "structure", "chapter_id must be unique", artifacts.get("chapters"), {"chapter_id": chapter["chapter_id"]})
                chapter_ids.add(chapter["chapter_id"])
        for chapter in chapters:
            if isinstance(chapter, dict):
                parent = chapter.get("parent_chapter_id")
                if parent is not None and parent not in chapter_ids:
                    add_issue(issues, "CHAPTER_PARENT_MISSING", "structure", "parent_chapter_id does not exist", artifacts.get("chapters"), {"parent_chapter_id": parent}, record_id=chapter.get("chapter_id"))
    if isinstance(chunks, list):
        chunk_ids: set[str] = set()
        for chunk in chunks:
            if not isinstance(chunk, dict):
                continue
            chunk_id = chunk.get("chunk_id")
            if isinstance(chunk_id, str) and chunk_id in chunk_ids:
                add_issue(issues, "DUPLICATE_CHUNK_ID", "chunk", "chunk_id must be unique", artifacts.get("chunks"), {"chunk_id": chunk_id}, record_id=chunk_id)
            if isinstance(chunk_id, str):
                chunk_ids.add(chunk_id)
            chapter_id = chunk.get("chapter_id")
            if chapter_ids and chapter_id not in chapter_ids:
                add_issue(issues, "CHUNK_CHAPTER_MISSING", "chunk", "chunk references an unknown chapter", artifacts.get("chunks"), {"chapter_id": chapter_id}, record_id=chunk_id, chapter_id=chapter_id)
            content = chunk.get("content")
            declared_hash = chunk.get("content_sha256")
            if isinstance(content, str) and isinstance(declared_hash, str):
                actual_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
                if actual_hash.lower() != declared_hash.lower():
                    add_issue(issues, "CHUNK_HASH_MISMATCH", "chunk", "chunk content hash does not match", artifacts.get("chunks"), {"declared": declared_hash, "actual": actual_hash}, record_id=chunk_id, chapter_id=chapter_id)

    counts = manifest.get("counts") if isinstance(manifest.get("counts"), dict) else {}
    actual_chapters = len(chapters) if isinstance(chapters, list) else None
    actual_chunks = len(chunks) if isinstance(chunks, list) else None
    actual_assets = sum(1 for name in package.names() if name.startswith("assets/") and not name.endswith("/"))
    for key, actual in (("chapters", actual_chapters), ("chunks", actual_chunks), ("assets", actual_assets)):
        declared = counts.get(key)
        if actual is not None and declared != actual:
            add_issue(issues, "PACKAGE_COUNT_MISMATCH", "package_inspection", f"manifest count for {key} does not match package", "manifest.json", {"declared": declared, "actual": actual})

    return build_report(issues)


def build_report(issues: list[dict]) -> dict:
    errors = sum(issue["severity"] == "error" for issue in issues)
    warnings = sum(issue["severity"] == "warning" for issue in issues)
    status = "failed" if errors else ("needs_rework" if warnings else "passed")
    return {
        "report_version": "1.0.0",
        "overall_status": status,
        "summary": {"error_count": errors, "warning_count": warnings},
        "issues": issues,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    }


def open_package(path: Path, args: argparse.Namespace) -> PackageView:
    if path.is_dir():
        return DirectoryPackage(path, args.max_file_size, args.max_total_size, args.max_files)
    if path.is_file() and zipfile.is_zipfile(path):
        return ZipPackage(path, args.max_file_size, args.max_total_size, args.max_ratio, args.max_files)
    raise PackageError("input must be a package directory or ZIP archive")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate a read-book-package 1.0.0 directory or ZIP archive.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("package", type=Path)
    validate_parser.add_argument("--report", type=Path)
    validate_parser.add_argument("--max-file-size", type=int, default=512 * 1024 * 1024)
    validate_parser.add_argument("--max-total-size", type=int, default=2 * 1024 * 1024 * 1024)
    validate_parser.add_argument("--max-ratio", type=float, default=200.0)
    validate_parser.add_argument("--max-files", type=int, default=20000)
    args = parser.parse_args(argv)

    try:
        package = open_package(args.package, args)
        try:
            report = validate_package(package)
        finally:
            package.close()
    except Exception as exc:
        report = build_report([{
            "issue_code": "PACKAGE_VALIDATION_ABORTED",
            "severity": "error",
            "stage": "package_inspection",
            "artifact": None,
            "record_id": None,
            "chapter_id": None,
            "page_number": None,
            "message": str(exc),
            "evidence": {},
            "suggested_action": "检查包路径、ZIP 安全结构和资源限制"
        }])

    output = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output + "\n", encoding="utf-8")
    print(output)
    return 0 if report["overall_status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
