// Guard: channel-web's vite mock backend must resolve its scratch data
// directory (`.mock-data/`, 6 seed JSONs: users/agents/teams/mcp-servers/
// sessions/messages) relative to the PACKAGE, never to `process.cwd()`.
//
// Why this exists. `vite.config.ts` used to call
// `mockMiddleware(resolve(process.cwd(), '.mock-data'))`, and
// `mock/server.ts`'s own default fell back to the same
// `resolve(process.cwd(), '.mock-data')`. Both write 6 untracked JSON files
// on first request. `process.cwd()` is whatever directory the process was
// LAUNCHED from — not necessarily `packages/channel-web/`, which is the only
// place a `.gitignore` entry for `.mock-data/` existed. Launch the dev server
// (or call `createMockHandler()` with no `dataDir`) from the repo root and the
// 6 JSONs land there, untracked and ungitignored — TASK-249's builder
// reported nearly committing exactly this (TASK-376).
//
// The fix anchors both call sites to the package directory via `__dirname` /
// `import.meta.url`, so the write location no longer depends on the caller's
// shell cwd. This guard is a TRIPWIRE against reintroducing a
// `process.cwd()`-relative default for that path.
//
// Lives in scripts/__tests__/, which CI's `pnpm test:scripts` runs
// UNCONDITIONALLY (it is not gated on affected packages).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CHECKED_FILES = [
  'packages/channel-web/vite.config.ts',
  'packages/channel-web/mock/server.ts',
];

/**
 * Does this source resolve `.mock-data` against `process.cwd()`? Matches the
 * exact shape that caused the incident, without trying to parse JavaScript —
 * a false positive here costs one comment, a false negative costs another
 * "nearly committed 6 JSONs" surprise.
 */
function resolvesMockDataAgainstCwd(src) {
  return /process\.cwd\(\)\s*,\s*['"`]\.mock-data['"`]/.test(src);
}

describe('channel-web mock-data dir is never resolved against process.cwd()', () => {
  it('checks the two known call sites (the scan itself must not be vacuous)', () => {
    for (const rel of CHECKED_FILES) {
      expect(() => readFileSync(join(REPO_ROOT, rel), 'utf8')).not.toThrow();
    }
  });

  it('never resolves .mock-data relative to process.cwd()', () => {
    const offenders = [];
    for (const rel of CHECKED_FILES) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      if (resolvesMockDataAgainstCwd(src)) offenders.push(rel);
    }

    expect(
      offenders,
      'These files resolve the channel-web mock backend\'s `.mock-data` ' +
        'scratch dir against process.cwd(), which writes 6 untracked seed ' +
        'JSONs (users/agents/teams/mcp-servers/sessions/messages) wherever ' +
        'the process happens to be launched from — including the repo root. ' +
        'Anchor the path to the package directory instead (__dirname / ' +
        'import.meta.url), as vite.config.ts already does for its `@` alias.',
    ).toEqual([]);
  });

  it('the root .gitignore still covers .mock-data/ as a fail-safe', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^\.mock-data\/$/m);
  });
});

/** Sanity: the matcher recognises the exact shape that caused the incident. */
describe('resolvesMockDataAgainstCwd matcher', () => {
  it('matches the vite.config.ts shape that caused the incident', () => {
    expect(
      resolvesMockDataAgainstCwd(
        "mockMiddleware(resolve(process.cwd(), '.mock-data'))",
      ),
    ).toBe(true);
  });

  it('matches the mock/server.ts default-fallback shape', () => {
    expect(
      resolvesMockDataAgainstCwd(
        "const dir = dataDir ?? resolve(process.cwd(), '.mock-data');",
      ),
    ).toBe(true);
  });

  it('does not match a __dirname-anchored resolve', () => {
    expect(
      resolvesMockDataAgainstCwd(
        "mockMiddleware(resolve(__dirname, '.mock-data'))",
      ),
    ).toBe(false);
  });

  it('does not match an unrelated process.cwd() usage', () => {
    expect(
      resolvesMockDataAgainstCwd("const cfg = resolve(process.cwd(), 'ax.config.mjs');"),
    ).toBe(false);
  });
});
