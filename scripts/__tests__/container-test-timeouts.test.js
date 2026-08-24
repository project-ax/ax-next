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
// that DON'T carry an argument — in practice, the teardowns. 108 test files in
// this repo (of 751) contain at least one hook with an explicit timeout AND at
// least one bare `afterAll` — a file quietly disagreeing with itself: startup
// may take two minutes, but tearing the same container down gets ten seconds.
// Pinning the config to the largest budget the package already declares makes
// every bare hook inherit at least what its own file asks for, without editing
// those 108 files. That is the invariant below, and it is why this asserts `>=` against a
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
 * Two things about this pattern, and the second one bit.
 *
 * The body match is non-greedy, so in a file where a bare hook is followed by a
 * timed one this can attribute the timed hook's argument to the bare hook above
 * it. That IS harmless and is deliberately not worked around: the assertion
 * consumes the MAXIMUM over the package, and mis-attributing a value between two
 * hooks in the same package cannot change a maximum.
 *
 * It captures a NUMERIC literal only, on a multi-line hook body. Three other
 * spellings exist and are NOT read by this pattern:
 *
 *   1. a named constant — `}, TIMEOUT_MS)`. A live idiom elsewhere in this repo:
 *      `agent-runner-core` uses `REAL_GIT_TIMEOUT_MS`, `agent-claude-sdk-runner`
 *      uses `E2E_TIMEOUT_MS`. Neither package starts a container.
 *   2. a single-line hook — `beforeAll(() => { ... }, 120000);` with no newline
 *      before the `}`.
 *   3. a brace-less arrow body — `beforeAll(() => setup(), 120000);`.
 *
 * `UNREADABLE_HOOK_TIMEOUT` below covers **(1) only**, and being precise about
 * that is the point: it shares this pattern's `\n\s*\}` prefix, so (2) and (3)
 * are matched by NEITHER regex and remain silent blind spots of exactly the kind
 * described next. They are stated here rather than implied away, the same way
 * `ITERATION_POLL` states its own gaps — an earlier draft of this comment
 * claimed all three were covered, which was wrong, and a confidently wrong
 * comment in a guard is the failure this whole file exists to make harder.
 * None of the three is used by a container package today.
 *
 * The closing brace is `\n\s*\}` — indentation-tolerant — and the leading `\s*`
 * is load-bearing. It was `\n\}` in this guard's first draft, which only matched
 * hooks whose closing brace sits at column 0, i.e. top-level ones. Every hook
 * nested inside a `describe(...)` block is indented and was therefore invisible,
 * and that is a categorically worse bug than mis-attribution: a MISSED hook
 * LOWERS `maxDeclaredHookTimeout`, so the guard cheerfully passes a config that
 * is too low. It did exactly that on `packages/cli`, whose describe-nested
 * `beforeAll(..., 120000)` in `e2e.test.ts` went unseen while the config sat at
 * 60_000 — the guard was green on the very violation it exists to catch, in the
 * PR that introduced it. If you touch this regex, re-check it against a
 * describe-nested hook first.
 */
const HOOK_WITH_TIMEOUT =
  /\b(?:beforeAll|afterAll|beforeEach|afterEach)\s*\([\s\S]*?\n\s*\}\s*,\s*(\d[\d_]*)\s*\)\s*;/g;

/**
 * A hook that declares a timeout this file CANNOT evaluate — a named constant
 * rather than a numeric literal (`}, TIMEOUT_MS)`).
 *
 * This exists because of how this guard's first version failed. It could not see
 * describe-nested hooks, and a hook it cannot see contributes 0 to the package
 * maximum, so the guard PASSES a config that is too low — it went green on
 * `packages/cli`, the exact violation it was written to catch. Every remaining
 * blind spot fails the same way. So where this shape is recognisable, the guard
 * fails loudly and asks to be extended rather than quietly reading the budget as
 * absent. Fail closed: a guard that under-reports is worse than no guard,
 * because it also reports success.
 *
 * Scope, precisely: this covers the NAMED-CONSTANT spelling on a multi-line hook
 * body. Single-line hooks and brace-less arrows are NOT covered — see
 * HOOK_WITH_TIMEOUT above — so for those two shapes this assertion is green
 * either way and buys nothing. Closing them means dropping the `\n` anchor,
 * which widens the false-positive surface described next; that trade wasn't
 * worth making for shapes no container package uses.
 *
 * Known false positive: the `[\s\S]*?` is not anchored to the hook's own call,
 * so a match can start at a hook keyword and run PAST it to a later
 * `\n}, <identifier>);` — an unrelated two-argument call such as
 * `setTimeout(() => { ... }, DELAY_MS)` reads as an unreadable hook timeout. No
 * file in any of the 21 container packages currently has both, so it cannot
 * mis-fire today. If it ever does, the fix is this regex, NOT the config: check
 * that the captured identifier is really a hook's timeout before believing the
 * message below.
 */
const UNREADABLE_HOOK_TIMEOUT =
  /\b(?:beforeAll|afterAll|beforeEach|afterEach)\s*\([\s\S]*?\n\s*\}\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*;/g;

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
 * The `&&` is the load-bearing part of this pattern: a loop that exits early on a
 * condition is the shape a poll takes. It is a heuristic and not a definition —
 * `agent-aisdk-runner/src/compaction/compactor.ts` has a bounded synchronous
 * traversal whose `&&` is a null-guard, and it would match. That costs nothing
 * only because this scan is restricted to `*.test.ts*` files; widen the scan and
 * the heuristic starts producing false positives. The bound itself is matched loosely (`< N`, `<= N`, or a named
 * `< MAX` / `< XS.length`) because a poll spelled with a constant is the same
 * defect as one spelled with a literal.
 *
 * Known gaps, stated rather than implied: a `while` spelling, and a flipped
 * condition order (`cond && i < N`), both slip past this. Nothing in the tree
 * uses either today. Note also that a fake-timer loop is NOT this defect —
 * `channel-web` drives several `for` loops with `vi.advanceTimersByTimeAsync`,
 * which are deterministic and race nothing; they are excluded here only because
 * they carry no `&&`, so if you widen this pattern, check them again.
 */
const ITERATION_POLL =
  /for\s*\(\s*(?:let|var)\s+\w+\s*=\s*\w+\s*;\s*\w+\s*<=?\s*[\w.]+\s*&&/;

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

  it('no container package declares a hook timeout this guard cannot read', () => {
    // Fail closed. See UNREADABLE_HOOK_TIMEOUT: a budget this file cannot parse
    // is counted as absent, which lowers the package maximum and makes the
    // assertion below pass a config that is too low. Covers the named-constant
    // spelling only — single-line hooks and brace-less arrows are documented,
    // uncovered gaps, not silent ones.
    //
    // If this reddens: first check the captured identifier really IS a hook's
    // timeout (the regex can escape past a hook into an unrelated two-argument
    // call). If it is, teach HOOK_WITH_TIMEOUT the new spelling — do not relax
    // this assertion, and do not lower the config to match.
    const unreadable = [];
    for (const pkg of containerPackages) {
      for (const f of pkg.files) {
        for (const m of readFileSync(f, 'utf8').matchAll(UNREADABLE_HOOK_TIMEOUT)) {
          unreadable.push(`${relative(REPO_ROOT, f)}: hook timeout \`${m[1]}\` is not a numeric literal`);
        }
      }
    }
    expect(unreadable).toEqual([]);
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
