#!/usr/bin/env bash
#
# memory-write-target.sh — where should I write `.claude/memory/`?
#
# Parallel auto-ship agents used to race on the SHARED main-checkout
# `.claude/memory/`: a concurrent agent would overwrite decisions.md and
# silently drop another agent's appended rows (TASK-7). The fix is a
# convention — every agent writes + commits memory ONLY to its OWN
# worktree/branch copy, never the shared main checkout. This helper makes
# that convention easy to follow and hard to get wrong.
#
# It prints the correct memory directory for the current working tree
# (`<git toplevel>/.claude/memory`) — which is automatically the per-tree
# copy whether you're in the primary checkout or a linked `git worktree`.
#
# It also flags the one hazardous case: you're standing in the PRIMARY
# working tree while one or more linked worktrees exist. That's exactly the
# "parallel agents share a checkout" situation where a memory write can race.
#
# Usage:
#   scripts/memory-write-target.sh                    # print the dir; warn (stderr) on hazard; exit 0
#   scripts/memory-write-target.sh --check              # same, but exit 1 on the hazard (for guards)
#   scripts/memory-write-target.sh --shard <kind> <ID>  # print a per-task shard path; see below
#
# --shard prints `<memory dir>/<kind>/<YYYY-MM-DD>-<TASK-ID>.md` instead of the
# bare memory dir. Even the per-worktree convention above wasn't enough: two
# branches both writing decisions.md still collide at PR-merge time because
# git has to line-merge the same file. A shard file is unique per (day, task),
# so two branches never write the same bytes — there is no merge to resolve.
# `<kind>` is one of context/decisions/patterns/mistakes/meta. This mode only
# prints a path; it creates nothing (no mkdir, no touch) and is NOT combined
# with --check semantics — the hazard warning still fires on stderr, but
# --shard always exits 0.
#
# Exit codes:
#   0  safe target (or hazard without --check), OR a valid --shard path
#   1  hazard under --check, OR not inside a git repository, OR invalid --shard args

set -euo pipefail

VALID_KINDS="context decisions patterns mistakes meta"

is_valid_kind() {
  case " $VALID_KINDS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

is_valid_task_id() {
  # Anchored, and every character class below is alnum-only — neither `.` nor
  # `/` can ever appear in a string that matches, so `..` and `/` (and thus
  # any path escape) are unrepresentable here, not just rejected downstream.
  printf '%s' "$1" | grep -Eq '^[A-Za-z][A-Za-z0-9]*-[0-9]+$'
}

check=0
shard_mode=0
shard_kind=''
shard_task_id=''

if [ "${1:-}" = '--shard' ]; then
  shard_mode=1
  if [ "$#" -ne 3 ]; then
    echo "memory-write-target.sh: usage: memory-write-target.sh --shard <kind> <TASK-ID>" >&2
    exit 1
  fi
  shard_kind="$2"
  shard_task_id="$3"
  if ! is_valid_kind "$shard_kind"; then
    echo "memory-write-target.sh: invalid kind '$shard_kind' (expected one of: $VALID_KINDS)" >&2
    exit 1
  fi
  if ! is_valid_task_id "$shard_task_id"; then
    echo "memory-write-target.sh: invalid TASK-ID '$shard_task_id' (expected e.g. TASK-415)" >&2
    exit 1
  fi
else
  case "${1:-}" in
    --check) check=1 ;;
    '') ;;
    *)
      echo "memory-write-target.sh: unknown argument '$1' (expected --check, --shard, or nothing)" >&2
      exit 1
      ;;
  esac
fi

# Must be inside a git work tree.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "memory-write-target.sh: not inside a git repository — cannot resolve a memory dir." >&2
  exit 1
fi

toplevel=$(git rev-parse --show-toplevel)
# Normalize symlinks (e.g. macOS /var -> /private/var) so the path matches
# what callers compare against.
toplevel=$(cd "$toplevel" && pwd -P)
memory_dir="$toplevel/.claude/memory"

if [ "$shard_mode" -eq 1 ]; then
  today=$(date +%F)
  target="$memory_dir/$shard_kind/$today-$shard_task_id.md"
else
  target="$memory_dir"
fi

# Distinguish the primary working tree from a linked worktree. In a linked
# worktree the per-tree git dir (.git/worktrees/<name>) differs from the
# shared common dir (.git); in the primary tree they're the same.
git_dir=$(git rev-parse --absolute-git-dir)
common_dir=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
in_linked_worktree=0
if [ "$git_dir" != "$common_dir" ]; then
  in_linked_worktree=1
fi

# Does at least one LINKED worktree exist? `git worktree list` always lists
# the primary first; >1 entry means a linked worktree is present.
linked_worktrees_exist=0
if [ "$(git worktree list --porcelain | grep -c '^worktree ')" -gt 1 ]; then
  linked_worktrees_exist=1
fi

# Always print the resolved target on stdout.
printf '%s\n' "$target"

# Hazard: writing memory in the SHARED primary checkout while parallel agents
# (linked worktrees) exist. Steer the caller to its own worktree copy. Still
# warned about under --shard (shards make merges unnecessary, not the choice
# of tree), but --shard never turns this into a nonzero exit.
if [ "$in_linked_worktree" -eq 0 ] && [ "$linked_worktrees_exist" -eq 1 ]; then
  echo "memory-write-target.sh: WARNING — you are in the PRIMARY working tree and linked worktrees exist." >&2
  echo "  Writing .claude/memory/ here can race a parallel agent (TASK-7). Write + commit memory in your own" >&2
  echo "  worktree/branch copy instead. See CLAUDE.md 'Codex Memory Bootstrap'." >&2
  if [ "$check" -eq 1 ]; then
    exit 1
  fi
fi

exit 0
