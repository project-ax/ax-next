// Guard: the chart suite's helm dependency fetch lives in exactly ONE file,
// and it is hoisted out of per-file test hooks.
//
// Why this exists (TASK-316). `deploy/charts/ax-next/__tests__/` had THREE
// copies of the same `helmRepoSync()` — one each in render.test.ts,
// blob-backend.test.ts and env-shape.test.ts — every copy running
// `helm repo add --force-update bitnami` + `helm dependency build <chartDir>`
// from its own `beforeAll`, and every copy wrapped in a 3x retry. vitest runs
// test files in parallel, so THREE writers ran at once and could make up to NINE
// `--force-update` write attempts in total (3 files x 3 sequential retries)
// against the same shared paths:
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
// own hook reintroduces the exact failure, and nothing about a green — or even
// a slow-but-passing — CI run would say so. Same posture as the other drift
// guards here (autoship-skill-shell-hazards.test.js,
// eslint-ignores-worktrees.test.js) and it runs under `pnpm test:scripts` with
// no network, no helm, and no build.
//
// Only files that actually SPAWN are inspected. helm-deps.test.ts asserts on
// the same argv arrays and names `--force-update` in the assertion that the
// flag is gone; a matcher that keyed on the literals alone would flag the test
// that proves the fix. Requiring a spawn call in the same file is what
// separates "runs the fetch" from "talks about it" — and a copy-pasted
// helmRepoSync always brings its `spawnSync` along.
//
// The last two assertions are the over-guard half, and they matter as much as
// the first: one fails if the scan silently stops finding the files it is
// supposed to police (a vacuously green guard is worse than no guard), and one
// pins the trap the parent card was rescoped over — "just raise hookTimeout".
// A longer timeout only lets concurrent writers retry longer; a lossy write
// does not get less lossy with more time.

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
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(TESTS_DIR);
  return out.sort();
}

/**
 * Executable text only — the explanatory comments name these commands too.
 *
 * `//` comments go FIRST, and BOTH whole-line and trailing ones. The other
 * order is a trap, and it bit this guard while it was being written:
 * env-shape.test.ts has a line comment reading `walks /setup/* after install`,
 * whose `/*` opened a bogus block comment that swallowed 57 lines of real code —
 * including the file's only `spawnSync` — and quietly dropped the file out of
 * the scan. A trailing `// … /*` is the same hazard, so the first draft's
 * line-anchored regex only closed half of it.
 *
 * The `[^:]` guard keeps `https://…` intact; that is a heuristic, not a lexer,
 * and it is the right size of tool for deciding whether a test file shells out.
 */
function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Does this source shell out at all? */
function spawnsAnything(src) {
  return /\b(?:spawnSync|execFileSync|execSync|spawn|execFile)\s*\(/.test(src);
}

/**
 * Does it run the repo/dependency fetch (as opposed to `helm template`)?
 *
 * Three spellings, because a reintroduction will not necessarily be a verbatim
 * copy-paste: an argv array with literal verbs (what the old helmRepoSync
 * used), an argv array whose verb is a variable (`['repo', op]`), and a shell
 * string handed to `execSync`.
 */
function spawnsHelmFetch(src) {
  return (
    /['"]repo['"]\s*,\s*(?:['"](?:add|update)['"]|[A-Za-z_$])/.test(src) ||
    /['"]dependency['"]\s*,/.test(src) ||
    /helm\s+repo\s+(?:add|update)\b/.test(src) ||
    /helm\s+dependency\s+build\b/.test(src)
  );
}

describe('chart helm dependency fetch has a single source', () => {
  const files = chartTsFiles();
  const spawning = files
    .map((f) => ({ path: f, src: stripComments(readFileSync(f, 'utf8')) }))
    .filter((f) => spawnsAnything(f.src));
  const rel = (p) => relative(REPO_ROOT, p);

  it(`only ${SYNC_MODULE} spawns the helm repo/dependency fetch`, () => {
    const offenders = spawning.filter((f) => spawnsHelmFetch(f.src)).map((f) => rel(f.path));
    expect(offenders).toEqual([rel(join(TESTS_DIR, SYNC_MODULE))]);
  });

  // `--force-update` only ever existed to make a REPEATED `helm repo add`
  // idempotent. Repeating it concurrently is the bug; with one fetch per run
  // there is nothing to force, and the flag reappearing in a spawning file is
  // the tell that the per-file copies came back.
  it('no chart source passes --force-update to helm', () => {
    const offenders = spawning
      .filter((f) => f.src.includes('--force-update'))
      .map((f) => rel(f.path));
    expect(offenders).toEqual([]);
  });

  // The fetch must run before any worker starts, once for the whole run — not
  // in a per-file hook, where "once per file" is what created the contention.
  it('vitest.config.ts hoists the fetch into globalSetup', () => {
    const cfg = readFileSync(join(CHART_DIR, 'vitest.config.ts'), 'utf8');
    expect(cfg).toMatch(/globalSetup:/);
    expect(cfg).toMatch(/global-setup/);
  });

  // One production caller. Test files may call it freely (they inject a fake
  // spawner, and the worker interlock in helm-deps.ts stops a real fetch either
  // way) — a NON-test chart file calling it is a second entry point into the
  // run-level fetch, which is the shape of the original bug.
  it('only global-setup.ts invokes the fetch outside a test file', () => {
    const callers = files
      // Not a test file, and not the module that DECLARES the function — the
      // declaration matches any call-shaped pattern.
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith(SYNC_MODULE))
      .filter((f) =>
        /\bensureChartDependencies\s*\(/.test(stripComments(readFileSync(f, 'utf8'))),
      )
      .map((f) => relative(TESTS_DIR, f));
    expect(callers).toEqual(['global-setup.ts']);
  });

  // Over-guard 1: a broken walk (renamed directory, changed extension filter)
  // or a too-narrow `spawnsAnything` would make every assertion above pass
  // while checking nothing. These four are the files the guard is FOR.
  it('actually scanned the files it is meant to police', () => {
    const spawningNames = spawning.map((f) => relative(TESTS_DIR, f.path));
    for (const name of [
      SYNC_MODULE,
      'render.test.ts',
      'blob-backend.test.ts',
      'env-shape.test.ts',
    ]) {
      expect(spawningNames, `${name} must be scanned as a spawning file`).toContain(name);
    }
    // And the matchers must still recognise a fetch when they see one — in each
    // spelling a reintroduction could plausibly take, not just a verbatim
    // copy-paste of the deleted helper.
    for (const snippet of [
      "spawn(helm, ['dependency', 'build', chartDir])",
      "spawn(helm, ['repo', 'add', '--force-update', 'bitnami', URL])",
      "spawn(helm, ['repo', op, name])",
      "execSync('helm repo update bitnami')",
      "execSync(`helm dependency build ${dir}`)",
    ]) {
      expect(spawnsHelmFetch(snippet), snippet).toBe(true);
    }
    // …and must not fire on a render, which every chart test file does.
    expect(spawnsHelmFetch("spawn(helm, ['template', 'ax-test', chartDir])")).toBe(false);

    // Comment stripping must survive a TRAILING `//` that contains `/*`. That
    // is the half of the hazard the first draft left open: the block-comment
    // pass would otherwise open a bogus comment here and eat the spawn below.
    const trailing = "foo(); // see /* note\nspawn(helm, ['dependency', 'build', d])";
    expect(spawnsAnything(stripComments(trailing))).toBe(true);
    expect(spawnsHelmFetch(stripComments(trailing))).toBe(true);
    // A URL in code must not be mistaken for the start of a comment.
    expect(stripComments("const u = 'https://charts.bitnami.com/bitnami';")).toContain(
      'charts.bitnami.com',
    );
  });

  // Over-guard 2: the rescoped trap. `hookTimeout` above 30s reads like a fix
  // and is not one — see the header. Absent is correct today (no helm work
  // happens in a hook any more); present-and-larger is the regression.
  it('does not paper over the race by raising hookTimeout past 30s', () => {
    const cfg = readFileSync(join(CHART_DIR, 'vitest.config.ts'), 'utf8');
    const m = /hookTimeout:\s*([\d_]+)/.exec(cfg);
    if (m) expect(Number(m[1].replaceAll('_', ''))).toBeLessThanOrEqual(30_000);
  });
});
