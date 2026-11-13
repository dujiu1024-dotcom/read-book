from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / ".github" / "quality" / "test-targets.json"
REPORT = ROOT / "artifacts" / "project-test-report.json"


def main() -> int:
    REPORT.parent.mkdir(exist_ok=True)
    config = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if config.get("version") != 1 or not isinstance(config.get("targets"), list):
        raise ValueError("test-targets.json must use version 1 and a targets array")

    results = []
    for target in config["targets"]:
        target_id = target.get("id")
        command = target.get("command")
        cwd = (ROOT / target.get("cwd", ".")).resolve()
        if not target_id or not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command):
            raise ValueError(f"invalid test target: {target}")
        try:
            cwd.relative_to(ROOT)
        except ValueError as exc:
            raise ValueError(f"test target {target_id} cwd escapes repository") from exc
        completed = subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
        results.append({
            "id": target_id,
            "command": command,
            "cwd": str(cwd.relative_to(ROOT)),
            "returncode": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
        })
        print(f"TEST TARGET {target_id}: {'passed' if completed.returncode == 0 else 'failed'}")
        if completed.stdout:
            print(completed.stdout)
        if completed.stderr:
            print(completed.stderr, file=sys.stderr)

    report = {
        "status": "not_configured" if not results else ("passed" if all(x["returncode"] == 0 for x in results) else "failed"),
        "targets_discovered": len(results),
        "results": results,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if not results:
        print("Project tests: NOT CONFIGURED — no project test targets are declared; contract self-tests still run separately.")
        return 0
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
