from pathlib import Path
import re

import yaml
from openapi_spec_validator import validate

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def markdown_section(text: str, heading_prefix: str) -> str:
    """Return the body between a heading and the next heading of the same or higher level."""
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip().startswith(heading_prefix):
            start = index + 1
            break
    if start is None:
        raise AssertionError(f"missing heading: {heading_prefix}")
    end = len(lines)
    for index in range(start, len(lines)):
        if lines[index].startswith("### ") or lines[index].startswith("## "):
            end = index
            break
    return "\n".join(lines[start:end])


def dictionary_enum(dictionary: str, section: str, field: str) -> set[str]:
    body = markdown_section(dictionary, section)
    match = re.search(rf"{re.escape(field)}\s+TEXT\s+NOT\s+NULL（([^）]*)）", body)
    if not match:
        raise AssertionError(f"data-dictionary section {section} has no enum for {field}")
    return {value.strip() for value in match.group(1).split("/") if value.strip()}


def state_table_values(state_machines: str, section: str) -> set[str]:
    body = markdown_section(state_machines, section)
    values: set[str] = set()
    for line in body.splitlines():
        if not line.strip().startswith("|"):
            if values:
                break
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        if cells[0] in {"状态", ""} or set(cells[0]) <= set("-: "):
            continue
        match = re.fullmatch(r"`?([a-z_]+)`?(?:（.*）)?", cells[0])
        if match:
            values.add(match.group(1))
    if not values:
        raise AssertionError(f"state-machines section {section} has no state table")
    return values


def sqlite_table_body(sql: str, table: str) -> str:
    matches = list(
        re.finditer(
            rf"CREATE TABLE\s+(?:IF NOT EXISTS\s+)?{re.escape(table)}\s*\(", sql
        )
    )
    if not matches:
        raise AssertionError(f"sqlite.worker.js has no table {table}")
    # A migrated table may be created more than once; the final definition is authoritative.
    match = matches[-1]
    start = match.end()
    depth = 1
    index = start
    while index < len(sql) and depth:
        if sql[index] == "(":
            depth += 1
        elif sql[index] == ")":
            depth -= 1
        index += 1
    return sql[start : index - 1]


def sqlite_check_enum(body: str, column: str) -> set[str]:
    match = re.search(
        rf"CHECK\s*\(\s*{re.escape(column)}\s+IN\s*\(([^)]*)\)",
        body,
        re.IGNORECASE,
    )
    if not match:
        raise AssertionError(f"sqlite table has no CHECK enum for {column}")
    return {
        value.strip().strip("'\"")
        for value in match.group(1).split(",")
        if value.strip()
    }


def typescript_union(source: str, name: str) -> set[str]:
    match = re.search(rf"export type {name}\s*=([^;]+);", source)
    if not match:
        raise AssertionError(f"domain-core has no union {name}")
    return set(re.findall(r'"([a-z_]+)"', match.group(1)))


def assert_same(label: str, expected: set[str], actual: set[str]) -> None:
    if expected != actual:
        raise AssertionError(
            f"{label} mismatch: expected {sorted(expected)}, got {sorted(actual)}"
        )


def main() -> None:
    api_path = DOCS / "api-contract.yaml"
    spec = yaml.safe_load(read(api_path))
    validate(spec)

    paths = spec["paths"]
    schemas = spec["components"]["schemas"]
    generation_states = schemas["GenerationStatus"]["properties"]["status"]["enum"]
    assert "cancel_requested" in generation_states, "GenerationStatus must expose cancel_requested"

    backup_session = schemas["BackupUploadSession"]
    assert "status" in backup_session["required"], "BackupUploadSession.status must be required"
    backup_states = backup_session["properties"]["status"]["enum"]
    assert set(backup_states) == {"open", "completing", "completed", "expired", "rejected"}
    assert "/v1/backups/{backup_id}/session" in paths
    assert "get" in paths["/v1/backups/{backup_id}/session"]
    assert {"deviceId", "lineageId", "forkId", "backupSequence"} <= set(
        schemas["BackupClientManifest"]["required"]
    )
    assert {"device_id", "lineage_id", "fork_id"} <= set(
        schemas["BackupInitRequest"]["required"]
    )
    assert {"device_id", "lineage_id", "fork_id"} <= set(schemas["BackupRecord"]["required"])
    assert "### 4.6 RecoveryChallenge" in read(DOCS / "data-dictionary.md")

    state_machines = read(DOCS / "state-machines.md")
    dictionary = read(DOCS / "data-dictionary.md")
    audit = read(DOCS / "state-machine-contract-audit.md")
    sqlite_worker = read(ROOT / "packages" / "local-repository-sqlite" / "src" / "sqlite.worker.js")
    domain_core = read(ROOT / "packages" / "domain-core" / "src" / "index.ts")

    assert_same(
        "BackupJournal.operation (dictionary vs sqlite)",
        dictionary_enum(dictionary, "### 3.16 BackupJournal", "operation"),
        sqlite_check_enum(sqlite_table_body(sqlite_worker, "backup_journal"), "operation"),
    )
    assert "backupJournal" in sqlite_worker

    message_body = sqlite_table_body(sqlite_worker, "message")
    message_status_dictionary = dictionary_enum(dictionary, "### 3.5 Message", "status")
    assert_same(
        "Message.status (dictionary vs sqlite)",
        message_status_dictionary,
        sqlite_check_enum(message_body, "status"),
    )
    assert_same(
        "Message.status (state-machines vs dictionary)",
        message_status_dictionary,
        state_table_values(state_machines, "### 6.1 Message"),
    )
    assert_same(
        "Message.role (dictionary vs sqlite)",
        dictionary_enum(dictionary, "### 3.5 Message", "role"),
        sqlite_check_enum(message_body, "role"),
    )

    assistant_statuses = typescript_union(domain_core, "AssistantMessageStatus")
    assert assistant_statuses == {"generating", "completed", "failed", "cancelled"}
    assert assistant_statuses <= message_status_dictionary
    assert "saved" not in assistant_statuses

    memory_version_dictionary = dictionary_enum(
        dictionary, "### 3.13 MemoryVersion", "change_kind"
    )
    assert_same(
        "MemoryVersion.change_kind (dictionary vs sqlite)",
        memory_version_dictionary,
        sqlite_check_enum(
            sqlite_table_body(sqlite_worker, "memory_version"), "change_kind"
        ),
    )
    assert_same(
        "MemoryVersion.change_kind (domain-core vs dictionary)",
        memory_version_dictionary,
        typescript_union(domain_core, "MemoryChangeKind"),
    )

    memory_relation_dictionary = dictionary_enum(
        dictionary, "### 3.14 MemoryRelation", "relation_type"
    )
    assert_same(
        "MemoryRelation.relation_type (dictionary vs sqlite)",
        memory_relation_dictionary,
        sqlite_check_enum(
            sqlite_table_body(sqlite_worker, "memory_relation"), "relation_type"
        ),
    )
    assert_same(
        "MemoryRelation.relation_type (domain-core vs dictionary)",
        memory_relation_dictionary,
        typescript_union(domain_core, "MemoryRelationType"),
    )

    memory_version_section = markdown_section(dictionary, "### 3.13 MemoryVersion")
    for field in ("memory_id", "version", "previous_version_id", "viewpoint"):
        assert field in memory_version_section, f"MemoryVersion missing field {field}"
    memory_relation_section = markdown_section(dictionary, "### 3.14 MemoryRelation")
    for field in ("from_version_id", "to_version_id", "source_message_ids"):
        assert field in memory_relation_section, f"MemoryRelation missing field {field}"
    assert "from_memory_id" not in memory_relation_section
    assert "current_version_id" in sqlite_table_body(sqlite_worker, "memory")
    assert "previous_version_id" in sqlite_table_body(sqlite_worker, "memory_version")

    book_revision_section = markdown_section(dictionary, "### 2.2 BookRevision")
    processing_match = re.search(
        r"\|\s*processing_status\s*\|\s*TEXT\s*\|\s*是\s*\|\s*([^|]+)\|",
        book_revision_section,
    )
    assert processing_match, "BookRevision.processing_status must be documented"
    assert {value.strip() for value in processing_match.group(1).split("：")[-1].split("/")} == {
        "not_started", "processing", "quality_check", "accepted", "rejected",
    }
    status_match = re.search(
        r"\|\s*status\s*\|\s*TEXT\s*\|\s*是\s*\|\s*([^|]+)\|",
        book_revision_section,
    )
    assert status_match, "BookRevision.status must be documented"
    assert {value.strip() for value in status_match.group(1).split("：")[-1].split("/")} == {
        "draft", "published", "withdrawn",
    }

    citation_section = markdown_section(dictionary, "### 3.9 Citation")
    for field in ("chunk_id", "source_hash", "quote"):
        assert field in citation_section, f"Citation missing field {field}"
    citation_body = sqlite_table_body(sqlite_worker, "citation")
    assert re.search(r"chunk_id\s+TEXT\s+NOT\s+NULL", citation_body)
    assert re.search(r"source_hash\s+TEXT\s+NOT\s+NULL", citation_body)

    unit_status_dictionary = dictionary_enum(
        dictionary, "### 3.9 ReadingUnitProgress", "status"
    )
    assert_same(
        "ReadingUnitProgress.status (dictionary vs sqlite)",
        unit_status_dictionary,
        sqlite_check_enum(
            sqlite_table_body(sqlite_worker, "reading_unit_progress"), "status"
        ),
    )
    assert_same(
        "ReadingUnitProgress.status (state-machines vs dictionary)",
        unit_status_dictionary,
        state_table_values(state_machines, "### 2.1 状态定义"),
    )
    round_status_dictionary = dictionary_enum(dictionary, "### 3.7 ReadingRound", "status")
    assert_same(
        "ReadingRound.status (dictionary vs sqlite)",
        round_status_dictionary,
        sqlite_check_enum(sqlite_table_body(sqlite_worker, "reading_round"), "status"),
    )
    assert_same(
        "ReadingRound.status (state-machines vs dictionary)",
        round_status_dictionary,
        state_table_values(state_machines, "### 3.1 状态"),
    )
    assert_same(
        "PresentedSource.presentation_type (dictionary vs sqlite)",
        dictionary_enum(dictionary, "### 3.6 PresentedSource", "presentation_type"),
        sqlite_check_enum(
            sqlite_table_body(sqlite_worker, "presented_source"), "presentation_type"
        ),
    )
    assert re.search(r"ALTER TABLE reading_round ADD COLUMN start_reason", sqlite_worker)
    presented_body = sqlite_table_body(sqlite_worker, "presented_source")
    assert "reading_round_id" in presented_body and "chunk_id" in presented_body
    assert "readingRoundStates" in read(
        ROOT / "packages" / "local-repository-contract" / "src" / "index.ts"
    )

    node_content = schemas["NodeContent"]
    assert "chunks" in node_content["required"]
    chunk_item = node_content["properties"]["chunks"]["items"]
    assert {"chunk_id", "source_hash"} <= set(chunk_item["required"])
    result_citation = schemas["GenerationStatus"]["properties"]["result"]["properties"]["citations"]["items"]
    assert {"chunk_id", "source_hash"} <= set(result_citation["required"])

    sm_ids = set(re.findall(r"SM-(\d{3})", state_machines))
    expected_sm_ids = {f"{number:03d}" for number in range(1, 31)}
    assert sm_ids == expected_sm_ids, (
        f"state-machines.md SM coverage mismatch: missing {sorted(expected_sm_ids - sm_ids)}, "
        f"unexpected {sorted(sm_ids - expected_sm_ids)}"
    )

    assert "### 4.6 RecoveryChallenge" in dictionary
    assert "已关闭：OPEN-01" in audit
    assert "state-machine-contract-audit.md" in read(ROOT / "README.md")
    print("State machine, data dictionary and OpenAPI contract checks passed.")


if __name__ == "__main__":
    main()
