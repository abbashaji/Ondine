#!/usr/bin/env python3
"""
Heavy Worker (Section 4, step 6).

Pulls a CodeCell's generated code from Turso, runs a headless test pass on
it, and reports pass/fail + log back to the turso-github-mcp Worker so the
waiting CodeCellWorkflow instance (Section 4f, step.waitForEvent) can
resume. Uses only the stdlib so no pip install / extra Action minutes are
spent on dependency setup.
"""
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

TURSO_DATABASE_URL = os.environ["TURSO_DATABASE_URL"]
TURSO_AUTH_TOKEN = os.environ["TURSO_AUTH_TOKEN"]
GATEWAY_URL = os.environ["GATEWAY_URL"].rstrip("/")  # e.g. https://turso-github-mcp.<subdomain>.workers.dev
HEAVY_WORKER_CALLBACK_TOKEN = os.environ["HEAVY_WORKER_CALLBACK_TOKEN"]
CELL_ID = os.environ["CELL_ID"]
WORKFLOW_INSTANCE_ID = os.environ["WORKFLOW_INSTANCE_ID"]


def turso_query(sql, args=None):
    url = TURSO_DATABASE_URL.replace("libsql://", "https://") + "/v2/pipeline"
    body = {
        "requests": [
            {
                "type": "execute",
                "stmt": {
                    "sql": sql,
                    "args": [{"type": "text", "value": str(a)} for a in (args or [])],
                },
            },
            {"type": "close"},
        ]
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {TURSO_AUTH_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def fetch_cell_code(cell_id):
    result = turso_query("SELECT code FROM code_cells WHERE id = ?", [cell_id])
    rows = result["results"][0]["response"]["result"]["rows"]
    if not rows:
        raise RuntimeError(f"No code_cells row for id={cell_id}")
    return rows[0][0]["value"]


def run_headless_tests(code_text):
    """Smoke-test the generated code: syntax check, then pytest if a
    matching tests/ file exists in the repo (Blender-addon-style Python
    modules generally ship their own test module alongside them)."""
    log_lines = []
    cell_path = Path("generated_cell.py")
    cell_path.write_text(code_text)

    compile_check = subprocess.run(
        [sys.executable, "-m", "py_compile", str(cell_path)],
        capture_output=True,
        text=True,
    )
    log_lines.append("--- py_compile ---\n" + compile_check.stdout + compile_check.stderr)
    if compile_check.returncode != 0:
        return False, "\n".join(log_lines)

    tests_dir = Path("tests")
    if tests_dir.exists() and any(tests_dir.glob("test_*.py")):
        pytest_run = subprocess.run(
            [sys.executable, "-m", "pytest", "tests/", "-q"],
            capture_output=True,
            text=True,
        )
        log_lines.append("--- pytest ---\n" + pytest_run.stdout + pytest_run.stderr)
        return pytest_run.returncode == 0, "\n".join(log_lines)

    log_lines.append("--- no tests/ directory found; syntax check only ---")
    return True, "\n".join(log_lines)


def report_result(passed, log):
    body = json.dumps(
        {
            "workflow_instance_id": WORKFLOW_INSTANCE_ID,
            "cell_id": CELL_ID,
            "passed": passed,
            "log": log[-4000:],
        }
    ).encode()
    req = urllib.request.Request(
        f"{GATEWAY_URL}/webhook/heavy-worker-result",
        data=body,
        headers={
            "Authorization": f"Bearer {HEAVY_WORKER_CALLBACK_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        print(resp.read().decode())


def main():
    code_text = fetch_cell_code(CELL_ID)
    passed, log = run_headless_tests(code_text)
    print(log)
    report_result(passed, log)
    # Exit 0 regardless of test outcome: this job's job is to *report* the
    # result, not to fail the Action on a legitimate Failed/Dead_Letter cell.


if __name__ == "__main__":
    main()
