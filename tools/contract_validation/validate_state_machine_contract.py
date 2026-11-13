from pathlib import Path
import yaml
from openapi_spec_validator import validate

ROOT = Path(__file__).resolve().parents[2]


def main():
    api_path = ROOT / "docs" / "api-contract.yaml"
    spec = yaml.safe_load(api_path.read_text(encoding="utf-8"))
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

    state_machines = (ROOT / "docs" / "state-machines.md").read_text(encoding="utf-8")
    dictionary = (ROOT / "docs" / "data-dictionary.md").read_text(encoding="utf-8")
    audit = (ROOT / "docs" / "state-machine-contract-audit.md").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    for token in ("cancel_requested", "RecoveryChallenge", "BackupUploadSession", "BackupManifest", "SM-030"):
        assert token in state_machines, f"state-machines.md missing {token}"
    for token in ("### 4.6 RecoveryChallenge", "cancel_requested", "inaccessible", "AccountDataSetBinding"):
        assert token in dictionary, f"data-dictionary.md missing {token}"
    assert "OPEN-01" in audit and "OPEN-04" in audit
    assert "state-machine-contract-audit.md" in readme
    print("State machine, data dictionary and OpenAPI contract checks passed.")


if __name__ == "__main__":
    main()
