#!/usr/bin/env bash
#
# codex-review.sh — non-interactive whole-branch Codex review (yolo-ship Phase 5).
#
# Why this exists: the Phase 5 gate used to shell out to the `openai-codex`
# plugin's `codex-companion.mjs review`. That path hangs in an automated
# (non-TTY) context for two reasons:
#   1. the companion launches the review as a job and then stops to ask
#      "wait, or run in background?" — a prompt nobody can answer headless; and
#   2. the companion isn't always installed (codex availability varies per run),
#      so the `${CODEX_ROOT}` probe can resolve to nothing.
# The bare `codex review` subcommand IS that same native reviewer, minus the
# wait/background prompt, and is present whenever the `codex` CLI is. We also
# close stdin (`</dev/null`) so the review can never block reading a prompt.
#
# NOTE ON TIMEOUT: a whole-branch review takes minutes (≈3-5; 272s measured on a
# 4-file diff). This script runs the review to completion in the foreground — it
# does NOT and cannot set the caller's timeout. When invoking from the Claude
# Code Bash tool, pass a long timeout (~600000ms); the 120s default will kill a
# healthy review and look like a hang.
#
# Usage:
#   scripts/codex-review.sh [--base <branch>] [custom review instructions...]
#
#   scripts/codex-review.sh                       # review HEAD vs main
#   scripts/codex-review.sh --base release-2       # review vs a different base
#   scripts/codex-review.sh --base main "Challenge the approach; focus on \
#     AX invariants and IPC boundary leaks"        # custom/adversarial framing
#
# Exit codes:
#   (passes through codex's exit code)
#   2    bad arguments
#   127  `codex` CLI not found on PATH

set -euo pipefail

base="main"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      [[ $# -ge 2 ]] || { echo "codex-review.sh: --base requires a branch name" >&2; exit 2; }
      base="$2"; shift 2 ;;
    --base=*)
      base="${1#--base=}"; shift ;;
    --help|-h)
      cat >&2 <<'USAGE'
Usage: codex-review.sh [--base <branch>] [custom review instructions...]

Runs the native `codex review` reviewer non-interactively (stdin closed) over
the working tree vs <branch> (default: main). A whole-branch review takes
minutes — give the caller a long timeout (~600000ms via the Bash tool).
USAGE
      exit 0 ;;
    --) shift; break ;;
    *) break ;;  # remaining args are custom review instructions
  esac
done

if ! command -v codex >/dev/null 2>&1; then
  echo "codex-review.sh: 'codex' CLI not found on PATH — install it (https://github.com/openai/codex) or run the review manually." >&2
  exit 127
fi

# Remaining positional args, if any, become the custom review prompt.
prompt="$*"

args=(review --base "$base")
[[ -n "$prompt" ]] && args+=("$prompt")

# `</dev/null` is load-bearing: it gives codex immediate EOF on stdin so it can
# never block waiting for a prompt in a headless run.
exec codex "${args[@]}" </dev/null
