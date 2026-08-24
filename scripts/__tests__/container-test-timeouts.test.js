// Guard: a package whose tests start a real container must declare its own test
// and hook budgets, and must never budget a BARE hook below what a hook in the
// same package already declares out loud.
//
// Why this exists (TASK-323). vitest's defaults are `testTimeout: 5_000` and
// `hookTimeout: 10_000`. A suite that boots a Postgres testcontainer blows past
// both under monorepo-wide contention, and `Test timed out in 5000ms` is the only
// failure shape actually observed in CI across 100 push-to-main runs. Eight
// packages had already learned this the expensive way and set 60s budgets in
// their own `vitest.config.ts` (see `packages/agents/vitest.config.ts` and
// TASK-73 / TASK-103 / PR #407); thirteen more were still running on the
// defaults, and there was nothing to stop the fourteenth from arriving.
//
// The second assertion is the subtler half, and it is the one the card was
// really about. An explicit timeout ARGUMENT on a hook —
//
//     beforeAll(async () => { ... }, 120_000);
//
// overrides the config. So the config's `hookTimeout` governs exactly the hooks
// that DON'T carry an argument — in practice, the teardowns. 94 test files in
// this repo declare a budget on `beforeAll` and leave the sibling `afterAll`
// bare, which is a file quietly disagreeing with itself: startup may take two
// minutes, but tearing the same container down gets ten seconds. Pinning the
// config to the largest budget the package already declares makes every bare
// hook inherit at least what its own file asks for, without editing 94 call
// sites. That is the invariant below, and it is why this asserts `>=` against a
// value scanned out of the sources rather than against a number typed here —
// a file that raises its own `beforeAll` to 180s should redden this guard until
// the config keeps up.
//
// What this guard does NOT do: police the size of those budgets. A budget too
// small for legitimate work is a bug; one raised past a genuine hang is a mask.
// Neither is decidable from source shape, so this file deliberately takes no
// position on 60 vs 120 and only insists the two numbers in a package agree.
//
// Runs under `pnpm test:scripts` with no network, no Docker, and no build.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where publishable packages live. Each child dir is one package. */
const PACKAGE_ROOTS = ['packages', 'presets'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-web', 'build', 'coverage']);

/**
 * A test source that starts a container.
 *
 * Two spellings: the testcontainers constructor (`new PostgreSqlContainer(...)`,
 * `new GenericContainer(...)`) and this repo's shared helper
 * (`startPostgresContainer(...)` from `@ax/test-harness`). Matching
 * `[A-Za-z]*Container` rather than naming PostgreSql is the point — adding
 * `@testcontainers/redis` should pull that package into this guard's scope
 * automatically instead of slipping past it.
 *
 * Only `.ts`/`.tsx` are scanned. `packages/memory-strata/test/bench/` carries a
 * benchmark corpus whose JSON *document text* contains testcontainers code as
 * DATA; scanning it would invent a container package out of a fixture.
 */
const STARTS_CONTAINER = /new\s+[A-Za-z]*Container\s*\(|\bstartPostgresContainer\s*\(/;

/**
 * A hook that declares its own timeout: `beforeAll(async () => { ... }, 60_000);`
 *
 * The body match is non-greedy, so in a file where a bare hook is followed by a
 * timed one this can attribute the timed hook's argument to the bare hook above
 * it. That is harmless here and deliberately not worked around: the assertion
 * consumes the MAXIMUM over the package, and mis-attributing a value between two
 * hooks in the same package cannot change a maximum. It only needs to find the
 * set of budgets, not whose they are.
 */
const HOOK_WITH_TIMEOUT =
  /\b(?:beforeAll|afterAll|beforeEach|afterEach)\s*\([\s\S]*?\n\}\s*,\s*(\d[\d_]*)\s*\)\s*;/g;

/**
 * A poll loop with an ITERATION budget instead of a wall-clock one:
 *
 *     for (let i = 0; i < 200 && contexts.length === 0; i++) { await sleep(10); }
 *
 * This is the one failure shape no `testTimeout` can rescue. 200 × 10ms is a
 * fixed ~2s ceiling; when a loaded CI box needs 2.5s the loop simply gives up
 * and the `expect` on the next line fails with a message about the condition
 * rather than about the wait. `vi.waitFor(..., { timeout, interval })` is the
 * fix — it budgets real time, and it reports as a timeout when it runs out.
 *
 * Scoped to the `i = 0; i < N &&` shape because the `&&` is what makes it a
 * POLL rather than an ordinary bounded loop over N items. A `while` spelling of
 * the same defect would slip past this; nothing in the tree uses one today.
 */
const ITERATION_POLL = /for\s*\(\s*(?:let|var)\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*\d+\s*&&/;

/** Every `.ts`/`.tsx` file under `dir`, recursively, skipping build output. */
function sourceFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every package dir under the package roots (one level down). */
function allPackages() {
  const out = [];
  for (const root of PACKAGE_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      out.push({ name: `${root}/${entry.name}`, dir: join(abs, entry.name) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read a numeric `test.<key>` from a vitest config, tolerating `_` separators.
 * Returns `undefined` when the key is absent — which is the failure this guard
 * is chiefly looking for, so absent and zero must stay distinguishable.
 */
function readTimeout(configText, key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*(\\d[\\d_]*)`).exec(configText);
  return m ? Number(m[1].replace(/_/g, '')) : undefined;
}

/** Packages that start a container somewhere in their sources. */
const containerPackages = allPackages()
  .map((pkg) => {
    const files = sourceFiles(pkg.dir);
    const starters = files.filter((f) => STARTS_CONTAINER.test(readFileSync(f, 'utf8')));
    if (starters.length === 0) return undefined;

    let maxDeclaredHookTimeout = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(HOOK_WITH_TIMEOUT)) {
        maxDeclaredHookTimeout = Math.max(
          maxDeclaredHookTimeout,
          Number(m[1].replace(/_/g, '')),
        );
      }
    }

    const configPath = join(pkg.dir, 'vitest.config.ts');
    return {
      ...pkg,
      files,
      configPath,
      configText: existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined,
      maxDeclaredHookTimeout,
    };
  })
  .filter(Boolean);

describe('container-starting packages declare their own timeouts (TASK-323)', () => {
  it('finds the container packages at all — a scan that matches nothing would pass everything below', () => {
    // Vacuity guard. Every assertion in this file is a `for (const pkg of
    // containerPackages)`, so an empty scan makes all of them trivially green.
    // 21 as this is written (20 under packages/, plus presets/k8s). The floor is
    // deliberately loose — this is here to catch the scan BREAKING, not to
    // freeze the count.
    expect(containerPackages.length).toBeGreaterThanOrEqual(15);
  });

  it('each has a vitest.config.ts setting both testTimeout and hookTimeout', () => {
    const missing = [];
    for (const pkg of containerPackages) {
      if (pkg.configText === undefined) {
        missing.push(`${pkg.name}: no vitest.config.ts (inherits 5s/10s defaults)`);
        continue;
      }
      const t = readTimeout(pkg.configText, 'testTimeout');
      const h = readTimeout(pkg.configText, 'hookTimeout');
      if (t === undefined) missing.push(`${pkg.name}: no testTimeout (inherits vitest's 5s)`);
      if (h === undefined) missing.push(`${pkg.name}: no hookTimeout (inherits vitest's 10s)`);
    }
    expect(missing).toEqual([]);
  });

  it("each package's hookTimeout is at least the largest timeout its own hooks declare", () => {
    const inconsistent = [];
    for (const pkg of containerPackages) {
      if (pkg.configText === undefined) continue; // reported by the test above
      const h = readTimeout(pkg.configText, 'hookTimeout');
      if (h === undefined) continue; // ditto
      if (h < pkg.maxDeclaredHookTimeout) {
        inconsistent.push(
          `${pkg.name}: hookTimeout ${h} < ${pkg.maxDeclaredHookTimeout} declared by a hook ` +
            `in this package — a bare afterAll here gets less budget than its own file's beforeAll asks for`,
        );
      }
    }
    expect(inconsistent).toEqual([]);
  });
});

describe('waits are time-budgeted, not iteration-budgeted (TASK-323)', () => {
  const testSources = allPackages()
    .flatMap((pkg) => sourceFiles(pkg.dir))
    .filter((f) => /\.test\.tsx?$/.test(f));

  it('finds test sources at all', () => {
    // Same vacuity guard as above: the assertion below is a filter over this
    // list, so an empty list would make it pass for the wrong reason.
    expect(testSources.length).toBeGreaterThan(100);
  });

  it('no test polls a condition on a fixed iteration count', () => {
    const offenders = testSources
      .filter((f) => ITERATION_POLL.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f));
    // Use vi.waitFor(cond, { timeout, interval }) instead — see ITERATION_POLL above.
    expect(offenders).toEqual([]);
  });
});
