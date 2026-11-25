#!/usr/bin/env node
// PreToolUse hook: packages/ui and packages/eslint-plugin-ui are the design
// system. Writes there need a `.ax-ds-task` marker in the worktree root.
// Fails open (exit 0) on malformed hook input so a broken hook never blocks
// edits; fails closed (exit 2) when a well-formed path can't be resolved.
import fs from 'node:fs';
import path from 'node:path';
import { locateInWorktree } from './worktree-root.mjs';

let filePath;
try {
  filePath = JSON.parse(fs.readFileSync(0, 'utf8'))?.tool_input?.file_path;
} catch {
  process.exit(0);
}
if (typeof filePath !== 'string' || filePath === '') process.exit(0);

// Compare real paths, not the path as typed: a symlink or (on macOS and
// Windows) different capitalisation reaches the same directory. Resolve the
// nearest existing ancestor with the native realpath (which returns on-disk
// case) and re-append the not-yet-created tail.
function realTarget(file) {
  let existing = path.resolve(file);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...tail);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw err;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

let located;
try {
  located = locateInWorktree(realTarget(filePath));
} catch {
  // Can't tell where this write lands (ELOOP, EACCES, …): fail closed.
  process.stderr.write(`guard-ds-writes: could not resolve ${filePath}; refusing the write.\n`);
  process.exit(2);
}
if (located === null) process.exit(0); // no worktree found
const { root, resolved } = located;

// The tail that doesn't exist yet keeps its typed case, so compare without
// case where the filesystem ignores it.
const foldCase = process.platform === 'darwin' || process.platform === 'win32';
const norm = (p) => (foldCase ? p.toLowerCase() : p);
const inside = (dir) => {
  const rel = path.relative(norm(path.join(root, dir)), norm(resolved));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

if ((inside('packages/ui') || inside('packages/eslint-plugin-ui')) &&
    !fs.existsSync(path.join(root, '.ax-ds-task'))) {
  process.stderr.write(
    'packages/ui is the design system. Feature work uses its public API; ' +
      'design-system changes need a (ds) card — see ' +
      'docs/superpowers/specs/2026-11-24-agent-first-ui-design.md.\n',
  );
  process.exit(2);
}
process.exit(0);
