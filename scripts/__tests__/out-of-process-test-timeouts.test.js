// Guard: a package whose tests do REAL OUT-OF-PROCESS WORK must declare its own
// test and hook budgets, and must never budget a BARE hook below what a hook in
// the same package already declares out loud.
//
// Two cards built this file, and the second one is why it is no longer called
// `container-test-timeouts.test.js`.
//
// TASK-323 wrote it. vitest's defaults are `testTimeout: 5_000` and
// `hookTimeout: 10_000`. A suite that boots a Postgres testcontainer blows past
// both under monorepo-wide contention, and `Test timed out in 5000ms` is the
// only failure shape actually observed in CI across 100 push-to-main runs. Eight
// packages had already learned this the expensive way and set 60s budgets in
// their own `vitest.config.ts` (see `packages/agents/vitest.config.ts` and
// TASK-73 / TASK-103 / PR #407); thirteen more were still running on the
// defaults, and there was nothing to stop the fourteenth from arriving.
//
// TASK-400 widened it, because the fourteenth arrived from a direction the scope
// predicate could not see. On 2026-09-18, `main` commit `7b727ae0`, CI run
// `35354632189`:
//
//     FAIL packages/test-harness src/__tests__/stub-runner.test.ts
//          > fires event.chat-end with the assistant-text content when present
//     Error: Test timed out in 5000ms.
//     Tests  1 failed | 59 passed (60)
//
// and the merge queue stopped. That test costs **64ms** on an idle machine; CI
// cut it off at 5373ms, i.e. at ~84x, and since a timeout is censored from above
// nobody knows what it actually needed. Its neighbours in the same package
// COMPLETED at 1282/1467/2009ms against 91-95ms idle — 14-21x. A re-run went
// green, which is exactly the problem: the queue recovered by luck.
//
// `packages/test-harness` starts no container. It spawns real Node subprocesses
// and drives them over a real MCP stdio transport. Same defect, same budget,
// different spelling — and the guard written to catch this defect was scoped to
// the one spelling it had seen. So the predicate below is now "does work in
// another process", of which "starts a container" is one case.
//
// The second assertion is the subtler half, and it is the one TASK-323 was
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
// those 108 files. That is the invariant below, and it is why this asserts `>=`
// against a value scanned out of the sources rather than against a number typed
// here — a file that raises its own `beforeAll` to 180s should redden this guard
// until the config keeps up.
//
// What this guard does NOT do: police the SIZE of those budgets. A budget too
// small for legitimate work is a bug; one raised past a genuine hang is a mask.
// Neither is decidable from source shape, so this file deliberately takes no
// position on 30 vs 60 vs 120 and only insists a package in scope has chosen,
// and that the two numbers it chose agree with each other.
//
// Runs under `pnpm test:scripts` with no network, no Docker, and no build.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanHookTimeouts } from '../hook-timeout-scan.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where publishable packages live. Each child dir is one package. */
const PACKAGE_ROOTS = ['packages', 'presets'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-web', 'build', 'coverage']);

/**
 * A source that starts a container.
 *
 * Two spellings: the testcontainers constructor (`new PostgreSqlContainer(...)`,
 * `new GenericContainer(...)`) and this repo's shared helper
 * (`startPostgresContainer(...)` from `@ax/test-harness`). Matching
 * `[A-Za-z]*Container` rather than naming PostgreSql is the point — adding
 * `@testcontainers/redis` should pull that package into this guard's scope
 * automatically instead of slipping past it.
 *
 * Scanned across ALL of a package's `.ts`/`.tsx`, not just its tests, which is
 * how TASK-323 drew it and is left alone: a package that merely wraps
 * testcontainers is one whose tests will start one.
 *
 * `packages/memory-strata/test/bench/` carries a benchmark corpus whose JSON
 * *document text* contains testcontainers code as DATA; `.ts`-only scanning is
 * what keeps that from inventing a container package out of a fixture.
 */
const STARTS_CONTAINER = /new\s+[A-Za-z]*Container\s*\(|\bstartPostgresContainer\s*\(/;

/**
 * A TEST source that drives another OS process directly: it imports
 * `child_process`, or it constructs an MCP stdio transport (which owns and
 * spawns the child itself, so a file can be subprocess-heavy without naming
 * `child_process` once — `test-harness/src/__tests__/mcp-server-stub.test.ts` is
 * exactly that shape).
 *
 * Why an IMPORT rather than a call. The obvious pattern is `\bspawn\s*\(`, and
 * it was measured before being discarded: across the tree it pulls in
 * `chat-orchestrator` (whose tests only say "re-spawns" in prose and call a
 * `fork(` that is a git helper), `channel-web`, `agents` and three more that
 * mock `node:child_process` wholesale and never leave the process. An import is
 * unambiguous evidence the file itself reaches the OS.
 *
 * Why TEST sources only, where the container scan takes any source. `spawn` is a
 * commonplace of production code in this repo — `sandbox-subprocess`,
 * `memory-strata` and `validator-identity` all implement it and all mock it in
 * their tests. Scanning their sources would budget suites that never leave the
 * process. A container dependency is rarer and is a reliable proxy for what the
 * tests do; a `child_process` import is not.
 *
 * Known gap, stated rather than implied: a test that shells out through a
 * dependency's API (an SDK that spawns internally, a `simple-git`) names neither
 * pattern and is not seen. That direction fails OPEN, which is the bad one — it
 * is the direction that let `test-harness` sit unbudgeted for a year. If a new
 * package times out at 5s and is not in this scan, widen this constant; do not
 * hand-add the package.
 */
const TEST_LEAVES_PROCESS =
  /^[ \t]*import[\s\S]{0,300}?from\s*'(?:node:)?child_process'|await import\('(?:node:)?child_process'\)|new\s+Stdio(?:Client|Server)Transport\s*\(/m;

/**
 * Hook timeouts are read by PARSING each source — `scanHookTimeouts` in
 * `scripts/hook-timeout-scan.mjs`, shared with `scripts-suite-timeouts.test.js`.
 * That file states, per failure mode, which direction each one fails in; read it
 * before changing how hooks are found.
 *
 * This used to be a pair of regexes (`HOOK_WITH_TIMEOUT` for numeric literals,
 * `UNREADABLE_HOOK_TIMEOUT` for named constants) that matched from a hook keyword
 * lazily to the first line closing `}, <x>);`. Three lessons from their history
 * still bind whatever finds hooks here, which is why they are kept:
 *
 *   1. A MISSED hook LOWERS `maxDeclaredHookTimeout`, and a lower maximum makes
 *      the `hookTimeout >= max` assertion pass a config that is too low. The
 *      first draft anchored the closing brace at column 0, so every
 *      describe-nested hook was invisible and the guard went green on
 *      `packages/cli`'s `beforeAll(..., 120000)` against a 60_000 config — in
 *      the PR that introduced it.
 *   2. TASK-462: brace structure is not a regular language. Anything inside a
 *      hook's body that closed the same way — a nested hook, or merely a
 *      multi-line `setTimeout(() => { ... }, 50);` — ended the match early, so
 *      the hook was credited with the INNER number and its own budget was never
 *      seen. Same direction as (1): an under-read, reported as success. The
 *      regex also could not see a single-line hook or a brace-less arrow body.
 *   3. The same laziness ran the other way too, crediting a hook with the budget
 *      of an `it(..., MS)` further down the file. That was tolerated because it
 *      could only RAISE the maximum. MEASURED when the parser replaced it, over
 *      the 35 in-scope packages: 0 parse errors, 0 unreadable budgets, 29 maxima
 *      unchanged and 6 LOWER — `agent-claude-sdk-runner` and `agent-runner-core`
 *      30_000 -> 0, `database-postgres` / `ipc-core` / `session-postgres`
 *      15_000 -> 0, `workspace-git-server` 20_000 -> 0 — every one of them an
 *      `it` budget that the regex had run past a hook to reach. None raised; no
 *      config needed changing. An `it` budget is not a hook budget, so those
 *      packages' bare hooks were never governed by it.
 *
 * A timeout argument the parser cannot evaluate (an imported name, `2 * 60_000`)
 * lands in `unreadable` and is REPORTED, never counted as zero. A name declared
 * as a numeric literal anywhere in the same file resolves, and a name declared
 * twice resolves to the LARGER value — TASK-410 found last-write-wins made the
 * verdict turn on declaration order, and one of the two orders under-read.
 */

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
 * the heuristic starts producing false positives. The bound itself is matched
 * loosely (`< N`, `<= N`, or a named `< MAX` / `< XS.length`) because a poll
 * spelled with a constant is the same defect as one spelled with a literal.
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

/** Every package dir under the package roots of `repoRoot` (one level down). */
function allPackages(repoRoot) {
  const out = [];
  for (const root of PACKAGE_ROOTS) {
    const abs = join(repoRoot, root);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      out.push({ name: `${root}/${entry.name}`, dir: join(abs, entry.name) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Packages under `repoRoot` that do real out-of-process work, with the reason.
 *
 * Deliberately DERIVED and never hand-listed: a new package that spawns is meant
 * to be caught by arriving, not by someone remembering to add it here. The
 * fixture tests at the bottom of this file assert exactly that — they build a
 * throwaway package tree and check it lands in scope.
 */
function outOfProcessPackages(repoRoot) {
  const out = [];
  for (const pkg of allPackages(repoRoot)) {
    const files = sourceFiles(pkg.dir);
    const reasons = [];
    if (files.some((f) => STARTS_CONTAINER.test(readFileSync(f, 'utf8')))) {
      reasons.push('starts a container');
    }
    const testFiles = files.filter((f) => /\.test\.tsx?$/.test(f));
    if (testFiles.some((f) => TEST_LEAVES_PROCESS.test(readFileSync(f, 'utf8')))) {
      reasons.push('a test spawns a subprocess');
    }
    if (reasons.length === 0) continue;

    let maxDeclaredHookTimeout = 0;
    const unreadable = [];
    for (const f of files) {
      const scan = scanHookTimeouts(readFileSync(f, 'utf8'), f);
      for (const d of scan.declared) maxDeclaredHookTimeout = Math.max(maxDeclaredHookTimeout, d.ms);
      // Reported, never counted as zero — see the note above `outOfProcessPackages`.
      for (const u of scan.unreadable) unreadable.push({ file: f, line: u.line, name: u.expr, why: 'expr' });
      // A file that does not parse cleanly cannot be trusted to have shown us
      // every hook, so it is unreadable as a whole. Fail closed.
      for (const e of scan.parseErrors) unreadable.push({ file: f, line: e.line, name: e.message, why: 'parse' });
    }
    out.push({ ...pkg, files, reason: reasons.join(' + '), maxDeclaredHookTimeout, unreadable });
  }
  return out;
}

/**
 * The budgets a package's vitest config ACTUALLY resolves to, by importing it.
 *
 * This replaces the regex that used to read these two numbers out of the config
 * TEXT, and the replacement is the point rather than a tidy-up. TASK-331 spent
 * three drafts on that regex in the sibling guard and wrote the result into
 * `.claude/memory/patterns.md`: unanchored, it read `hookTimeout: 10_000` out of
 * the sentence "it ran on vitest's `hookTimeout: 10_000` defaults" in the very
 * config it was checking; stripping comments first was *silently* fail-open;
 * line anchoring works but rests on a CONVENTION (that a comment's continuation
 * lines never start at column 0) that JS does not enforce. That memory row ends
 * "note `container-test-timeouts.test.js` is still unanchored across the 21
 * container packages it covers — same hole, separate card." This is the card.
 *
 * Importing the config removes the class instead of the instance. Comments are
 * gone before the value exists, `60_000` has already become `60000`, two
 * settings may share a line, a `mergeConfig` with a shared base resolves, and
 * `defineConfig` is the identity function at runtime. Vitest transforms the
 * `.ts` through vite, so this needs no extra dependency and no extra loader.
 *
 * On cost, with the two corpora kept apart because they are easy to conflate.
 * TASK-386's PROBE imported every `vitest.config.ts` under the package roots and
 * took 177/184/188ms across three runs. This GUARD imports only the in-scope
 * subset and took 152/175/203ms across three runs. Re-measured 2026-09-19 the
 * corpora are **63** configs and **32** respectively; the probe figure was
 * recorded here as "62 configs" and was right on the day it was taken —
 * `packages/memory-facts-sqlite` arrived the next morning, which is all it takes.
 *
 * The two timings are close not because they measure the same thing but because
 * the cost is dominated by vite's transform pipeline rather than by the file
 * count — halving the corpus barely moves it. That is exactly why quoting the
 * probe's number as this guard's cost read plausible for as long as it did, and
 * why the scopes are now named separately even though the milliseconds agree.
 *
 * It fails CLOSED in all three ways it can fail: an import that throws, a
 * default export that is not a plain object (`defineConfig(({ mode }) => ...)`
 * returns a FUNCTION, and no config in this repo uses that form today), and an
 * absent `test` key are each reported as `kind: 'unreadable'` with the reason,
 * not silently treated as "no budget declared" — the two are different bugs and
 * the messages must not be interchangeable.
 */
async function readResolvedTestBudgets(pkgDir) {
  const configPath = join(pkgDir, 'vitest.config.ts');
  if (!existsSync(configPath)) return { kind: 'missing', configPath };
  let mod;
  try {
    mod = await import(/* @vite-ignore */ pathToFileURL(configPath).href);
  } catch (err) {
    return { kind: 'unreadable', configPath, why: `import threw: ${err.message}` };
  }
  const resolved = await mod.default;
  if (typeof resolved !== 'object' || resolved === null) {
    return { kind: 'unreadable', configPath, why: `default export is ${typeof resolved}, not an object` };
  }
  if (typeof resolved.test !== 'object' || resolved.test === null) {
    return { kind: 'unreadable', configPath, why: 'resolved config has no `test` block' };
  }
  return {
    kind: 'ok',
    configPath,
    testTimeout: resolved.test.testTimeout,
    hookTimeout: resolved.test.hookTimeout,
  };
}

const packages = outOfProcessPackages(REPO_ROOT);

describe('packages that leave the process declare their own timeouts (TASK-323, TASK-400)', () => {
  /** @type {Map<string, Awaited<ReturnType<typeof readResolvedTestBudgets>>>} */
  const budgets = new Map();

  // Bare on purpose. A hook's own timeout ARGUMENT overrides the config, so a
  // bare hook is what `scripts/vitest.config.mjs`'s `hookTimeout` actually
  // governs — this guard's own teardown budget should be the one the suite
  // declares, not one typed here. Measured 2026-09-19 at 152/175/203ms over
  // three runs for the 32 in-scope configs this loop actually imports — NOT the
  // whole tree; see `readResolvedTestBudgets` for the probe figure and why the
  // two land in the same range.
  beforeAll(async () => {
    for (const pkg of packages) budgets.set(pkg.name, await readResolvedTestBudgets(pkg.dir));
  });

  it('finds the out-of-process packages at all — a scan that matches nothing would pass everything below', () => {
    // Vacuity guard. Every assertion in this file is a `for (const pkg of
    // packages)`, so an empty scan makes all of them trivially green.
    //
    // MEASURED 2026-09-19 by running `outOfProcessPackages` over this tree: **32**
    // in scope — 22 that start a container, 12 whose tests spawn, 2 doing both
    // (22 + 12 - 2 = 32). The inputs are written beside the total on purpose, so
    // the next reader can check the arithmetic instead of trusting the digit.
    // Re-measured 2026-09-26 (TASK-462, the figure the parser note above uses):
    // **35** — 24 that start a container, 13 whose tests spawn, 2 doing both
    // (24 + 13 - 2 = 35). The count moved; the floor below did not need to.
    //
    // The version this replaces said "25 as this is written (21 container
    // packages plus ...)" and worked through a hand-kept list of the rest. Both
    // numbers were WRONG ON THE DAY — replaying this same function at the commit
    // that wrote them (`8516da20`, PR #581) also reports 32 and 22, so nothing
    // drifted; the figures never matched the code sitting beside them. That is
    // the failure this file exists to make harder, committed inside the file
    // itself, and no test could have caught it: a comment is not executed.
    //
    // The floor stays deliberately loose — it catches the scan BREAKING, not the
    // count moving — so the live count goes in the failure message rather than
    // into a second number that can rot quietly.
    expect(
      packages.length,
      `out-of-process scan found ${packages.length} packages: ${packages.map((p) => p.name).join(', ')}`,
    ).toBeGreaterThanOrEqual(20);
  });

  it('includes packages whose tests spawn but start no container — the TASK-400 gap', () => {
    // Pinned as a named regression, not left to the count above. This guard was
    // scoped to containers, and `packages/test-harness` — which spawns real Node
    // subprocesses over a real MCP stdio transport and starts no container —
    // sat outside it until its 5s default halted the merge queue. If a later
    // edit narrows TEST_LEAVES_PROCESS back to nothing, the count floor could
    // still be met by the container packages alone and this is what reddens.
    const spawnOnly = packages.filter((p) => p.reason === 'a test spawns a subprocess').map((p) => p.name);
    expect(spawnOnly).toContain('packages/test-harness');
  });

  it('each has a vitest.config.ts whose RESOLVED config sets both testTimeout and hookTimeout', () => {
    const missing = [];
    for (const pkg of packages) {
      const b = budgets.get(pkg.name);
      if (b.kind === 'missing') {
        missing.push(`${pkg.name} (${pkg.reason}): no vitest.config.ts (inherits 5s/10s defaults)`);
        continue;
      }
      if (b.kind === 'unreadable') {
        missing.push(`${pkg.name} (${pkg.reason}): config not readable — ${b.why}`);
        continue;
      }
      if (b.testTimeout === undefined) {
        missing.push(`${pkg.name} (${pkg.reason}): no testTimeout (inherits vitest's 5s)`);
      }
      if (b.hookTimeout === undefined) {
        missing.push(`${pkg.name} (${pkg.reason}): no hookTimeout (inherits vitest's 10s)`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('no package in scope declares a hook timeout this guard cannot read', () => {
    // Fail closed. A budget this guard cannot evaluate would otherwise count as
    // absent, which lowers the package maximum and makes the assertion below
    // pass a config that is too low. Two things land here: a hook timeout that
    // is neither a numeric literal nor a same-file numeric const, and a source
    // file that does not parse cleanly (it cannot be trusted to have shown us
    // every hook).
    //
    // If this reddens: teach `scripts/hook-timeout-scan.mjs` the new spelling —
    // do not relax this assertion, and do not lower the config to match.
    const unreadable = packages.flatMap((pkg) =>
      pkg.unreadable.map((u) =>
        u.why === 'parse'
          ? `${relative(REPO_ROOT, u.file)}:${u.line}: does not parse (${u.name}) — its hooks cannot be read`
          : `${relative(REPO_ROOT, u.file)}:${u.line}: hook timeout \`${u.name}\` is not a numeric literal ` +
            'and is not a file-local numeric const',
      ),
    );
    expect(unreadable).toEqual([]);
  });

  it("each package's hookTimeout is at least the largest timeout its own hooks declare", () => {
    const inconsistent = [];
    for (const pkg of packages) {
      const b = budgets.get(pkg.name);
      if (b.kind !== 'ok' || b.hookTimeout === undefined) continue; // reported by the test above
      if (b.hookTimeout < pkg.maxDeclaredHookTimeout) {
        inconsistent.push(
          `${pkg.name}: hookTimeout ${b.hookTimeout} < ${pkg.maxDeclaredHookTimeout} declared by a hook ` +
            `in this package — a bare afterAll here gets less budget than its own file's beforeAll asks for`,
        );
      }
    }
    expect(inconsistent).toEqual([]);
  });
});

// The guard's own scope, asserted by BUILDING a package rather than by reading
// this file's regexes back to itself. TASK-392's lesson, applied: when the
// subject is a behaviour, a scan for the right words passes against anything
// that merely says them. Each case below writes a throwaway package tree and
// runs the real `outOfProcessPackages` / `readResolvedTestBudgets` over it.
describe('the scan catches a NEW package, and the config read is a read (TASK-400)', () => {
  let root;

  /** Write `<root>/packages/<name>/` with a test file and an optional config. */
  function makePackage(name, { testSource, config }) {
    const dir = join(root, 'packages', name);
    mkdirSync(join(dir, 'src', '__tests__'), { recursive: true });
    writeFileSync(join(dir, 'src', '__tests__', 'a.test.ts'), testSource);
    if (config !== undefined) writeFileSync(join(dir, 'vitest.config.ts'), config);
    return dir;
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ax-timeout-guard-'));
    mkdirSync(join(root, 'packages'), { recursive: true });
  });

  it('a new package whose test imports child_process and declares nothing is caught', () => {
    makePackage('newly-spawning', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        "it('x', () => { spawn('git', ['status']); });",
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const found = outOfProcessPackages(root);
    expect(found.map((p) => p.name)).toContain('packages/newly-spawning');
    expect(found.find((p) => p.name === 'packages/newly-spawning').reason).toBe(
      'a test spawns a subprocess',
    );
  });

  it('reports that package as having no testTimeout — the failure this guard exists for', async () => {
    const dir = makePackage('undeclared', {
      testSource: "import { execFile } from 'node:child_process';\nit('x', () => execFile('ls'));",
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const b = await readResolvedTestBudgets(dir);
    expect(b.kind).toBe('ok');
    expect(b.testTimeout).toBeUndefined();
    expect(b.hookTimeout).toBeUndefined();
  });

  it('a package with NO vitest.config.ts is reported as missing, not as declared', async () => {
    const dir = makePackage('no-config', {
      testSource: "import { spawn } from 'node:child_process';\nit('x', () => spawn('ls'));",
    });
    expect((await readResolvedTestBudgets(dir)).kind).toBe('missing');
  });

  it('an ordinary unit package is NOT pulled in — the scan is scoped, not universal', () => {
    // The opposite failure. A predicate that matched everything would make the
    // assertions above green for the wrong reason and would demand a budget from
    // 50 pure-unit packages that are correctly served by the 5s default.
    makePackage('pure-unit', {
      testSource: "import { add } from '../add.js';\nit('adds', () => { expect(add(1, 2)).toBe(3); });",
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    expect(outOfProcessPackages(root).map((p) => p.name)).not.toContain('packages/pure-unit');
  });

  it('a package that only MOCKS child_process in prose is not pulled in', () => {
    // `chat-orchestrator` is the real instance: its tests say "re-spawns" in test
    // names and never leave the process. A `\bspawn\s*\(` predicate caught it.
    makePackage('mocks-only', {
      testSource: [
        "it('terminates the warm session so the next turn re-spawns', () => {",
        "  expect(out).toEqual({ applied: true, respawned: true });",
        '});',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    expect(outOfProcessPackages(root).map((p) => p.name)).not.toContain('packages/mocks-only');
  });

  it('a test that only drives an MCP stdio transport is caught (no child_process import)', () => {
    // `test-harness/src/__tests__/mcp-server-stub.test.ts` in miniature: the SDK
    // owns the child, so the file spawns a real process without naming
    // `child_process`.
    makePackage('stdio-only', {
      testSource: [
        "import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';",
        "it('x', () => { new StdioClientTransport({ command: 'node' }); });",
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    expect(outOfProcessPackages(root).map((p) => p.name)).toContain('packages/stdio-only');
  });

  it('reads the RESOLVED value, not the config text — a comment cannot outrank a setting', async () => {
    // The whole reason this stopped being a regex. Both numbers below appear in
    // the file; only one of them is the setting. An unanchored text scan reads
    // 600_000 (the comment comes first), a line-anchored one reads 30_000 — and
    // a line-anchored one is defeated by the column-0 block-comment case that
    // `scripts-suite-timeouts.test.js` pins as a known gap. Importing the module
    // makes the question unaskable: comments do not survive evaluation.
    const dir = makePackage('comment-trap', {
      testSource: "import { spawn } from 'node:child_process';\nit('x', () => spawn('ls'));",
      config: [
        '/*',
        'testTimeout: 600_000',
        '*/',
        '// never raise hookTimeout: 900_000 — it would mask a hang',
        'export default { test: { testTimeout: 30_000, hookTimeout: 60_000 } };',
      ].join('\n'),
    });
    const b = await readResolvedTestBudgets(dir);
    expect(b).toMatchObject({ kind: 'ok', testTimeout: 30_000, hookTimeout: 60_000 });
  });

  it('two settings on ONE line resolve normally — the fail-closed cost the regex paid', async () => {
    // `readTimeout` reported this shape as ABSENT, which reddened loudly and
    // forced one key per line. Evaluation has no such constraint.
    const dir = makePackage('one-line', {
      testSource: "import { spawn } from 'node:child_process';\nit('x', () => spawn('ls'));",
      config: 'export default { test: { testTimeout: 30_000, hookTimeout: 60_000 } };',
    });
    expect(await readResolvedTestBudgets(dir)).toMatchObject({ testTimeout: 30_000, hookTimeout: 60_000 });
  });

  it('a config whose default export is a FUNCTION is unreadable, never "declared"', async () => {
    // `defineConfig(({ mode }) => ({ ... }))` is legal vitest and no config in
    // this repo uses it. If one arrives, this must say so rather than read the
    // budgets as absent — those are different bugs and the message has to tell
    // them apart. Fail closed either way: both reach the `missing` list.
    const dir = makePackage('fn-config', {
      testSource: "import { spawn } from 'node:child_process';\nit('x', () => spawn('ls'));",
      config: 'export default () => ({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });',
    });
    const b = await readResolvedTestBudgets(dir);
    expect(b.kind).toBe('unreadable');
    expect(b.why).toContain('function');
  });

  it('a config with no `test` block is unreadable, never "declared"', async () => {
    const dir = makePackage('no-test-block', {
      testSource: "import { spawn } from 'node:child_process';\nit('x', () => spawn('ls'));",
      config: "export default { resolve: { alias: {} } };",
    });
    expect(await readResolvedTestBudgets(dir)).toMatchObject({ kind: 'unreadable' });
  });

  it('resolves a hook timeout spelled as a file-local const, and folds it into the maximum', () => {
    // The real instance: `agent-runner-core` spells 44 budgets
    // `}, REAL_GIT_TIMEOUT_MS)` against `const REAL_GIT_TIMEOUT_MS = 30_000`.
    // Before same-file consts resolved, that landed in the unreadable list and the
    // package maximum stayed 0 — the fail-closed direction, but noisy enough
    // that the tempting "fix" is an exemption.
    makePackage('named-const', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        'const REAL_GIT_TIMEOUT_MS = 45_000;',
        'describe("x", () => {',
        '  beforeAll(async () => {',
        '    await warm();',
        '  }, REAL_GIT_TIMEOUT_MS);',
        '});',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/named-const');
    expect(pkg.unreadable).toEqual([]);
    expect(pkg.maxDeclaredHookTimeout).toBe(45_000);
  });

  it('still reports a name it cannot resolve, rather than counting it as zero', () => {
    // The fail-closed half, and the reason the resolver is deliberately shallow:
    // an imported constant, or `30 * 1000`, is not followed. Reporting keeps the
    // package maximum honest instead of silently lowering it.
    makePackage('imported-const', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        "import { TIMEOUT_MS } from '../budgets.js';",
        'describe("x", () => {',
        '  beforeAll(async () => {',
        '    await warm();',
        '  }, TIMEOUT_MS);',
        '});',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/imported-const');
    expect(pkg.unreadable.map((u) => u.name)).toEqual(['TIMEOUT_MS']);
    expect(pkg.maxDeclaredHookTimeout).toBe(0);
  });

  it('does NOT credit a hook with an `it` budget below it — and still reads the hook that has one', () => {
    // This test used to be "folds a MISATTRIBUTED `it` budget into the maximum —
    // the safe direction, pinned". The regex scanner ran lazily from a BARE hook
    // past its end to an `it(..., NAMED_MS)` and credited the hook with the
    // `it`'s budget; that was tolerated because it could only raise the maximum,
    // and the old comment said that if someone anchored the scan to the hook's
    // own call this fixture would drop 90_000 -> 0 and the test should be
    // REWRITTEN rather than restored. TASK-462 did that anchoring (by parsing),
    // so this is the rewrite.
    //
    // What makes the drop safe rather than fail-open: an `it`'s budget governs
    // that test, not any hook, so the bare `beforeAll` here really is governed
    // by the config's `hookTimeout` and nothing in this file asks for more. The
    // second half is what keeps this from being satisfied by a scanner that
    // simply reads nothing: the timed `afterAll` AFTER the `it` must still count.
    makePackage('it-budget-not-a-hook-budget', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        'const E2E_TIMEOUT_MS = 90_000;',
        'describe("x", () => {',
        '  beforeAll(async () => {',
        '    await warm();',
        '  });',
        '  it("slow", async () => {',
        '    await go();',
        '  }, E2E_TIMEOUT_MS);',
        '  afterAll(async () => { await stop(); }, 40_000);',
        '});',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/it-budget-not-a-hook-budget');
    expect(pkg.unreadable).toEqual([]);
    expect(pkg.maxDeclaredHookTimeout).toBe(40_000);
  });

  it('reads the shapes the regex never could: a single-line hook and a brace-less arrow', () => {
    // Both were documented, uncovered, fail-OPEN gaps of the regex scanner
    // (its `\n\s*\}` anchor needs a newline before the closing brace).
    makePackage('one-liners', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        'beforeAll(() => { warm(); }, 70_000);',
        'afterAll(() => stop(), 80_000);',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/one-liners');
    expect(pkg.maxDeclaredHookTimeout).toBe(80_000);
  });

  it('does not resolve a const that is REASSIGNED before the hook runs', () => {
    // Resolving `X` to its initialiser would read 5_000 where the hook gets
    // 30_000 — an under-read. It is reported instead. (Not a regex-era shape:
    // the regex resolver had the same hole; the reviewer of TASK-462 found it.)
    makePackage('reassigned-const', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        'let HOOK_MS = 5_000;',
        'HOOK_MS = 30_000;',
        'beforeAll(async () => { await warm(); }, HOOK_MS);',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/reassigned-const');
    expect(pkg.unreadable.map((u) => u.name)).toEqual(['HOOK_MS']);
  });

  it('reports a source that does not parse, rather than trusting the hooks it could see', () => {
    // A syntax error can hide a hook from any scanner. Fail closed: the file is
    // unreadable as a whole, even though one hook in it was read.
    makePackage('broken-source', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        'beforeAll(async () => {',
        '  await warm(;',
        '}, 120_000);',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/broken-source');
    expect(pkg.unreadable.map((u) => u.why)).toContain('parse');
  });

  it('resolves a SHADOWED constant to the larger value, whichever order it is declared in', () => {
    // The half that was NOT fail-closed, and the mutation that proves it.
    //
    // The regex-era `numericConsts` built its map with `out.set(name, value)` —
    // last-write-wins — and its indentation-tolerant `^[ \t]*` anchor let a nested
    // `const TIMEOUT_MS = 5_000` inside a describe block overwrites a top-level
    // `const TIMEOUT_MS = 120_000`. MEASURED against the unfixed resolver: the two
    // fixtures below are the same two declarations in opposite orders and reported
    // **5_000** and **120_000** respectively. The 5_000 one is the dangerous
    // direction — a package whose `beforeAll` asks for 120s reports a maximum of
    // 5s, so the guard passes a `hookTimeout` far below what that hook declares.
    // That is the `packages/cli` failure exactly: green on the violation it exists
    // to catch, and green because a value it could not see read as smaller.
    //
    // The equality assertion is the load-bearing one. A maximum must not depend on
    // the order two declarations happen to appear in, and asserting only the value
    // would be satisfied by a resolver that got lucky on one layout.
    const src = (first, second) =>
      [
        "import { spawn } from 'node:child_process';",
        ...first,
        ...second,
      ].join('\n');
    const bigFirst = [
      'const TIMEOUT_MS = 120_000;',
      'describe("outer", () => {',
      '  beforeAll(async () => {',
      '    await warm();',
      '  }, TIMEOUT_MS);',
      '});',
    ];
    const smallSecond = [
      'describe("inner", () => {',
      '  const TIMEOUT_MS = 5_000;',
      '  it("quick", async () => {',
      '    await go();',
      '  }, TIMEOUT_MS);',
      '});',
    ];
    const config = "export default { test: { include: ['src/**/*.test.ts'] } };";
    makePackage('shadow-big-first', { testSource: src(bigFirst, smallSecond), config });
    makePackage('shadow-small-first', { testSource: src(smallSecond, bigFirst), config });

    const found = outOfProcessPackages(root);
    const bigFirstMax = found.find((p) => p.name === 'packages/shadow-big-first').maxDeclaredHookTimeout;
    const smallFirstMax = found.find((p) => p.name === 'packages/shadow-small-first').maxDeclaredHookTimeout;

    expect(bigFirstMax).toBe(smallFirstMax);
    expect(bigFirstMax).toBe(120_000);
  });

  // TASK-462. The three shapes below are the ones a brace-matching regex cannot
  // read, and every one of them failed OPEN: the regex's lazy `[\s\S]*?\n\s*\}`
  // stops at the FIRST `\n  }, <x>);` after a hook keyword, so anything inside
  // the hook's body that closes the same way hands the hook the wrong number and
  // swallows the real one. MEASURED against the regex scanner at `be8fc794`:
  // `nested-hook` read 30_000, `timer-in-hook` read 50, and `nested-unresolved`
  // reported NOTHING unreadable — all three against a true outer budget the
  // guard never saw.
  it('reads the OUTER budget when a hook is registered inside another hook', () => {
    makePackage('nested-hook', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        'describe("x", () => {',
        '  beforeAll(async () => {',
        '    beforeEach(async () => {',
        '      await reset();',
        '    }, 30_000);',
        '    await warm();',
        '  }, 120_000);',
        '});',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/nested-hook');
    expect(pkg.unreadable).toEqual([]);
    expect(pkg.maxDeclaredHookTimeout).toBe(120_000);
  });

  it('is not fooled by a NON-hook call inside the body that closes the same way', () => {
    // The shape that needs no questionable vitest at all: any
    // `setTimeout(() => {\n ... \n}, 50);` statement inside a hook body.
    makePackage('timer-in-hook', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        'beforeAll(async () => {',
        '  const t = setTimeout(() => {',
        '    warn();',
        '  }, 50);',
        '  await warm();',
        '  clearTimeout(t);',
        '}, 120_000);',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/timer-in-hook');
    expect(pkg.maxDeclaredHookTimeout).toBe(120_000);
  });

  it('reports an unresolvable OUTER budget even when an inner hook resolves', () => {
    // The unreadable list's half of the same defect: the inner hook's resolvable
    // `INNER_MS` is consumed, and the outer `}, OUTER_MS)` — imported, so it
    // cannot be resolved — is never reported. Fail-closed means it is.
    makePackage('nested-unresolved', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        "import { OUTER_MS } from '../budgets.js';",
        'const INNER_MS = 30_000;',
        'beforeAll(async () => {',
        '  afterEach(async () => {',
        '    await reset();',
        '  }, INNER_MS);',
        '}, OUTER_MS);',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/nested-unresolved');
    expect(pkg.unreadable.map((u) => u.name)).toEqual(['OUTER_MS']);
    expect(pkg.maxDeclaredHookTimeout).toBe(30_000);
  });

  // Bare, like the setup hook, and for the same reason: what the suite's
  // `hookTimeout` governs is the hooks that don't argue with it.
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe('waits are time-budgeted, not iteration-budgeted (TASK-323)', () => {
  const testSources = allPackages(REPO_ROOT)
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
