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
#   scripts/memory-write-target.sh           # print the dir; warn (stderr) on hazard; exit 0
#   scripts/memory-write-target.sh --check    # same, but exit 1 on the hazard (for guards)
#
# Exit codes:
#   0  safe target (or hazard without --check)
#   1  hazard under --check, OR not inside a git repository

set -euo pipefail

check=0
case "${1:-}" in
  --check) check=1 ;;
  '') ;;
  *)
    echo "memory-write-target.sh: unknown argument '$1' (expected --check or nothing)" >&2
    exit 1
    ;;
esac

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
printf '%s\n' "$memory_dir"

# Hazard: writing memory in the SHARED primary checkout while parallel agents
# (linked worktrees) exist. Steer the caller to its own worktree copy.
if [ "$in_linked_worktree" -eq 0 ] && [ "$linked_worktrees_exist" -eq 1 ]; then
  echo "memory-write-target.sh: WARNING — you are in the PRIMARY working tree and linked worktrees exist." >&2
  echo "  Writing .claude/memory/ here can race a parallel agent (TASK-7). Write + commit memory in your own" >&2
  echo "  worktree/branch copy instead. See CLAUDE.md 'Codex Memory Bootstrap'." >&2
  if [ "$check" -eq 1 ]; then
    exit 1
  fi
fi

exit 0
