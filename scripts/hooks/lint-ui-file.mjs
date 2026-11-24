#!/usr/bin/env node
// PostToolUse hook: lint an edited channel-web .tsx with the ax-ui/* rules.
// Uses the ESLint CLI (bulk suppressions only apply there) so frozen legacy
// violations stay quiet. ESLint runs in the EDITED FILE's worktree, so that
// worktree's own eslint.config.mjs and eslint-suppressions.json apply (the
// hook copy itself may live in a different checkout). Fails open on malformed
// input, a file outside any worktree, or a worktree without eslint installed.
// For a file with frozen violations it also says how many of a rule's
// reported violations are new.
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

// The worktree's own eslint binary, run directly rather than via `pnpm exec`:
// that needs the right pnpm on PATH (corepack picks it from package.json), and
// a hook should not depend on it.
const r = spawnSync(
  path.join(root, 'node_modules', '.bin', 'eslint'),
  ['--format', 'json', '--pass-on-unpruned-suppressions', resolved],
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
const reported = new Map(); // rule -> messages reported for this file
for (const file of results) {
  for (const m of file.messages) {
    if (m.severity === 2 && typeof m.ruleId === 'string' && m.ruleId.startsWith('ax-ui/')) {
      lines.push(`${rel}:${m.line} ${m.ruleId} ${m.message}`);
      reported.set(m.ruleId, (reported.get(m.ruleId) ?? 0) + 1);
    }
  }
}
if (lines.length === 0) process.exit(0);

// When a file has frozen violations, ESLint reports ALL of a rule's
// violations once the file goes over its frozen count, which buries the new
// ones. Say how many are new.
const summary = [];
const frozen = readFrozen(path.join(root, 'eslint-suppressions.json'), rel);
for (const [rule, now] of reported) {
  const was = frozen[rule];
  if (Number.isInteger(was) && was > 0) {
    summary.push(
      `${rule}: ${was} frozen in eslint-suppressions.json, file now has ${now} — remove the ${now - was} you added.`,
    );
  }
}
process.stderr.write([...summary, ...lines].join('\n') + '\n');
process.exit(2);

/** `{ rule: count }` frozen for `relPath`, or {} if the file is absent or unreadable. */
function readFrozen(file, relPath) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))?.[relPath];
    const out = {};
    for (const [rule, v] of Object.entries(entry ?? {})) out[rule] = v?.count;
    return out;
  } catch {
    return {};
  }
}
