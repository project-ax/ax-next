#!/usr/bin/env node
// PostToolUse hook: lint an edited channel-web .tsx with the ax-ui/* rules.
// Uses the ESLint CLI (bulk suppressions only apply there) so frozen legacy
// violations stay quiet. Fails open on malformed input.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let filePath;
try {
  filePath = JSON.parse(fs.readFileSync(0, 'utf8'))?.tool_input?.file_path;
} catch {
  process.exit(0);
}
if (typeof filePath !== 'string' || filePath === '') process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolved = path.resolve(filePath);
const rel = path.relative(root, resolved).split(path.sep).join('/');

if (
  !/^packages\/channel-web\/src\/.+\.tsx$/.test(rel) ||
  rel.startsWith('packages/channel-web/src/components/ui/') ||
  /\.(test|spec)\.tsx$/.test(rel) ||
  !fs.existsSync(resolved)
) {
  process.exit(0);
}

const r = spawnSync(
  'pnpm',
  ['exec', 'eslint', '--format', 'json', '--pass-on-unpruned-suppressions', resolved],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);

let results;
try {
  results = JSON.parse(r.stdout);
} catch {
  process.exit(0); // eslint itself failed to run; don't nag
}

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
