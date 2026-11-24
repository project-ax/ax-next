// Shared by the UI hooks: find the git worktree an edited file lives in.
//
// Claude Code runs the hook copy under $CLAUDE_PROJECT_DIR (often the main
// checkout), while builders edit files in `<main>/.claude/worktrees/agent-*`
// or sibling `../ax-next-*` worktrees. So the root must come from the edited
// FILE, never from the hook script's own location: walk up to the first
// `.git` entry (a directory in the main checkout, a file in a linked worktree).
import fs from 'node:fs';
import path from 'node:path';

/** Nearest ancestor directory of `file` holding a `.git` entry, or null. */
export function findWorktreeRoot(file) {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve `file` and place it in its worktree: `{ root, resolved, rel }` with
 * `rel` POSIX-separated and relative to `root`, or null outside any worktree.
 */
export function locateInWorktree(file) {
  const resolved = path.resolve(file);
  const root = findWorktreeRoot(resolved);
  if (root === null) return null;
  return { root, resolved, rel: path.relative(root, resolved).split(path.sep).join('/') };
}
