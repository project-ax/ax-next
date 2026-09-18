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
 *      uses `E2E_TIMEOUT_MS`.
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
 * None of the three is used by a package in scope today.
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
 *
 * NOTE this scan reads SOURCES, where a match inside a comment inflates the
 * maximum and so reddens loudly — fail-CLOSED, and documented rather than
 * guarded. The CONFIG side used to be scanned the same way and failed in the
 * OPPOSITE direction; see `readResolvedTestBudgets` for what replaced it.
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
 * worth making for shapes no package in scope uses.
 *
 * Known false positive: the `[\s\S]*?` is not anchored to the hook's own call,
 * so a match can start at a hook keyword and run PAST it to a later
 * `\n}, <identifier>);` — an unrelated two-argument call, or an `it(..., MS)`
 * further down the file, reads as an unreadable hook timeout. TASK-400 met both
 * instances the moment the scope widened past containers:
 * `agent-runner-core/src/__tests__/git-workspace.test.ts` and
 * `agent-claude-sdk-runner/src/__tests__/flush-workspace-host.e2e.test.ts` spell
 * 44 and 4 **`it`** budgets `}, REAL_GIT_TIMEOUT_MS)` / `}, E2E_TIMEOUT_MS)`,
 * and this pattern attributed them to a hook above. That is why the fix was
 * NAMED_NUMERIC_CONST rather than an exemption: both names resolve to 30_000 in
 * their own file, so folding them into the package maximum costs nothing and is
 * conservative in the fail-CLOSED direction even when the attribution is wrong.
 * If this list ever reddens again, check the captured identifier really IS a
 * hook's timeout before believing the message — and fix the regex, never the
 * config.
 */
const UNREADABLE_HOOK_TIMEOUT =
  /\b(?:beforeAll|afterAll|beforeEach|afterEach)\s*\([\s\S]*?\n\s*\}\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*;/g;

/**
 * A file-local numeric constant: `const REAL_GIT_TIMEOUT_MS = 30_000;`
 *
 * This is what lets a named-constant budget be READ instead of merely reported
 * as unreadable. The guard's standing instruction when it meets a spelling it
 * cannot parse is "teach the scanner the spelling — do not relax the assertion,
 * and do not lower the config to match", and this is that, for the one spelling
 * that actually occurs.
 *
 * Deliberately shallow: same file, top-level-ish (`^[ \t]*`), numeric literal
 * only. It does NOT follow an import, an arithmetic expression (`30 * 1000`) or
 * a constant declared in a helper module. Those stay in the unreadable list,
 * which is the fail-closed side — an unresolved name is reported, never silently
 * counted as zero.
 */
const NAMED_NUMERIC_CONST =
  /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(\d[\d_]*)\s*;/gm;

/** `name -> milliseconds` for every file-local numeric constant in `text`. */
function numericConsts(text) {
  const out = new Map();
  for (const m of text.matchAll(NAMED_NUMERIC_CONST)) out.set(m[1], Number(m[2].replace(/_/g, '')));
  return out;
}

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
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(HOOK_WITH_TIMEOUT)) {
        maxDeclaredHookTimeout = Math.max(maxDeclaredHookTimeout, Number(m[1].replace(/_/g, '')));
      }
      let consts;
      for (const m of text.matchAll(UNREADABLE_HOOK_TIMEOUT)) {
        consts ??= numericConsts(text);
        const value = consts.get(m[1]);
        // Resolved names fold into the maximum (conservative: see the note on
        // UNREADABLE_HOOK_TIMEOUT's false positive). Unresolved ones are
        // reported rather than counted as zero.
        if (value === undefined) unreadable.push({ file: f, name: m[1] });
        else maxDeclaredHookTimeout = Math.max(maxDeclaredHookTimeout, value);
      }
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
 * `.ts` through vite, so this needs no extra dependency and no extra loader; the
 * whole tree of 62 configs resolves in ~180ms.
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
  // declares, not one typed here. Measured at ~180ms for the whole tree.
  beforeAll(async () => {
    for (const pkg of packages) budgets.set(pkg.name, await readResolvedTestBudgets(pkg.dir));
  });

  it('finds the out-of-process packages at all — a scan that matches nothing would pass everything below', () => {
    // Vacuity guard. Every assertion in this file is a `for (const pkg of
    // packages)`, so an empty scan makes all of them trivially green. 25 as this
    // is written (21 container packages plus agent-aisdk-runner,
    // agent-claude-sdk-runner, agent-runner-core, test-harness, user-files-read,
    // sandbox-k8s, workspace-git*, ipc-core — with overlap). The floor is
    // deliberately loose: this catches the scan BREAKING, not the count moving.
    expect(packages.length).toBeGreaterThanOrEqual(20);
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
    // Fail closed. See UNREADABLE_HOOK_TIMEOUT: a budget this file cannot parse
    // is counted as absent, which lowers the package maximum and makes the
    // assertion below pass a config that is too low. Covers the named-constant
    // spelling only — single-line hooks and brace-less arrows are documented,
    // uncovered gaps, not silent ones.
    //
    // If this reddens: first check the captured identifier really IS a hook's
    // timeout (the regex can escape past a hook into an unrelated two-argument
    // call). If it is, teach the scanner the new spelling — do not relax this
    // assertion, and do not lower the config to match. NAMED_NUMERIC_CONST is
    // the last such extension: a `const X = 30_000` in the same file now
    // resolves, so only names that resolve NOWHERE reach this list.
    const unreadable = packages.flatMap((pkg) =>
      pkg.unreadable.map(
        (u) =>
          `${relative(REPO_ROOT, u.file)}: hook timeout \`${u.name}\` is not a numeric literal ` +
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
    // Before NAMED_NUMERIC_CONST that landed in the unreadable list and the
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
