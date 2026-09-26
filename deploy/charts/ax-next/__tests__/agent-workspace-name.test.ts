// The agent-workspace switch is retired (TASK-360): the workspace is always
// on. Before that it had three names (TASK-359 collapsed them to one), and a
// compat read that promoted the oldest one. Both are gone. These guards keep
// them gone:
//
//   1. no production source spells the old client/config field name;
//   2. no production source outside serve.ts even names either retired env
//      var as a string — so nothing can quietly start reading one again —
//      and serve.ts only WARNS: it never assigns or promotes either name;
//   3. no chart template stamps either name.
//
// (The chart-version tripwire that used to live here guarded the compat read;
// there is no compat read left, and the warning is meant to stay.)
//
// Source scans, no helm — runs everywhere.

import { globSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const chartDir = resolve(here, '..');
const repoRoot = resolve(here, '../../../..');
const serveSourcePath = resolve(repoRoot, 'packages/cli/src/commands/serve.ts');

const RETIRED_ENVS = ['AX_AGENT_WORKSPACE', 'AX_AGENT_WORKSPACE_PREVIEW'] as const;
const RETIRED_FIELD = 'agentWorkspacePreview';

/** Every non-test TS/TSX source file under packages/ and presets/. */
function productionSources(): string[] {
  const files = globSync(['packages/*/src/**/*.{ts,tsx}', 'presets/*/src/**/*.{ts,tsx}'], {
    cwd: repoRoot,
  })
    .filter((f) => !/(^|\/)__tests__\//.test(f))
    .filter((f) => !/\.test\.tsx?$/.test(f));
  // Over-guard: a scan that stops finding its corpus must fail, not pass.
  expect(files.length, 'production sources found').toBeGreaterThan(200);
  return files;
}

describe('agent workspace switch is retired (TASK-359, TASK-360)', () => {
  it(`no production source spells the retired field name ${RETIRED_FIELD}`, () => {
    const hits = productionSources().filter((f) =>
      readFileSync(resolve(repoRoot, f), 'utf8').includes(RETIRED_FIELD),
    );
    expect(hits).toEqual([]);
  });

  it.each(RETIRED_ENVS)('only serve.ts names %s as a string or property', (name) => {
    // A quoted literal (`'NAME'`, `"NAME"`) or a property access (`.NAME`,
    // `env.NAME`) is what a read looks like. Backticked mentions in comments
    // are fine and deliberately not matched.
    const read = new RegExp(`(['"]${name}['"]|\\.${name}\\b)`);
    const hits = productionSources().filter((f) =>
      read.test(readFileSync(resolve(repoRoot, f), 'utf8')),
    );
    expect(hits).toEqual([relative(repoRoot, serveSourcePath)]);
  });

  it('serve.ts only warns — it never assigns or promotes either retired name', () => {
    const src = readFileSync(serveSourcePath, 'utf8');
    for (const name of RETIRED_ENVS) {
      // `NAME:` (an object key, e.g. `{ ...env, NAME: x }`) or `NAME =`.
      expect(src, `serve.ts writes ${name}`).not.toMatch(
        new RegExp(`\\b${name}\\b['"]?\\s*(:|=[^=])`),
      );
    }
    expect(src).toContain('warnRetiredEnvNames');
    expect(src).not.toContain('applyRetiredEnvNames');
  });

  it.each(RETIRED_ENVS)('no chart template stamps %s', (name) => {
    const templates = globSync('**/*.{yaml,tpl}', { cwd: resolve(chartDir, 'templates') });
    expect(templates.length).toBeGreaterThan(5);
    const stamping = templates.filter((f) =>
      new RegExp(`^\\s*-\\s*name:\\s*"?${name}"?\\s*$`, 'm').test(
        readFileSync(resolve(chartDir, 'templates', f), 'utf8'),
      ),
    );
    expect(stamping).toEqual([]);
  });
});
