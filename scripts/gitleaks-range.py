#!/usr/bin/env python3
"""The pinned gitleaks-action's commit range, without its licensed wrapper.

Source: gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7
src/index.js (push) and src/gitleaks.js (PR). PR pagination covers the whole
intended range; a moving/incomplete API response fails instead of under-scanning.
"""
import json
import os
import re
import sys
import urllib.request


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", value):
        raise ValueError("invalid scan commit")
    return value


def pr_commits(event):
    repo = event["repository"]["full_name"]
    number = event["number"]
    if not isinstance(repo, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("invalid repository")
    if not isinstance(number, int) or isinstance(number, bool) or number < 1:
        raise ValueError("invalid pull request")
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "ax-secret-scan"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    commits = []
    for page in range(1, 4):  # GitHub's PR-commits endpoint is bounded at 250.
        url = f"https://api.github.com/repos/{repo}/pulls/{number}/commits?per_page=100&page={page}"
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
            rows = json.load(response)
        if not isinstance(rows, list):
            raise ValueError("invalid PR commits response")
        commits.extend(rows)
        if len(rows) < 100:
            return commits
    raise ValueError("PR commit list exceeded its bound")


def commit_range(event, read_pr=pr_commits):
    if "pull_request" in event:
        commits = read_pr(event)
        if not commits:
            raise ValueError("empty PR commit list")
        first, last = sha(commits[0]["sha"]), sha(commits[-1]["sha"])
        if last != sha(event["pull_request"]["head"]["sha"]):
            raise ValueError("PR head changed or commit history is incomplete")
    else:
        commits = event["commits"]
        if not commits:
            raise ValueError("push has no scan commits")
        first, last = sha(commits[0]["id"]), sha(commits[-1]["id"])
        if first == last:
            return "-1"
    return f"--no-merges --first-parent {first}^..{last}"


if __name__ == "__main__":
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as handle:
        print(commit_range(json.load(handle)))
