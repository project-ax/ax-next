// Guard: the @project-ax/eslint-plugin-ui rules are wired into the repo lint
// for packages/channel-web, with today's violations frozen in
// eslint-suppressions.json (ESLint bulk suppressions).
//
// The Node API (`ESLint#lintText`) does NOT apply suppressions, so the first
// three tests lint NEW file paths and see the raw rule behaviour. The last one
// drives the real CLI, which is where suppressions (and the "unused
// suppression" failure that keeps the ratchet one-way) live.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('ui lint wiring', () => {
  let eslint;
  beforeAll(() => {
    eslint = new ESLint({ cwd: REPO_ROOT });
  }, 120_000);

  async function lint(code, filePath) {
    const [res] = await eslint.lintText(code, { filePath: join(REPO_ROOT, filePath) });
    return res.messages;
  }

  it('new channel-web file with a div errors', async () => {
    const messages = await lint(
      'export const X = () => <div/>;',
      'packages/channel-web/src/components/NewThing.tsx',
    );
    const hit = messages.find((m) => m.ruleId === 'ax-ui/no-raw-elements');
    expect(hit).toBeDefined();
    expect(hit.severity).toBe(2);
  });

  it('shadcn internals are exempt', async () => {
    const messages = await lint(
      'export const X = () => <div className="p-[3px]"/>;',
      'packages/channel-web/src/components/ui/button.tsx',
    );
    expect(messages.filter((m) => m.ruleId?.startsWith('ax-ui/'))).toEqual([]);
  });

  it('cross-plugin import still errors in channel-web', async () => {
    const messages = await lint(
      "import x from '@ax/agents/src/x';\nexport const y = x;\n",
      'packages/channel-web/src/components/NewThing.tsx',
    );
    expect(
      messages.some(
        (m) => m.ruleId === '@typescript-eslint/no-restricted-imports' && m.severity === 2,
      ),
    ).toBe(true);
  });

  it('unpruned suppressions fail lint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-suppress-'));
    const loc = join(dir, 'eslint-suppressions.json');
    // A real channel-web file with no ax-ui violations, so the suppression can never occur.
    const file = 'packages/channel-web/src/main.tsx';
    writeFileSync(loc, JSON.stringify({ [file]: { 'ax-ui/no-classname': { count: 1 } } }));
    const r = spawnSync(
      'pnpm',
      ['exec', 'eslint', file, '--suppressions-location', loc],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('There are suppressions left that do not occur anymore');
  }, 120_000);
});
