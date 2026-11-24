#!/usr/bin/env node
// PreToolUse hook: packages/ui and packages/eslint-plugin-ui are the design
// system. Writes there need a `.ax-ds-task` marker in the worktree root.
// Fails open (exit 0) on malformed input so a broken hook never blocks edits.
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

const located = locateInWorktree(filePath);
if (located === null) process.exit(0); // no worktree found
const { root, resolved } = located;

const inside = (dir) => {
  const rel = path.relative(path.join(root, dir), resolved);
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
