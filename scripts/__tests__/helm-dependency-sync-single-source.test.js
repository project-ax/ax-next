// Guard: the chart suite's helm dependency fetch lives in exactly ONE file,
// and it is hoisted out of per-file test hooks.
//
// Why this exists (TASK-316). `deploy/charts/ax-next/__tests__/` had THREE
// copies of the same `helmRepoSync()` — one each in render.test.ts,
// blob-backend.test.ts and env-shape.test.ts — every copy running
// `helm repo add --force-update bitnami` + `helm dependency build <chartDir>`
// from its own `beforeAll`, and every copy wrapped in a 3x retry. vitest runs
// test files in parallel, so that was up to NINE concurrent `--force-update`
// writes to the same shared paths:
//
//   ~/.cache/helm/repository/bitnami-index.yaml   (the downloaded index)
//   ~/.config/helm/repositories.yaml              (the repo registration)
//   deploy/charts/ax-next/charts/ + Chart.lock    (the built subchart)
//
// Those writes are lossy: one writer wins and the losers read a half-written
// (often empty) index — exactly the "error loading bitnami-index.yaml: empty
// index.yaml file" that the retry was written to paper over. So the retry
// AMPLIFIED the race it was meant to fix, each failure firing another
// `--force-update` into the same contended files. main CI went red at 94d27490
// on two `Hook timed out in 30000ms` failures (blob-backend, env-shape) and
// halted the auto-ship merge queue.
//
// The copies are the bug, which makes this a source-shape guard rather than a
// timing one: a fourth chart test file that copy-pastes the fetch back into its
// own hook reintroduces the exact failure, and nothing about a green (or even
// a slow-but-passing) CI run would say so. Same posture as the other drift
// guards here — autoship-skill-shell-hazards.test.js,
// eslint-ignores-worktrees.test.js — and it runs under `pnpm test:scripts`
// with no network, no helm, and no build.
//
// The last two assertions are the over-guard half, and they matter as much as
// the first: one fails if the scan silently stops finding files (a vacuously
// green guard is worse than no guard), and one pins the trap that the parent
// card was rescoped over — "just raise hookTimeout". A longer timeout only lets
// concurrent writers retry longer; a lossy write does not get less lossy with
// more time.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHART_DIR = join(REPO_ROOT, 'deploy', 'charts', 'ax-next');
const TESTS_DIR = join(CHART_DIR, '__tests__');

/** The single sanctioned home for the fetch. */
const SYNC_MODULE = 'helm-deps.ts';

/** Every `.ts` file under the chart's test directory, recursively. */
function chartTsFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  walk(TESTS_DIR);
  return out.sort();
}

/**
 * Does this source spawn the helm fetch? Matches the argv arrays, not prose —
 * the explanatory comments in helm-deps.ts and this file both *mention*
 * `helm repo add`, and a guard that tripped on a comment would be useless.
 */
function spawnsHelmFetch(src) {
  const stripped = src
    // Block and line comments, so only executable text is scanned.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const repoAdd = /['"]repo['"]\s*,\s*['"](?:add|update)['"]/.test(stripped);
  const depBuild = /['"]dependency['"]\s*,\s*['"]build['"]/.test(stripped);
  return repoAdd || depBuild;
}

describe('chart helm dependency fetch has a single source', () => {
  const files = chartTsFiles();

  it(`only ${SYNC_MODULE} spawns the helm repo/dependency fetch`, () => {
    const offenders = files
      .filter((f) => spawnsHelmFetch(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f));
    expect(offenders).toEqual([
      relative(REPO_ROOT, join(TESTS_DIR, SYNC_MODULE)),
    ]);
  });

  // `--force-update` only ever existed to make a REPEATED `helm repo add`
  // idempotent. Repeating it concurrently is the bug; with one fetch per run
  // there is nothing to force, and the flag reappearing is the tell that the
  // per-file copies came back.
  it('no chart test source passes --force-update to helm', () => {
    const offenders = files
      .filter((f) => readFileSync(f, 'utf8').includes("'--force-update'"))
      .map((f) => relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });

  // The fetch must run before any worker starts, once for the whole run — not
  // in a per-file hook, where "once per file" is what created the contention.
  it('vitest.config.ts hoists the fetch into globalSetup', () => {
    const cfg = readFileSync(join(CHART_DIR, 'vitest.config.ts'), 'utf8');
    expect(cfg).toMatch(/globalSetup:/);
    expect(cfg).toMatch(/global-setup/);
  });

  // Over-guard 1: a broken walk (renamed directory, changed extension filter)
  // would make every assertion above pass while checking nothing.
  it('actually scanned the chart test sources', () => {
    const names = files.map((f) => relative(TESTS_DIR, f));
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names).toContain(SYNC_MODULE);
    expect(names).toContain('render.test.ts');
    expect(names).toContain('blob-backend.test.ts');
    expect(names).toContain('env-shape.test.ts');
    // And the matcher must still recognise a fetch when it sees one.
    expect(
      spawnsHelmFetch("spawnSync(helm, ['dependency', 'build', chartDir])"),
    ).toBe(true);
    expect(spawnsHelmFetch('// helm dependency build runs once')).toBe(false);
  });

  // Over-guard 2: the rescoped trap. `hookTimeout` above 30s reads like a fix
  // and is not one — see the header. Absent is fine (no helm work happens in a
  // hook any more); present-and-larger is the regression.
  it('does not paper over the race by raising hookTimeout past 30s', () => {
    const cfg = readFileSync(join(CHART_DIR, 'vitest.config.ts'), 'utf8');
    const m = /hookTimeout:\s*([\d_]+)/.exec(cfg);
    if (m) {
      expect(Number(m[1].replaceAll('_', ''))).toBeLessThanOrEqual(30_000);
    }
  });
});
