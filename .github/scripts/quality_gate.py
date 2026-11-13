from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

import yaml
from jsonschema.validators import validator_for
from openapi_spec_validator import validate as validate_openapi

ROOT = Path(__file__).resolve().parents[2]
EXCLUDED_PARTS = {".git", ".venv", "node_modules", "artifacts", "__pycache__"}
LINK_RE = re.compile(r"!?(?:\[[^\]]*\])\(([^)]+)\)")
HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")


def github_slug(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"\s+", "-", value)
    value = re.sub(r"[^\w\-]", "", value, flags=re.UNICODE)
    return re.sub(r"-{2,}", "-", value).strip("-")


def heading_anchors(markdown: str) -> set[str]:
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    for line in markdown.splitlines():
        match = HEADING_RE.match(line)
        if not match:
            continue
        heading = match.group(1)
        explicit = re.search(r"\{#([^}]+)\}\s*$", heading)
        slug = explicit.group(1) if explicit else github_slug(heading)
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        anchors.add(slug if count == 0 else f"{slug}-{count}")
    return anchors


def resolve_local_link(source: Path, destination: str) -> tuple[Path, str]:
    destination = destination.strip()
    if destination.startswith("<") and ">" in destination:
        destination = destination[1:destination.index(">")]
    else:
        destination = destination.split()[0] if destination.split() else ""
    parsed = urlsplit(destination)
    target_path = unquote(parsed.path)
    target = (source.parent / target_path).resolve() if target_path else source.resolve()
    return target, unquote(parsed.fragment)


def validate_schema(schema: dict):
    validator_class = validator_for(schema)
    validator_class.check_schema(schema)
    return validator_class


def markdown_link_check() -> tuple[int, int]:
    checked = 0
    errors: list[str] = []
    markdown_files = [
        path for path in ROOT.rglob("*.md")
        if not any(part in EXCLUDED_PARTS for part in path.parts)
    ]
    for source in markdown_files:
        text = source.read_text(encoding="utf-8")
        for match in LINK_RE.finditer(text):
            destination = match.group(1).strip()
            parsed_destination = destination.lstrip("<").split(">")[0].split()
            parsed = urlsplit(parsed_destination[0] if parsed_destination else "")
            if parsed.scheme in {"http", "https", "mailto", "tel", "data"} or destination.startswith("//"):
                continue
            checked += 1
            target, fragment = resolve_local_link(source, destination)
            try:
                target.relative_to(ROOT)
            except ValueError:
                errors.append(f"{source.relative_to(ROOT)}: link escapes repository: {destination}")
                continue
            if not target.exists():
                errors.append(f"{source.relative_to(ROOT)}: missing target: {destination}")
                continue
            if fragment and target.suffix.lower() in {".md", ".markdown"}:
                anchors = heading_anchors(target.read_text(encoding="utf-8"))
                if fragment not in anchors:
                    errors.append(f"{source.relative_to(ROOT)}: missing anchor #{fragment} in {target.relative_to(ROOT)}")
    for error in errors:
        print(f"ERROR markdown-link: {error}")
    print(f"Markdown links: checked={checked}, errors={len(errors)}, files={len(markdown_files)}")
    return checked, len(errors)


def json_and_schema_check() -> tuple[int, int, int]:
    json_count = 0
    jsonl_count = 0
    errors: list[str] = []
    schemas = [
        path for path in ROOT.rglob("*.schema.json")
        if not any(part in EXCLUDED_PARTS for part in path.parts)
    ]
    examples = [
        path for path in ROOT.rglob("*.example.json")
        if not any(part in EXCLUDED_PARTS for part in path.parts)
    ]

    for path in ROOT.rglob("*.json"):
        if any(part in EXCLUDED_PARTS for part in path.parts):
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
            json_count += 1
        except Exception as exc:
            errors.append(f"{path.relative_to(ROOT)}: invalid JSON: {exc}")

    for path in ROOT.rglob("*.jsonl"):
        if any(part in EXCLUDED_PARTS for part in path.parts):
            continue
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                json.loads(line)
                jsonl_count += 1
            except Exception as exc:
                errors.append(f"{path.relative_to(ROOT)}:{line_number}: invalid JSONL: {exc}")

    schema_by_example = {path.name.removesuffix(".schema.json"): path for path in schemas}
    for example in examples:
        key = example.name.removesuffix(".example.json")
        schema_path = schema_by_example.get(key + ".schema.json")
        if schema_path is None:
            errors.append(f"{example.relative_to(ROOT)}: no matching {key}.schema.json found")
            continue
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            instance = json.loads(example.read_text(encoding="utf-8"))
            validate_schema(schema)(schema).validate(instance)
        except Exception as exc:
            errors.append(f"{example.relative_to(ROOT)}: schema validation failed: {exc}")

    for schema_path in schemas:
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            validate_schema(schema)
        except Exception as exc:
            errors.append(f"{schema_path.relative_to(ROOT)}: invalid JSON Schema: {exc}")

    for error in errors:
        print(f"ERROR json-schema: {error}")
    if not schemas:
        print("JSON Schema: NOT APPLICABLE — no *.schema.json files exist; this is not a schema-coverage pass.")
    else:
        print(f"JSON Schema: schemas={len(schemas)}, examples={len(examples)}")
    print(f"JSON/JSONL: json_files={json_count}, jsonl_records={jsonl_count}, errors={len(errors)}")
    return json_count, jsonl_count, len(errors)


def openapi_check() -> int:
    path = ROOT / "docs" / "api-contract.yaml"
    try:
        spec = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(spec, dict) or not str(spec.get("openapi", "")).startswith("3.1."):
            raise ValueError("OpenAPI document must declare version 3.1.x")
        validate_openapi(spec)
        operation_ids: list[str] = []
        for path_item in (spec.get("paths") or {}).values():
            if not isinstance(path_item, dict):
                continue
            for method, operation in path_item.items():
                if method.lower() not in {"get", "put", "post", "delete", "options", "head", "patch", "trace"}:
                    continue
                if isinstance(operation, dict) and operation.get("operationId"):
                    operation_ids.append(operation["operationId"])
        duplicates = sorted({item for item in operation_ids if operation_ids.count(item) > 1})
        if duplicates:
            raise ValueError(f"duplicate operationId: {', '.join(duplicates)}")
        print(f"OpenAPI: valid 3.1 document; operations={len(operation_ids)}; operationId unique")
        return 0
    except Exception as exc:
        print(f"ERROR openapi: {exc}")
        return 1


def main() -> int:
    report_dir = ROOT / "artifacts"
    report_dir.mkdir(exist_ok=True)
    results = []

    checked, errors = markdown_link_check()
    results.append({"check": "markdown-links", "status": "passed" if errors == 0 else "failed", "checked": checked, "errors": errors})

    json_count, jsonl_count, json_errors = json_and_schema_check()
    results.append({"check": "json-jsonl-schema", "status": "passed" if json_errors == 0 else "failed", "json_files": json_count, "jsonl_records": jsonl_count, "errors": json_errors})

    openapi_errors = openapi_check()
    results.append({"check": "openapi-3.1", "status": "passed" if openapi_errors == 0 else "failed", "errors": openapi_errors})

    (report_dir / "quality-gate-report.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# Repository quality gate report", "", "| Check | Status | Details |", "|---|---|---|"]
    for item in results:
        detail = ", ".join(f"{key}={value}" for key, value in item.items() if key not in {"check", "status"})
        lines.append(f"| {item['check']} | {item['status']} | {detail} |")
    (report_dir / "quality-gate-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    failed = sum(item["status"] == "failed" for item in results)
    print(f"Quality gate summary: failed_checks={failed}/{len(results)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
