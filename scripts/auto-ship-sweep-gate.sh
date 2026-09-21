#!/usr/bin/env bash
#
# auto-ship-sweep-gate.sh — may this abandoned branch be destroyed?
#
# auto-ship's §7 crash-recovery path resets a card that has no PR back to To Do
# and then sweeps its branch: `git worktree remove -f -f` + `git branch -D` +
# `git push origin --delete`. That sweep is IRREVERSIBLE, and it used to run on
# one piece of evidence — "the card has no PR". That evidence is wrong.
#
# The watchdog that reaps a stalled builder fires on SILENCE, not on failure, so
# it has no relationship to how far the builder actually got. Four shapes were
# measured on 2026-09-20 alone:
#
#   A. TASK-455 — worktree held 5 uncommitted paths, 0 commits. Committed as WIP
#      and resumed; merged as #650.
#   B. TASK-482 / TASK-479 — `git status --porcelain` EMPTY, tree pristine, but
#      the branch was 2 (resp. 3) commits ahead of main with no PR. Merged as
#      #653 / #654.
#   C. TASK-498 — same clean-tree shape at scale: 15 commits over 22 files, a
#      reviewer already run, killed by an account-level HTTP 429. Merged as #656.
#   D. The genuinely-empty branch — nothing uncommitted, nothing ahead. This one
#      MUST still be swept; worktrees and branches piling up across a run redden
#      `pnpm lint` and have done so for a whole run before now.
#
# A `--porcelain`-only gate catches A and D and walks B and C straight into the
# shredder. The question this script actually answers is the general one:
#
#     IS THERE ANYTHING ON THIS BRANCH THAT DOES NOT EXIST ANYWHERE ELSE?
#
# ...which is true if EITHER the worktree has uncommitted changes (they exist in
# exactly one place — a directory) OR the branch carries commits that are not
# reachable from the base ref.
#
# Usage:
#   scripts/auto-ship-sweep-gate.sh [--repo <dir>] <branch>
#
#   if scripts/auto-ship-sweep-gate.sh "$b"; then <sweep>; else <preserve>; fi
#
# Exit codes — note the asymmetry, it is deliberate:
#   0   SWEEP   — nothing unique here; destroying the branch loses nothing.
#   10  PRESERVE — unique work found. Commit it, push it, resume from it.
#   2   ERROR   — bad usage, unknown branch, unresolvable base, not a repo.
#
# Only exit 0 authorizes destruction. Every other outcome, INCLUDING an internal
# error, means "do not sweep": a gate in front of an irreversible delete fails
# closed, so `if gate; then destroy; fi` is safe to write and cheap to read.
#
# stdout is always exactly one machine-readable line:
#   verdict=<sweep|preserve|error> reason=<slug> branch=<b> base=<ref> \
#     worktree=<path|-> dirty=<n|?> ahead=<n|?> pushed=<yes|no|no-origin>
#
# PRECONDITION — the caller must already know there is NO PR for this card, via
# `gh pr list --state all --search "[TASK-n] in:title"`. This script is pure git
# and deliberately makes no network call, so it cannot know. It matters because
# this repo SQUASH-merges: a merged branch's commits are never reachable from
# main, so `ahead` stays >0 forever and this gate would answer `preserve` for
# every already-shipped branch. PR ground truth is what distinguishes "not
# merged yet" from "merged, and the tip is just a squash-orphan".
#
# Known limits, stated so a green verdict is not over-read:
#   - A worktree on a DETACHED head is not matched to the branch, so its
#     uncommitted changes are invisible here. Dispatched builders always have
#     the branch checked out.
#   - Stash entries are not examined. The stash stack is shared across every
#     worktree in this repo, so it is not branch-scoped and nothing here can
#     attribute an entry to a branch.
#   - `pushed=` never changes the verdict. A branch with a clean tree and zero
#     commits ahead of the base contains nothing unique whether or not it was
#     pushed — "unpushed" is a durability fact about work, not evidence that
#     work exists. It is reported because the PRESERVE procedure has to push.

set -uo pipefail

REPO=""
BRANCH=""

die_usage() {
  echo "verdict=error reason=usage branch=${BRANCH:--} base=- worktree=- dirty=? ahead=? pushed=no-origin"
  echo "auto-ship-sweep-gate.sh: $1" >&2
  echo "usage: auto-ship-sweep-gate.sh [--repo <dir>] <branch>" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ $# -ge 2 ] || die_usage "--repo needs a directory"
      REPO="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,80p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die_usage "unknown option: $1" ;;
    *)
      [ -z "$BRANCH" ] || die_usage "expected exactly one branch, got a second: $1"
      BRANCH="$1"
      shift
      ;;
  esac
done

[ -n "$BRANCH" ] || die_usage "no branch given"

REPO="${REPO:-$PWD}"
TOPLEVEL=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null) || {
  echo "verdict=error reason=not-a-repo branch=$BRANCH base=- worktree=- dirty=? ahead=? pushed=no-origin"
  echo "auto-ship-sweep-gate.sh: not inside a git repository: $REPO" >&2
  exit 2
}

git -C "$TOPLEVEL" show-ref --verify --quiet "refs/heads/$BRANCH" || {
  echo "verdict=error reason=no-such-branch branch=$BRANCH base=- worktree=- dirty=? ahead=? pushed=no-origin"
  echo "auto-ship-sweep-gate.sh: no local branch '$BRANCH'" >&2
  exit 2
}

# Base ref: what "already exists elsewhere" means. origin/main is the real
# answer; local main is the offline fallback (and is what a test fixture or a
# detached CI checkout has). Neither present is an error, never a guess — a
# gate that invented a base would answer `ahead=0` and sweep everything.
BASE=""
for candidate in "origin/main" "main"; do
  if git -C "$TOPLEVEL" rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then
    BASE="$candidate"
    break
  fi
done
[ -n "$BASE" ] || {
  echo "verdict=error reason=no-base-ref branch=$BRANCH base=- worktree=- dirty=? ahead=? pushed=no-origin"
  echo "auto-ship-sweep-gate.sh: neither origin/main nor main resolves; refusing to guess a base" >&2
  exit 2
}

# Which worktree, if any, has this branch checked out. Parsed with prefix
# stripping rather than awk $2 so a path containing spaces is not truncated.
WORKTREE="-"
current=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) current="${line#worktree }" ;;
    "branch refs/heads/$BRANCH")
      WORKTREE="$current"
      break
      ;;
  esac
done < <(git -C "$TOPLEVEL" worktree list --porcelain)

# Uncommitted = tracked modifications + untracked files (`--porcelain` already
# honours .gitignore, so a built `node_modules/` or `dist/` never counts).
DIRTY=0
if [ "$WORKTREE" != "-" ]; then
  if [ ! -d "$WORKTREE" ]; then
    # Registered but gone from disk. Nothing there to lose; the commit check below
    # still decides the verdict.
    DIRTY=0
  elif ! porcelain=$(git -C "$WORKTREE" status --porcelain 2>/dev/null); then
    echo "verdict=preserve reason=worktree-unreadable branch=$BRANCH base=$BASE worktree=$WORKTREE dirty=? ahead=? pushed=no-origin"
    echo "auto-ship-sweep-gate.sh: cannot read status of $WORKTREE — refusing to authorize a sweep blind" >&2
    exit 10
  else
    DIRTY=$(printf '%s' "$porcelain" | grep -c '[^[:space:]]')
  fi
fi

AHEAD=$(git -C "$TOPLEVEL" rev-list --count "$BASE..refs/heads/$BRANCH" 2>/dev/null) || AHEAD=""
if [ -z "$AHEAD" ]; then
  echo "verdict=preserve reason=ahead-uncountable branch=$BRANCH base=$BASE worktree=$WORKTREE dirty=$DIRTY ahead=? pushed=no-origin"
  echo "auto-ship-sweep-gate.sh: could not count commits on $BRANCH over $BASE — refusing to authorize a sweep blind" >&2
  exit 10
fi

PUSHED=no
if ! git -C "$TOPLEVEL" remote get-url origin >/dev/null 2>&1; then
  PUSHED=no-origin
elif git -C "$TOPLEVEL" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  PUSHED=yes
fi

if [ "$DIRTY" -gt 0 ] && [ "$AHEAD" -gt 0 ]; then
  REASON=uncommitted+commits-ahead
elif [ "$DIRTY" -gt 0 ]; then
  REASON=uncommitted
elif [ "$AHEAD" -gt 0 ]; then
  REASON=commits-ahead
else
  REASON=nothing-unique
fi

if [ "$REASON" = nothing-unique ]; then
  echo "verdict=sweep reason=$REASON branch=$BRANCH base=$BASE worktree=$WORKTREE dirty=$DIRTY ahead=$AHEAD pushed=$PUSHED"
  exit 0
fi

echo "verdict=preserve reason=$REASON branch=$BRANCH base=$BASE worktree=$WORKTREE dirty=$DIRTY ahead=$AHEAD pushed=$PUSHED"
exit 10
