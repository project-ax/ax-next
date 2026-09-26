// TASK-359: the agent-workspace switch had three names — the chart value
// `channelWeb.agentWorkspace`, the env var `AX_AGENT_WORKSPACE_PREVIEW`, and
// the client feature `agentWorkspacePreview`. It now has one:
// `agentWorkspace`, spelled `AX_AGENT_WORKSPACE` in the environment.
//
// The retired env name gets exactly ONE compatibility read, in the CLI's
// `serve` command, for one release. These guards keep it that way:
//
//   1. no production source spells the retired client/config name at all;
//   2. only serve.ts reads the retired env name, and no chart template
//      stamps it;
//   3. the compat read cannot outlive the chart version it was promised to —
//      bumping Chart.yaml past 0.0.1 fails here until serve.ts drops it.
//
// Source scans, no helm — runs everywhere.

import { globSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const chartDir = resolve(here, '..');
const repoRoot = resolve(here, '../../../..');
const serveSourcePath = resolve(repoRoot, 'packages/cli/src/commands/serve.ts');

const RETIRED_ENV = 'AX_AGENT_WORKSPACE_PREVIEW';
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

describe('agent workspace switch has one name (TASK-359)', () => {
  it(`no production source spells the retired field name ${RETIRED_FIELD}`, () => {
    const hits = productionSources().filter((f) =>
      readFileSync(resolve(repoRoot, f), 'utf8').includes(RETIRED_FIELD),
    );
    expect(hits).toEqual([]);
  });

  it(`only serve.ts mentions the retired env name ${RETIRED_ENV}`, () => {
    const hits = productionSources().filter((f) =>
      readFileSync(resolve(repoRoot, f), 'utf8').includes(RETIRED_ENV),
    );
    expect(hits).toEqual([relative(repoRoot, serveSourcePath)]);
  });

  it('no chart template stamps the retired env name', () => {
    const templates = globSync('**/*.{yaml,tpl}', { cwd: resolve(chartDir, 'templates') });
    expect(templates.length).toBeGreaterThan(5);
    const stamping = templates.filter((f) =>
      new RegExp(`^\\s*-\\s*name:\\s*"?${RETIRED_ENV}"?\\s*$`, 'm').test(
        readFileSync(resolve(chartDir, 'templates', f), 'utf8'),
      ),
    );
    expect(stamping).toEqual([]);
  });

  it('the retired-name compat read is gone by the first chart release after 0.0.1', () => {
    const chart = load(readFileSync(resolve(chartDir, 'Chart.yaml'), 'utf8')) as {
      version?: unknown;
    };
    const serveReadsRetired = new RegExp(`\\benv\\.${RETIRED_ENV}\\b`).test(
      readFileSync(serveSourcePath, 'utf8'),
    );
    if (serveReadsRetired) {
      expect(
        chart.version,
        `${RETIRED_ENV} was promised to stop being read in the first chart release after ` +
          '0.0.1 (values.yaml says so). Delete the compat read in serve.ts ' +
          '(applyRetiredEnvNames), this guard, and the UPGRADING note in values.yaml.',
      ).toBe('0.0.1');
    }
  });
});
