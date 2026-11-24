#!/usr/bin/env node
// PostToolUse hook: lint an edited channel-web .tsx with the ax-ui/* rules.
// Uses the ESLint CLI (bulk suppressions only apply there) so frozen legacy
// violations stay quiet. ESLint runs in the EDITED FILE's worktree, so that
// worktree's own eslint.config.mjs and eslint-suppressions.json apply (the
// hook copy itself may live in a different checkout). Fails open on malformed
// input, a file outside any worktree, or a worktree without eslint installed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { locateInWorktree } from './worktree-root.mjs';

let filePath;
try {
  filePath = JSON.parse(fs.readFileSync(0, 'utf8'))?.tool_input?.file_path;
} catch {
  process.exit(0);
}
if (typeof filePath !== 'string' || filePath === '') process.exit(0);

const located = locateInWorktree(filePath);
if (located === null) process.exit(0);
const { root, resolved, rel } = located;

if (
  !/^packages\/channel-web\/src\/.+\.tsx$/.test(rel) ||
  rel.startsWith('packages/channel-web/src/components/ui/') ||
  /\.(test|spec)\.tsx$/.test(rel) ||
  !fs.existsSync(resolved) ||
  !fs.existsSync(path.join(root, 'node_modules', '.bin', 'eslint'))
) {
  process.exit(0);
}

const r = spawnSync(
  'pnpm',
  ['exec', 'eslint', '--format', 'json', '--pass-on-unpruned-suppressions', resolved],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 45_000 },
);

if (r.error || r.signal || r.status === null || typeof r.stdout !== 'string') process.exit(0);

let results;
try {
  results = JSON.parse(r.stdout);
} catch {
  process.exit(0); // eslint itself failed to run; don't nag
}
if (!Array.isArray(results)) process.exit(0);

const lines = [];
for (const file of results) {
  for (const m of file.messages) {
    if (m.severity === 2 && typeof m.ruleId === 'string' && m.ruleId.startsWith('ax-ui/')) {
      lines.push(`${rel}:${m.line} ${m.ruleId} ${m.message}`);
    }
  }
}
if (lines.length > 0) {
  process.stderr.write(lines.join('\n') + '\n');
  process.exit(2);
}
process.exit(0);
