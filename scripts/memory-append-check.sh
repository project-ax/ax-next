#!/usr/bin/env bash
#
# memory-append-check.sh — did this branch ADD memory, or did it EDIT memory?
#
# `.claude/memory/` is append-only working memory that every parallel auto-ship
# branch writes to. When the whole repo appended to the same five files, those
# files became a serialization point: measured across one day's runs, eight
# branches hit an append-collision in `decisions.md` / `patterns.md` /
# `mistakes.md`, and two of them hit a SECOND one while merely waiting in the
# merge queue. No product code reads these files. The collisions were pure
# throughput cost — a rebase, a force-push and a fresh ~10-minute CI run each.
#
# So new rows go in per-task SHARD files (`.claude/memory/<kind>/<date>-<TASK-ID>.md`,
# which `scripts/memory-write-target.sh --shard` names for you). Two branches
# never write the same bytes, so there is nothing to merge, and `git rerere`
# never gets a conflict to record or to replay against the wrong `main`.
#
# This script is the guard that keeps that true. It checks two things about the
# memory diff between a base ref and HEAD:
#
#   R1 — ZERO DELETIONS. Not "my rows survived". A branch once passed its own
#        row-presence check while a whole-file blank-line normalization had
#        silently collapsed four pre-existing double-blank runs elsewhere in
#        decisions.md. No rows were lost, so "my rows survived" reported
#        success. Unrelated churn in the one file that IS the serialization
#        point manufactures the next agent's conflict, and the deletions column
#        is what sees it.
#
#   R2 — SHARD-ONLY. Touching a root `.claude/memory/<name>.md` archive at all
#        puts the branch back on the collision path. Add a shard instead.
#
# Both are about the same property from two directions: a branch ADDS memory,
# it does not EDIT memory.
#
# Deliberate maintenance (a hygiene pass, an archive consolidation, fixing a
# stale citation) genuinely needs to edit the archives. That is fine — it is
# just not something to do accidentally, or concurrently with five other
# agents. Put a `Memory-Rewrite: <reason>` trailer on a commit in the range and
# both rules drop to warnings.
#
# Usage:
#   scripts/memory-append-check.sh              # compare against origin/main
#   scripts/memory-append-check.sh <base-ref>   # compare against something else
#
# Exit codes:
#   0  clean, or waived by a Memory-Rewrite trailer, or nothing under .claude/memory/ changed
#   1  at least one violation (they are all printed, not just the first)
#   2  usage error, or the base ref could not be resolved (fail CLOSED — an
#      unresolvable base is not a pass)

set -uo pipefail

MEMORY_PREFIX='.claude/memory/'
# `:(top)` anchors the pathspec to the repository root. A bare
# `.claude/memory/` is resolved relative to the CURRENT DIRECTORY, so running
# this from `scripts/` matched nothing and reported "nothing changed — ok" on a
# branch that had rewritten every archive. `--numstat` prints repo-relative
# paths either way, so only the pathspec needed anchoring.
MEMORY_PATHSPEC=":(top)${MEMORY_PREFIX}"

case "${1:-}" in
  -h | --help)
    sed -n '3,50p' "$0"
    exit 0
    ;;
esac

if [ "$#" -gt 1 ]; then
  echo "memory-append-check.sh: expected at most one argument (a base ref), got $#." >&2
  echo "  usage: scripts/memory-append-check.sh [<base-ref>]   # default: origin/main" >&2
  exit 2
fi

base_ref="${1:-origin/main}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "memory-append-check.sh: not inside a git repository." >&2
  exit 2
fi

if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
  echo "memory-append-check.sh: cannot resolve base ref '${base_ref}'." >&2
  echo "  Not treating that as a pass — an unreadable base means this check did not run." >&2
  echo "  In a fresh clone or a shallow CI checkout, fetch it first: git fetch origin <branch>" >&2
  exit 2
fi

if ! merge_base=$(git merge-base "$base_ref" HEAD 2>/dev/null) || [ -z "$merge_base" ]; then
  echo "memory-append-check.sh: '${base_ref}' and HEAD have no common ancestor." >&2
  exit 2
fi

# `--no-renames` on purpose: a rename of a memory file removes every row from
# the old path, and that is exactly the thing R1 exists to notice. Letting git
# report it as a rename would hide it behind a 0/0 line count.
#
# `-z` on purpose too: without it git QUOTES any path holding a space or a
# non-ASCII byte, and a quoted path no longer has the `.claude/memory/` prefix
# R2 strips — so exactly the odd filename you would want flagged is the one
# that reads as a well-behaved shard. NUL-terminated records have no such
# escaping. `--no-renames` also keeps every record to three fields, which the
# rename form of `-z` would not.
#
# Via a temp file, NOT `$(…)`: bash cannot hold a NUL byte in a variable and
# drops them from command substitution silently, which leaves one run-together
# record that `read -d ''` then hits EOF on — and `read` returning nonzero at
# EOF means the `while` body never executes AT ALL. That failure mode is a
# clean exit 0 on a diff nobody looked at, which is the worst thing a guard can
# do. (Measured while writing this: the quoted-path case it was meant to fix
# came back "ok".)
numstat_file=$(mktemp "${TMPDIR:-/tmp}/memory-append-check.XXXXXX") || {
  echo "memory-append-check.sh: could not create a temp file." >&2
  exit 2
}
trap 'rm -f "$numstat_file"' EXIT

if ! git -c core.quotePath=false diff --numstat -z --no-renames \
  "$merge_base" HEAD -- "$MEMORY_PATHSPEC" >"$numstat_file"; then
  echo "memory-append-check.sh: git diff failed for ${merge_base}..HEAD" >&2
  exit 2
fi

if [ ! -s "$numstat_file" ]; then
  echo "memory-append-check.sh: nothing under ${MEMORY_PREFIX} changed — ok."
  exit 0
fi

violations=()

while IFS=$'\t' read -r -d '' added deleted path; do
  [ -n "${path:-}" ] || continue

  # Anything that is not a plain count means git could not line-diff the file
  # (`-` for what it treats as binary). "No rows were dropped" is then
  # unprovable, and an unprovable claim is not a passing one.
  case "${added}${deleted}" in
    *[!0-9]*)
      violations+=("${path}: git cannot line-diff this file (binary?), so zero-deletions is unprovable")
      continue
      ;;
  esac

  if [ "$deleted" -gt 0 ]; then
    violations+=("${path}: ${deleted} line(s) DELETED (memory is append-only — R1)")
  fi

  # A root archive is `.claude/memory/<something>.md` with nothing further to
  # its path. A shard lives one level down, so it always has another slash.
  rest="${path#"$MEMORY_PREFIX"}"
  case "$rest" in
    */*) : ;; # a shard — fine
    *)
      violations+=("${path}: root archive edited, +${added}/-${deleted} (append a shard instead — R2)")
      ;;
  esac
done <"$numstat_file"

if [ "${#violations[@]}" -eq 0 ]; then
  echo "memory-append-check.sh: ${MEMORY_PREFIX} changes are shard-only with zero deletions — ok."
  exit 0
fi

# A deliberate rewrite says so in a commit TRAILER. Checked only once we know
# there is something to waive, so the trailer can never be reported as doing
# nothing.
#
# `%(trailers:key=…)` and not a grep of the whole body: a grep for
# `^Memory-Rewrite:` matches the string ANYWHERE in ANY commit message in the
# range, so a commit that merely quotes the line — documenting the mechanism,
# reverting a waived commit, or arriving from another branch — would waive real
# violations. Git's own trailer parser only looks at the trailer block, so
# prose cannot waive.
waiver=$(git log --format='%(trailers:key=Memory-Rewrite,valueonly,separator=%x0A)' \
  "${merge_base}..HEAD" | grep -E '[^[:space:]]' | head -n 1 || true)

printf 'memory-append-check.sh: %d issue(s) in %s between %s and HEAD:\n' \
  "${#violations[@]}" "$MEMORY_PREFIX" "${merge_base:0:12}" >&2
for v in "${violations[@]}"; do
  echo "  - $v" >&2
done

if [ -n "$waiver" ]; then
  echo "" >&2
  echo "WAIVED by a commit trailer: ${waiver}" >&2
  echo "  Taking your word for it. Worth knowing: a branch that rewrites an archive is" >&2
  echo "  back on the collision path, so land it on its own rather than beside five" >&2
  echo "  other agents." >&2
  exit 0
fi

echo "" >&2
echo "What to do instead — put this run's rows in their own file:" >&2
echo "  path=\$(scripts/memory-write-target.sh --shard decisions TASK-123) && mkdir -p \"\$(dirname \"\$path\")\"" >&2
echo "  (kinds: context decisions patterns mistakes meta)" >&2
echo "" >&2
echo "Nothing else writes that path, so it cannot collide with another agent, and" >&2
echo "nobody has to re-resolve it on every rebase." >&2
echo "" >&2
echo "There IS a waiver for deliberate maintenance — a hygiene pass, an archive" >&2
echo "consolidation, fixing a stale citation. It is a commit trailer, and it is" >&2
echo "documented in CLAUDE.md rather than printed here on purpose: an automated" >&2
echo "writer that trips this guard should be reaching for a shard, not for the one" >&2
echo "line that makes the check go green. If you are an agent shipping a card, the" >&2
echo "answer above is the answer. The waiver is a human call on a branch of its own." >&2
exit 1
