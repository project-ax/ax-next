#!/usr/bin/env bash
#
# ci-test-shard.sh — run one shard of the full test suite (CI, push to main).
#
# WHY. The full suite ran as ONE `pnpm -r run test` on one 4-core runner and
# took ~22 of CI's ~24-30 minutes: the five or six slow packages (routines,
# channel-web, agents, skills, connectors, conversations — each 2-6 minutes)
# shared four cores with each other and with ~75 fast ones. Four runners in
# parallel each take one share. PRs are unaffected: they already run only the
# packages they touch (see the "affected packages" step in ci.yml).
#
# THE SPLIT lives here and only here. The named shards list their packages;
# `rest` is EVERY other workspace package, derived by excluding the named
# ones — so a package added tomorrow lands in `rest` automatically and is
# never silently left out. `scripts/__tests__/ci-test-shard.test.js` pins that
# the shards partition the workspace: every package in exactly one shard.
# `rest` also runs the two repo-level suites (eslint-rules, scripts).
#
# Balanced on CI timings from 2026-11-08 (vitest Duration per package):
#   routines   routines 366s, conversations 124s
#   web        channel-web 244s, attachments 89s, frame-guard 66s (the browser tests)
#   agents     agents 215s, skills 194s, connectors 172s
#   rest       ~75 packages, ~15 minutes summed, most under 30s each
#
# --no-bail: report every failing package, not just the first (`pnpm -r`
# stops at the first by default, which hides the rest).
#
# WHAT RUNS TOGETHER MATTERS. Several suites assert wall-clock budgets (frame-
# guard's parse5 limits answer in <1 s, user-files-read's swap race needs
# >=5000 iterations in its window, routines-contract's 5 s default timeout).
# The first sharded run (2026-11-08, run 42490563875) put channel-web's jsdom
# suite, attachments' Chromium tests and frame-guard's budgets on one runner at
# once, and also used --no-sort (every package starts immediately instead of in
# topological waves): four of those budget tests failed, nothing else did. So
# `web` runs its three packages ONE AT A TIME (~400 s, still under `rest`), and
# every shard keeps pnpm's default topological order, as the unsharded run had.
#
# Usage: scripts/ci-test-shard.sh <routines|web|agents|rest>
#        scripts/ci-test-shard.sh --list <shard>   # print the shard's packages

set -euo pipefail

shard_packages() {
  case "$1" in
    routines) echo "@ax/routines @ax/conversations" ;;
    web)      echo "@ax/channel-web @ax/attachments @ax/frame-guard" ;;
    agents)   echo "@ax/agents @ax/skills @ax/connectors" ;;
    rest)     echo "" ;;
    *)        return 1 ;;
  esac
}

NAMED_SHARDS=(routines web agents)

filters_for() {
  local shard=$1 pkg named
  local out=()
  if [ "$shard" = rest ]; then
    # Every workspace package except the named shards' and the root.
    out+=(--filter './**' --filter '!{.}')
    for named in "${NAMED_SHARDS[@]}"; do
      for pkg in $(shard_packages "$named"); do out+=(--filter "!$pkg"); done
    done
  else
    for pkg in $(shard_packages "$shard"); do out+=(--filter "$pkg"); done
  fi
  printf '%s\n' "${out[@]}"
}

if [ "${1:-}" = --list ]; then
  shard=${2:-}
  shard_packages "$shard" >/dev/null || { echo "unknown shard: ${shard:-<none>}" >&2; exit 2; }
  filters=(); while IFS= read -r f; do filters+=("$f"); done < <(filters_for "$shard")
  pnpm "${filters[@]}" list --depth -1 --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      for (const p of JSON.parse(s)) if (p.name) console.log(p.name);
    });'
  exit 0
fi

shard=${1:-}
shard_packages "$shard" >/dev/null || {
  echo "usage: $0 <routines|web|agents|rest>  (got: ${shard:-<none>})" >&2
  exit 2
}
filters=(); while IFS= read -r f; do filters+=("$f"); done < <(filters_for "$shard")

echo "Shard '$shard':"
pnpm "${filters[@]}" list --depth -1 --parseable | sed "s|^$PWD/||" | sed 's/^/  /'

concurrency=--workspace-concurrency=4
if [ "$shard" = web ]; then concurrency=--workspace-concurrency=1; fi

status=0
pnpm "${filters[@]}" "$concurrency" --no-bail run test || status=$?
if [ "$shard" = rest ]; then
  pnpm test:eslint-rules || status=$?
  pnpm test:scripts || status=$?
fi
exit "$status"
