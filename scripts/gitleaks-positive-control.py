#!/usr/bin/env python3
"""Exercise the real pinned binary on Git history, including a removed secret."""
import json
import pathlib
import shutil
import runpy
import subprocess
import sys
import tempfile

binary = str(pathlib.Path(sys.argv[1]).resolve())
repo = pathlib.Path(__file__).resolve().parent.parent
commit_range = runpy.run_path(str(repo / "scripts/gitleaks-range.py"))["commit_range"]
with tempfile.TemporaryDirectory(prefix="ax-secret-scan-") as directory:
    root = pathlib.Path(directory)
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=root, text=True).strip()
    git("init", "-q")
    git("config", "user.name", "Secret scan control")
    git("config", "user.email", "control@example.invalid")
    shutil.copy(repo / ".gitleaks.toml", root)
    shutil.copy(repo / ".gitleaksignore", root)
    (root / "clean.txt").write_text("clean baseline\n")
    git("add", ".")
    git("commit", "-qm", "clean baseline")
    # No usable credential is present, and the constructed value never reaches logs.
    fake = "gh" + "p_" + "Ab9dEf3hJk7mNp2rSt6vWx4zBc8qRs5uVw1X"
    (root / "control.txt").write_text("token=" + fake + "\n")
    git("add", ".")
    git("commit", "-qm", "add synthetic positive control")
    first = git("rev-parse", "HEAD")
    (root / "control.txt").unlink()
    git("add", "-u")
    git("commit", "-qm", "remove synthetic positive control")
    last = git("rev-parse", "HEAD")
    def scan(log_opts, report):
        return subprocess.run([binary, "detect", "--redact", "-v", "--exit-code=2", "--report-format=sarif",
            "--report-path=" + str(report), "--log-level=debug", "--log-opts=" + log_opts], cwd=root, capture_output=True, text=True)
    report = root / "positive.sarif"
    positive = scan(commit_range({"commits": [{"id": first}, {"id": last}]}), report)
    if positive.returncode != 2 or fake in positive.stdout + positive.stderr + report.read_text():
        raise SystemExit("Secret scan positive control failed or exposed its synthetic value")
    results = json.loads(report.read_text())["runs"][0]["results"]
    if not results:
        raise SystemExit("Secret scan positive control produced no findings")
    clean = scan(commit_range({"commits": [{"id": last}]}), root / "negative.sarif")
    if clean.returncode != 0:
        raise SystemExit("Secret scan exceeded the selected commit range")
print("Real scanner control passed: removed secret detected and redacted; clean selected commit passed.")
