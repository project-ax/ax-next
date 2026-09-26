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
// TASK-575 made the unit a CONFIG, not a package. Both rules used to read only
// `vitest.config.ts`, so `presets/k8s/vitest.config.k8s-e2e.ts` (hookTimeout
// 60_000, `{ timeout: 180_000 }` tests, a bare cleanup `afterAll`) broke the
// TASK-567 rule where nothing looked. Every config a package uses is now found
// (`discoverVitestConfigs`), each is scored against only the files its
// `include` / `exclude` select (`resolvePackageConfigs`), and a config or
// script the guard cannot follow is REPORTED, never skipped.
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
import { dirname, join, matchesGlob, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configDefaults } from 'vitest/config';

import { scanHookTimeouts, scanTestTimeouts } from '../hook-timeout-scan.mjs';

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
 *      TASK-567 (human ruling: enforce it) then made the part of that accident
 *      worth keeping deliberate, as its own rule: a package with a BARE teardown
 *      keeps `hookTimeout` at or above its largest DECLARED test budget. See
 *      `bareTeardownViolations`. It is a separate maximum, not folded into
 *      `maxDeclaredHookTimeout`, so a timed teardown still answers to hooks only.
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
    // TASK-567: the largest budget a TEST in this package declares, where it was
    // declared, and every bare teardown (see `scanTestTimeouts`).
    let maxDeclaredTestTimeout = 0;
    let maxTestAt;
    const bareTeardowns = [];
    const unreadable = [];
    // TASK-575: the same facts per FILE, so each vitest config can be scored
    // against only the files it actually runs (see `resolvePackageConfigs`).
    const fileScans = [];
    for (const f of files) {
      const scan = scanTestTimeouts(readFileSync(f, 'utf8'), f);
      fileScans.push({
        file: f,
        declared: scan.declared,
        testDeclared: scan.testDeclared,
        bareTeardowns: scan.bareTeardowns,
      });
      for (const d of scan.declared) maxDeclaredHookTimeout = Math.max(maxDeclaredHookTimeout, d.ms);
      for (const d of scan.testDeclared) {
        if (d.ms > maxDeclaredTestTimeout) {
          maxDeclaredTestTimeout = d.ms;
          maxTestAt = { file: f, line: d.line };
        }
      }
      for (const t of scan.bareTeardowns) bareTeardowns.push({ file: f, line: t.line, hook: t.hook });
      // Reported, never counted as zero — see the note above `outOfProcessPackages`.
      for (const u of scan.unreadable) unreadable.push({ file: f, line: u.line, name: u.expr, why: 'expr' });
      for (const u of scan.testUnreadable) unreadable.push({ file: f, line: u.line, name: u.expr, why: 'test-expr' });
      // A file that does not parse cleanly cannot be trusted to have shown us
      // every hook, so it is unreadable as a whole. Fail closed.
      for (const e of scan.parseErrors) unreadable.push({ file: f, line: e.line, name: e.message, why: 'parse' });
    }
    out.push({
      ...pkg,
      files,
      reason: reasons.join(' + '),
      maxDeclaredHookTimeout,
      maxDeclaredTestTimeout,
      maxTestAt,
      bareTeardowns,
      unreadable,
      fileScans,
    });
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
  return readConfigBudgets(join(pkgDir, 'vitest.config.ts'));
}

/**
 * `readResolvedTestBudgets` for ANY config path (TASK-575), plus the settings
 * that decide which files the config runs: `include` / `exclude`, defaulted
 * from vitest's own `configDefaults` exactly as vitest defaults them (a
 * config's `exclude` REPLACES the default, it does not extend it).
 *
 * Fail CLOSED on every setting that would move a file in or out of the config
 * in a way `configFilesFor` does not model — each is `kind: 'unreadable'` with
 * the reason, never "ok with the default file set":
 *   - `test.projects` / `test.workspace`: the config fans out to other configs.
 *   - `root`, `test.root`, `test.dir`: the globs resolve against another dir.
 *   - a non-empty `test.includeSource`: in-source tests in non-test files.
 *   - `include` / `exclude` that is not an array of strings, or an `include`
 *     pattern negated with `!`.
 * None of these occurs in the tree; they are refused rather than guessed at.
 */
async function readConfigBudgets(configPath) {
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
  const t = resolved.test;
  const unreadable = (why) => ({ kind: 'unreadable', configPath, why });
  for (const key of ['projects', 'workspace']) {
    if (t[key] !== undefined) return unreadable(`sets test.${key} — this guard cannot map files through it`);
  }
  if (resolved.root !== undefined) return unreadable('sets root — include globs would resolve elsewhere');
  for (const key of ['root', 'dir']) {
    if (t[key] !== undefined) return unreadable(`sets test.${key} — include globs would resolve elsewhere`);
  }
  if (t.includeSource !== undefined && !(Array.isArray(t.includeSource) && t.includeSource.length === 0)) {
    return unreadable('sets test.includeSource — in-source tests are not mapped');
  }
  const isGlobList = (v) => Array.isArray(v) && v.every((g) => typeof g === 'string');
  const include = t.include ?? [...configDefaults.include];
  const exclude = t.exclude ?? [...configDefaults.exclude];
  if (!isGlobList(include)) return unreadable('test.include is not an array of strings');
  if (!isGlobList(exclude)) return unreadable('test.exclude is not an array of strings');
  if (include.some((g) => g.startsWith('!'))) return unreadable('test.include has a negated (!) pattern');
  return {
    kind: 'ok',
    configPath,
    testTimeout: t.testTimeout,
    hookTimeout: t.hookTimeout,
    include,
    exclude,
  };
}

/**
 * A package-root file that is a vitest config by NAME: `vitest.config.ts`,
 * `vitest.config.k8s-e2e.ts`, `vitest.e2e.config.mjs`, `vitest.workspace.ts`.
 * Setup files (`vitest.setup.ts`) are not configs and do not match.
 */
const VITEST_CONFIG_NAME = /^vitest\.(?:[\w-]+\.)*(?:config|workspace)(?:\.[\w-]+)*\.[cm]?[jt]s$/;

/** vitest CLI flags that change which files a run picks up in ways the mapping does not model. */
const UNMAPPED_VITEST_FLAG = /(?:^|\s)(?:--root|-r|--dir|--workspace|--project)(?:[\s=]|$)/;

/**
 * Every vitest config a package actually uses (TASK-575), and every reason
 * this could not be established. Both timeout rules used to read ONLY
 * `vitest.config.ts`, and `presets/k8s/vitest.config.k8s-e2e.ts` — run by its
 * `test:k8s-e2e` script, hookTimeout 60_000 against `{ timeout: 180_000 }`
 * tests with a bare `afterAll` — broke the TASK-567 rule where nothing looked.
 *
 * Two sources, unioned and de-duplicated by resolved path:
 *   1. every package-root file matching `VITEST_CONFIG_NAME` (a config that
 *      exists is assumed to be run by someone — over-read, never skip);
 *   2. every `--config <p>` / `--config=<p>` / `-c <p>` in a package.json
 *      script that invokes vitest, resolved against the package dir.
 *
 * Fail CLOSED, each as a `problems` entry: a package.json that does not parse;
 * a script config whose value is not a plain path (`$VAR`, a backtick) or
 * does not exist; a vitest script using `--root` / `--dir` / `--workspace` /
 * `--project`. The primary `vitest.config.ts` is always listed (its absence is
 * the `missing` case the config test reports).
 *
 * Known gap, stated: a script that reaches vitest through a wrapper (`node
 * run-tests.mjs`) and passes the config there is not seen. None does today.
 */
function discoverVitestConfigs(pkgDir) {
  const configs = new Map([[join(pkgDir, 'vitest.config.ts'), 'vitest.config.ts']]);
  const problems = [];
  for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
    if (entry.isFile() && VITEST_CONFIG_NAME.test(entry.name)) configs.set(join(pkgDir, entry.name), entry.name);
  }
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (existsSync(pkgJsonPath)) {
    let scripts;
    try {
      scripts = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).scripts ?? {};
    } catch (err) {
      problems.push(`package.json does not parse (${err.message}) — its vitest scripts cannot be read`);
      scripts = {};
    }
    for (const [name, cmd] of Object.entries(scripts)) {
      if (typeof cmd !== 'string' || !/\bvitest\b/.test(cmd)) continue;
      if (UNMAPPED_VITEST_FLAG.test(cmd)) {
        problems.push(`script "${name}" runs vitest with a flag this guard cannot map files through: ${cmd}`);
      }
      for (const m of cmd.matchAll(/(?:^|\s)(?:--config|-c)(?:=|\s+)(\S+)/g)) {
        const value = m[1].replace(/^(['"])(.*)\1$/, '$2');
        if (!/^[\w./-]+$/.test(value)) {
          problems.push(`script "${name}" names a config this guard cannot resolve: ${m[1]}`);
          continue;
        }
        const path = join(pkgDir, value);
        if (!existsSync(path)) {
          problems.push(`script "${name}" names ${value}, which does not exist`);
          continue;
        }
        if (!configs.has(path)) configs.set(path, `${value} (script "${name}")`);
      }
    }
  }
  return { configs: [...configs].map(([path, label]) => ({ path, label })), problems };
}

/** Does `rel` (posix, relative to the config's dir) belong to a config with these globs? */
function configRuns(rel, { include, exclude }) {
  const norm = (g) => g.replace(/^\.\//, '');
  return include.some((g) => matchesGlob(rel, norm(g))) && !exclude.some((g) => matchesGlob(rel, norm(g)));
}

/**
 * Every config of `pkg`, read and scored against the files it runs (TASK-575).
 *
 * Mapping: a source file matched by a config's `include` and not its `exclude`
 * belongs to that config. A file matched by NO readable config of the package
 * — a shared helper such as `k8s-e2e/helpers.ts`, which can register hooks for
 * whichever test imports it, or an orphan test — belongs to EVERY config. That
 * over-reads, which is the safe direction for maxima checked with `>=`.
 * Globs are resolved against the package dir, which is where every config
 * lives and where `pnpm --filter` runs its scripts; a config that points them
 * elsewhere (`root`, `dir`) is refused by `readConfigBudgets`.
 *
 * Returns { configs: [{ label, budgets, files, maxDeclaredHookTimeout,
 * maxDeclaredTestTimeout, maxTestAt, bareTeardowns }], problems: [string] }.
 */
async function resolvePackageConfigs(pkg) {
  const { configs, problems } = discoverVitestConfigs(pkg.dir);
  const read = [];
  for (const c of configs) read.push({ ...c, budgets: await readConfigBudgets(c.path) });
  const rels = pkg.fileScans.map((s) => relative(pkg.dir, s.file).split(sep).join('/'));
  const readable = read.filter((c) => c.budgets.kind === 'ok');
  const claimed = rels.map((rel) => readable.some((c) => configRuns(rel, c.budgets)));
  const out = [];
  for (const c of read) {
    const scored = { label: c.label, budgets: c.budgets, files: [], maxDeclaredHookTimeout: 0, maxDeclaredTestTimeout: 0, maxTestAt: undefined, bareTeardowns: [] };
    if (c.budgets.kind === 'ok') {
      pkg.fileScans.forEach((s, i) => {
        if (claimed[i] && !configRuns(rels[i], c.budgets)) return;
        scored.files.push(s.file);
        for (const d of s.declared) scored.maxDeclaredHookTimeout = Math.max(scored.maxDeclaredHookTimeout, d.ms);
        for (const d of s.testDeclared) {
          if (d.ms > scored.maxDeclaredTestTimeout) {
            scored.maxDeclaredTestTimeout = d.ms;
            scored.maxTestAt = { file: s.file, line: d.line };
          }
        }
        for (const t of s.bareTeardowns) scored.bareTeardowns.push({ file: s.file, line: t.line, hook: t.hook });
      });
    }
    out.push(scored);
  }
  return { configs: out, problems };
}

/**
 * TASK-567: packages with a BARE teardown whose effective `hookTimeout` is below
 * the largest budget a test in the package declares, as failure messages.
 *
 * Human ruling (Vinay, 2026-09-26): enforce it.
 *
 * A bare `afterAll` / `afterEach` runs under the config's `hookTimeout`. A
 * test declaring `it(..., 180_000)` is a test that does long out-of-process
 * work, and the cleanup of that work lands in the bare teardown. With
 * `hookTimeout` below the test's own budget, the teardown times out AFTER
 * every assertion passed — the `@ax/auth-better` Docker-teardown shape
 * CLAUDE.md warns about (64/64 assertions green, run red).
 *
 * The regex scanner held this line by ACCIDENT before TASK-462: it ran lazily
 * from a bare hook to the next `it(..., N)` and credited the hook with it.
 * The parser stopped that misattribution, correctly, and this is the
 * invariant made deliberate instead.
 *
 * Scope, stated: PACKAGE-wide, like the hook rule — the maximum test
 * budget anywhere in the package against any bare teardown anywhere in it,
 * because both share one config. A teardown with a timeout ARGUMENT is not
 * bare (its own argument governs it) and is held by the hook rule
 * (`hookTimeout >= the largest timeout a hook declares`) instead.
 * Tests with NO declared budget run under `testTimeout` and are not counted:
 * the ruling is about DECLARED `it()` budgets.
 *
 * The effective `hookTimeout` is vitest's 10_000 default when the config
 * omits it (that omission is also reported by the config test), so a missing key cannot
 * make this pass.
 */
function bareTeardownViolations(pkgs, resolvedByName, repoRoot) {
  const out = [];
  for (const pkg of pkgs) {
    const r = resolvedByName.get(pkg.name);
    if (r === undefined) {
      // Fail closed: a package whose configs were never read has not passed.
      out.push(`${pkg.name}: its vitest config budgets were never read`);
      continue;
    }
    for (const c of r.configs) {
      if (c.budgets.kind !== 'ok') continue; // missing / unreadable: reported by the config test
      if (c.bareTeardowns.length === 0) continue;
      const effectiveHookTimeout = c.budgets.hookTimeout ?? 10_000;
      if (effectiveHookTimeout < c.maxDeclaredTestTimeout) {
        const t = c.bareTeardowns[0];
        out.push(
          `${pkg.name} [${c.label}]: hookTimeout ${effectiveHookTimeout} < ${c.maxDeclaredTestTimeout} declared by a ` +
            `test at ${relative(repoRoot, c.maxTestAt.file)}:${c.maxTestAt.line}, and ${c.bareTeardowns.length} bare ` +
            `teardown(s) run under hookTimeout (first: ${t.hook} at ${relative(repoRoot, t.file)}:${t.line}) — ` +
            'raise hookTimeout, or give each bare teardown its own timeout argument (the hook rule then holds ' +
            'that argument to hookTimeout)',
        );
      }
    }
  }
  return out;
}

/**
 * The TASK-323 hook rule, per config (TASK-575): each config's `hookTimeout` is
 * at least the largest timeout a hook in the files IT runs declares. Fail
 * closed on a package that was never resolved.
 */
function hookRuleViolations(pkgs, resolvedByName) {
  const out = [];
  for (const pkg of pkgs) {
    const r = resolvedByName.get(pkg.name);
    if (r === undefined) {
      out.push(`${pkg.name}: its vitest config budgets were never read`);
      continue;
    }
    for (const c of r.configs) {
      if (c.budgets.kind !== 'ok' || c.budgets.hookTimeout === undefined) continue; // reported by the config test
      if (c.budgets.hookTimeout < c.maxDeclaredHookTimeout) {
        out.push(
          `${pkg.name} [${c.label}]: hookTimeout ${c.budgets.hookTimeout} < ${c.maxDeclaredHookTimeout} declared by ` +
            "a hook in a file this config runs — a bare afterAll here gets less budget than its own file's " +
            'beforeAll asks for',
        );
      }
    }
  }
  return out;
}

/**
 * Every config of every package, each missing / unreadable / budget-less one
 * as a message, plus every discovery problem (TASK-575: fail closed on a
 * config the guard cannot read, wherever it was found).
 */
function configDeclarationProblems(pkgs, resolvedByName) {
  const out = [];
  for (const pkg of pkgs) {
    const r = resolvedByName.get(pkg.name);
    if (r === undefined) {
      out.push(`${pkg.name}: its vitest configs were never read`);
      continue;
    }
    for (const p of r.problems) out.push(`${pkg.name} (${pkg.reason}): ${p}`);
    for (const c of r.configs) {
      const b = c.budgets;
      const at = `${pkg.name} [${c.label}] (${pkg.reason})`;
      if (b.kind === 'missing') {
        out.push(`${at}: no such config (a missing vitest.config.ts inherits 5s/10s defaults)`);
        continue;
      }
      if (b.kind === 'unreadable') {
        out.push(`${at}: config not readable — ${b.why}`);
        continue;
      }
      if (b.testTimeout === undefined) out.push(`${at}: no testTimeout (inherits vitest's 5s)`);
      if (b.hookTimeout === undefined) out.push(`${at}: no hookTimeout (inherits vitest's 10s)`);
    }
  }
  return out;
}

const packages = outOfProcessPackages(REPO_ROOT);

describe('packages that leave the process declare their own timeouts (TASK-323, TASK-400)', () => {
  /** @type {Map<string, Awaited<ReturnType<typeof resolvePackageConfigs>>>} */
  const resolved = new Map();

  // Bare on purpose. A hook's own timeout ARGUMENT overrides the config, so a
  // bare hook is what `scripts/vitest.config.mjs`'s `hookTimeout` actually
  // governs — this guard's own teardown budget should be the one the suite
  // declares, not one typed here. Measured 2026-09-19 at 152/175/203ms over
  // three runs for the 32 in-scope configs this loop actually imports — NOT the
  // whole tree; see `readResolvedTestBudgets` for the probe figure and why the
  // two land in the same range.
  beforeAll(async () => {
    for (const pkg of packages) resolved.set(pkg.name, await resolvePackageConfigs(pkg));
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

  it('each has a vitest.config.ts, and EVERY config it uses resolves and sets both testTimeout and hookTimeout', () => {
    // TASK-575: every config, not just `vitest.config.ts` — see
    // `discoverVitestConfigs` for how they are found and what fails closed.
    expect(configDeclarationProblems(packages, resolved)).toEqual([]);
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
          : u.why === 'test-expr'
            ? `${relative(REPO_ROOT, u.file)}:${u.line}: test argument \`${u.name}\` is not a function, a ` +
              'numeric literal, a file-local numeric const, or an object literal whose `timeout` is one of those'
            : `${relative(REPO_ROOT, u.file)}:${u.line}: hook timeout \`${u.name}\` is not a numeric literal ` +
              'and is not a file-local numeric const',
      ),
    );
    expect(unreadable).toEqual([]);
  });

  it('a config whose files hold a BARE teardown has a hookTimeout of at least their largest declared test budget (TASK-567, TASK-575)', () => {
    // See `bareTeardownViolations` for the rule and the human ruling behind it.
    expect(bareTeardownViolations(packages, resolved, REPO_ROOT)).toEqual([]);
  });

  it("each config's hookTimeout is at least the largest timeout the hooks in its files declare (TASK-575: per config)", () => {
    expect(hookRuleViolations(packages, resolved)).toEqual([]);
  });

  it('reads presets/k8s/vitest.config.k8s-e2e.ts — the secondary config TASK-575 found unchecked', () => {
    // Named regression, not left to the rules above: if discovery stops seeing
    // secondary configs, every rule is green for the old reason (it never looked).
    const k8s = resolved.get('presets/k8s');
    expect(k8s, 'presets/k8s fell out of scope').not.toBeUndefined();
    const e2e = k8s.configs.find((c) => c.label === 'vitest.config.k8s-e2e.ts');
    expect(e2e?.budgets.kind).toBe('ok');
    const rel = (f) => relative(join(REPO_ROOT, 'presets', 'k8s'), f).split(sep).join('/');
    expect(e2e.files.map(rel)).toContain('src/__tests__/k8s-e2e/runner-owned-sessions-k8s-gap.test.ts');
    expect(e2e.bareTeardowns.length).toBeGreaterThan(0);
    expect(e2e.maxDeclaredTestTimeout).toBe(180_000);
    // The main config EXCLUDES the e2e suite, so those files must not be scored
    // against it — and the main config's own suite must not be scored against e2e.
    const main = k8s.configs.find((c) => c.label === 'vitest.config.ts');
    expect(main.files.map(rel)).not.toContain('src/__tests__/k8s-e2e/runner-owned-sessions-k8s-gap.test.ts');
    expect(e2e.files.map(rel)).not.toContain('src/__tests__/acceptance.test.ts');
    // A shared helper claimed by no config counts against BOTH (over-read).
    expect(main.files.map(rel)).toContain('src/__tests__/k8s-e2e/helpers.ts');
    expect(e2e.files.map(rel)).toContain('src/__tests__/k8s-e2e/helpers.ts');
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

  it('does not resolve a const that is REASSIGNED anywhere in the file', () => {
    // Resolving `X` to its initialiser would read 5_000 where the hook gets
    // 30_000 — an under-read. It is reported instead. (Not a regex-era shape:
    // the regex resolver had the same hole; the reviewer of TASK-462 found it.)
    makePackage('reassigned-const', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        'let HOOK_MS = 5_000;',
        'beforeAll(async () => { await warm(); }, HOOK_MS);',
        '// written AFTER the hook call, which is what "anywhere in the file" claims',
        'HOOK_MS = 30_000;',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/reassigned-const');
    expect(pkg.unreadable.map((u) => u.name)).toEqual(['HOOK_MS']);
    expect(pkg.maxDeclaredHookTimeout).toBe(0); // the stale 5_000 must not leak in either
  });

  it('does not resolve a numeric const that is SHADOWED by a non-numeric binding of the same name', () => {
    // The scan is not scope-aware. Before this was closed, the inner `X` (not a
    // numeric literal, so absent from the const table) let the hook resolve to
    // the OUTER 5_000 — an under-read with nothing reported. MEASURED by the
    // independent review of abdfb244: declared 5000, unreadable [].
    makePackage('shadowed-non-numeric', {
      testSource: [
        "import { spawn } from 'node:child_process';",
        'const X = 5_000;',
        'describe("inner", () => {',
        '  const X = 2 * 60_000;',
        '  beforeAll(async () => { await warm(); }, X);',
        '});',
      ].join('\n'),
      config: "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/shadowed-non-numeric');
    expect(pkg.unreadable.map((u) => u.name)).toEqual(['X']);
    expect(pkg.maxDeclaredHookTimeout).toBe(0);
  });

  it('does not resolve a const rebound through destructuring or a loop target', () => {
    for (const [pkgName, rebind] of [
      ['rebind-array', '[HOOK_MS] = [30_000];'],
      ['rebind-object', '({ HOOK_MS } = { HOOK_MS: 30_000 });'],
      ['rebind-for-of', 'for (HOOK_MS of [30_000]) {}'],
    ]) {
      makePackage(pkgName, {
        testSource: [
          "import { spawn } from 'node:child_process';",
          'let HOOK_MS = 5_000;',
          rebind,
          'beforeAll(async () => { await warm(); }, HOOK_MS);',
        ].join('\n'),
        config: "export default { test: { include: ['src/**/*.test.ts'] } };",
      });
    }
    const found = outOfProcessPackages(root);
    for (const pkgName of ['rebind-array', 'rebind-object', 'rebind-for-of']) {
      const pkg = found.find((p) => p.name === `packages/${pkgName}`);
      expect(pkg.unreadable.map((u) => u.name), pkgName).toEqual(['HOOK_MS']);
      expect(pkg.maxDeclaredHookTimeout, pkgName).toBe(0);
    }
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

  // TASK-567. The rule end to end: a real package tree, a real config import,
  // the real scan, the real verdict function. Each case differs from the first
  // in exactly one thing, so each one pins exactly one branch of the rule.
  describe('bare teardowns vs declared test budgets (TASK-567)', () => {
    const spawnLine = "import { spawn } from 'node:child_process';";
    const bigTest = "it('slow', { timeout: 180_000 }, async () => { await go(); });";
    const bareTeardown = 'afterAll(async () => { await container.stop(); });';

    async function verdict(name, { testSource, hookTimeout }) {
      const cfg =
        hookTimeout === undefined
          ? 'export default { test: { testTimeout: 60_000 } };'
          : `export default { test: { testTimeout: 60_000, hookTimeout: ${hookTimeout} } };`;
      makePackage(name, { testSource, config: cfg });
      const pkg = outOfProcessPackages(root).find((p) => p.name === `packages/${name}`);
      const resolvedByName = new Map([[pkg.name, await resolvePackageConfigs(pkg)]]);
      return { pkg, violations: bareTeardownViolations([pkg], resolvedByName, root) };
    }

    it('REDDENS: a bare teardown under a hookTimeout below the largest test budget — the TASK-567 shape', async () => {
      // `presets/k8s` on the day this landed: hookTimeout 120_000, three
      // `{ timeout: 180_000 }` canaries, `afterAll(() => pgContainer.stop())`.
      const { pkg, violations } = await verdict('bare-under-budget', {
        testSource: [spawnLine, bigTest, bareTeardown].join('\n'),
        hookTimeout: 120_000,
      });
      expect(pkg.unreadable).toEqual([]);
      expect(pkg.maxDeclaredTestTimeout).toBe(180_000);
      expect(pkg.bareTeardowns.map((t) => t.hook)).toEqual(['afterAll']);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('hookTimeout 120000 < 180000');
    });

    it('passes once hookTimeout reaches the test budget (the equality edge is allowed)', async () => {
      const { violations } = await verdict('bare-at-budget', {
        testSource: [spawnLine, bigTest, bareTeardown].join('\n'),
        hookTimeout: 180_000,
      });
      expect(violations).toEqual([]);
    });

    it('passes when the teardown carries its own timeout — it is not bare, and keeps the hook rule', async () => {
      const { pkg, violations } = await verdict('timed-teardown', {
        testSource: [spawnLine, bigTest, 'afterAll(async () => { await container.stop(); }, 90_000);'].join('\n'),
        hookTimeout: 120_000,
      });
      expect(pkg.bareTeardowns).toEqual([]);
      expect(pkg.maxDeclaredHookTimeout).toBe(90_000);
      expect(violations).toEqual([]);
    });

    it('passes when no test declares a budget — undeclared tests are not counted', async () => {
      const { violations } = await verdict('no-test-budget', {
        testSource: [spawnLine, "it('x', async () => { await go(); });", bareTeardown].join('\n'),
        hookTimeout: 120_000,
      });
      expect(violations).toEqual([]);
    });

    it('a bare beforeAll is NOT a teardown and does not trigger the rule', async () => {
      const { pkg, violations } = await verdict('bare-setup-only', {
        testSource: [spawnLine, bigTest, 'beforeAll(async () => { await warm(); });'].join('\n'),
        hookTimeout: 120_000,
      });
      expect(pkg.bareTeardowns).toEqual([]);
      expect(violations).toEqual([]);
    });

    it('REDDENS against vitest\'s 10_000 default when the config omits hookTimeout', async () => {
      // Fail closed: an absent key must not read as "unbounded".
      const { violations } = await verdict('default-hook-timeout', {
        testSource: [spawnLine, "it('x', async () => { await go(); }, 30_000);", 'afterEach(() => reset());'].join(
          '\n',
        ),
        hookTimeout: undefined,
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('hookTimeout 10000 < 30000');
    });

    it('is PACKAGE-wide: the budget and the bare teardown may live in different files', async () => {
      const { pkg: first } = await verdict('split-files', {
        testSource: [spawnLine, bigTest].join('\n'),
        hookTimeout: 120_000,
      });
      writeFileSync(join(first.dir, 'src', '__tests__', 'b.test.ts'), bareTeardown);
      const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/split-files');
      const resolvedByName = new Map([[pkg.name, await resolvePackageConfigs(pkg)]]);
      expect(bareTeardownViolations([pkg], resolvedByName, root)).toHaveLength(1);
    });

    it('REPORTS a test budget it cannot read in the package\'s unreadable list — never counts it as zero', () => {
      // Mutation-found (TASK-567): the scanner reported `testUnreadable`, but no
      // test checked the guard carried it through, so dropping that loop left
      // every assertion green while an unreadable 180s budget read as absent.
      makePackage('unreadable-test-budget', {
        testSource: [spawnLine, "it('slow', async () => { await go(); }, 3 * 60_000);", bareTeardown].join('\n'),
      });
      const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/unreadable-test-budget');
      expect(pkg.unreadable).toEqual([expect.objectContaining({ why: 'test-expr', name: '3 * 60_000' })]);
      expect(pkg.maxDeclaredTestTimeout).toBe(0);
    });

    it('fails CLOSED for a package whose config budgets were never read', () => {
      makePackage('never-read', { testSource: [spawnLine, bigTest, bareTeardown].join('\n') });
      const pkg = outOfProcessPackages(root).find((p) => p.name === 'packages/never-read');
      expect(bareTeardownViolations([pkg], new Map(), root)).toHaveLength(1);
    });
  });

  // TASK-575. Both rules used to read only `vitest.config.ts`, so a second
  // config — `presets/k8s/vitest.config.k8s-e2e.ts`, hookTimeout 60_000 against
  // `{ timeout: 180_000 }` tests and a bare `afterAll` — broke the TASK-567 rule
  // where nothing looked. Each case builds the two-config shape and changes one
  // thing, so each pins one branch of discovery, mapping, or fail-closed.
  describe('every vitest config a package uses is checked, against the files it runs (TASK-575)', () => {
    const spawnLine = "import { spawn } from 'node:child_process';";
    const bigTest = "it('slow', { timeout: 180_000 }, async () => { await go(); });";
    const bareTeardown = 'afterAll(async () => { await cleanup(); });';
    const MAIN = [
      'export default { test: {',
      "  include: ['src/__tests__/**/*.test.ts'],",
      "  exclude: ['src/__tests__/e2e/**'],",
      '  testTimeout: 60_000,',
      '  hookTimeout: 60_000,',
      '} };',
    ].join('\n');
    const e2eConfig = (hookTimeout, extra = '') =>
      [
        'export default { test: {',
        "  include: ['src/__tests__/e2e/**/*.test.ts'],",
        '  testTimeout: 240_000,',
        ...(hookTimeout === undefined ? [] : [`  hookTimeout: ${hookTimeout},`]),
        extra,
        '} };',
      ].join('\n');

    /**
     * `packages/<name>`: a spawning main suite (`a.test.ts`, no budgets), an e2e
     * suite at `src/__tests__/e2e/e.test.ts`, the MAIN config, and whatever
     * extra files (`{ relPath: text }`) the case adds.
     */
    async function resolveFixture(name, { e2eSource, files = {}, scripts }) {
      const dir = makePackage(name, { testSource: [spawnLine, "it('x', () => {});"].join('\n'), config: MAIN });
      mkdirSync(join(dir, 'src', '__tests__', 'e2e'), { recursive: true });
      writeFileSync(join(dir, 'src', '__tests__', 'e2e', 'e.test.ts'), e2eSource);
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
      }
      if (scripts !== undefined) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, scripts }));
      const pkg = outOfProcessPackages(root).find((p) => p.name === `packages/${name}`);
      const resolved = await resolvePackageConfigs(pkg);
      const byName = new Map([[pkg.name, resolved]]);
      return {
        pkg,
        resolved,
        bare: bareTeardownViolations([pkg], byName, root),
        hook: hookRuleViolations([pkg], byName),
        config: configDeclarationProblems([pkg], byName),
      };
    }

    it('REDDENS: a secondary config found by NAME, whose own hookTimeout is below its tests — the k8s-e2e shape', async () => {
      const { bare, config } = await resolveFixture('secondary-by-name', {
        e2eSource: [bigTest, bareTeardown].join('\n'),
        files: { 'vitest.config.e2e.ts': e2eConfig(60_000) },
      });
      expect(config).toEqual([]);
      expect(bare).toHaveLength(1);
      expect(bare[0]).toContain('[vitest.config.e2e.ts]');
      expect(bare[0]).toContain('hookTimeout 60000 < 180000');
    });

    it('passes once the secondary config reaches the budget — and the MAIN config is not charged for e2e files it excludes', async () => {
      // The main config's hookTimeout (60_000) is below the e2e test budget.
      // Package-wide scoring (the pre-TASK-575 unit) would redden it; per-config
      // mapping must not, because `pnpm test` never runs those files.
      const { bare, resolved } = await resolveFixture('secondary-at-budget', {
        e2eSource: [bigTest, bareTeardown].join('\n'),
        files: { 'vitest.config.e2e.ts': e2eConfig(180_000) },
      });
      expect(bare).toEqual([]);
      const main = resolved.configs.find((c) => c.label === 'vitest.config.ts');
      expect(main.maxDeclaredTestTimeout).toBe(0);
      expect(main.bareTeardowns).toEqual([]);
    });

    it('REDDENS the MAIN config when the e2e files are NOT excluded from it — mapping follows include/exclude, not the directory name', async () => {
      const { bare } = await resolveFixture('main-runs-e2e', {
        e2eSource: [bigTest, bareTeardown].join('\n'),
        files: {
          'vitest.config.ts': MAIN.replace("  exclude: ['src/__tests__/e2e/**'],\n", ''),
          'vitest.config.e2e.ts': e2eConfig(180_000),
        },
      });
      expect(bare).toHaveLength(1);
      expect(bare[0]).toContain('[vitest.config.ts]');
    });

    it('REDDENS the hook rule per config: a secondary config below a hook budget in a file it runs', async () => {
      const { hook } = await resolveFixture('secondary-hook-rule', {
        e2eSource: "beforeAll(async () => { await boot(); }, 120_000);\nit('x', () => {});",
        files: { 'vitest.config.e2e.ts': e2eConfig(60_000) },
      });
      expect(hook).toHaveLength(1);
      expect(hook[0]).toContain('[vitest.config.e2e.ts]: hookTimeout 60000 < 120000');
    });

    it('finds a config named ONLY by a package.json script, however it is spelled', async () => {
      for (const [i, cmd] of [
        'vitest run --config configs/e2e.ts',
        'vitest run --config=configs/e2e.ts',
        'vitest run -c configs/e2e.ts',
        'AX_E2E=1 vitest run --config "configs/e2e.ts"',
      ].entries()) {
        const { bare, config } = await resolveFixture(`script-config-${i}`, {
          e2eSource: [bigTest, bareTeardown].join('\n'),
          files: { 'configs/e2e.ts': e2eConfig(60_000) },
          scripts: { test: 'vitest run', 'test:e2e': cmd },
        });
        expect(config, cmd).toEqual([]);
        expect(bare, cmd).toHaveLength(1);
        expect(bare[0], cmd).toContain('configs/e2e.ts (script "test:e2e")');
      }
    });

    it('fails CLOSED on a secondary config it cannot read — a throw, no hookTimeout, or a fan-out', async () => {
      const cases = [
        ['secondary-throws', "throw new Error('boom');", 'config not readable'],
        ['secondary-no-hook', e2eConfig(undefined), "no hookTimeout (inherits vitest's 10s)"],
        ['secondary-projects', e2eConfig(180_000, "  projects: ['a'],"), 'sets test.projects'],
        ['secondary-include-source', e2eConfig(180_000, "  includeSource: ['src/**/*.ts'],"), 'includeSource'],
        ['secondary-dir', e2eConfig(180_000, "  dir: 'src',"), 'sets test.dir'],
        ['secondary-negated', e2eConfig(180_000, "  include: ['!x/**'],"), 'negated'],
      ];
      for (const [name, text, why] of cases) {
        const { config } = await resolveFixture(name, {
          e2eSource: [bigTest, bareTeardown].join('\n'),
          files: { 'vitest.config.e2e.ts': text },
        });
        expect(config, name).toEqual([expect.stringContaining(why)]);
        expect(config[0], name).toContain('[vitest.config.e2e.ts]');
      }
    });

    it('fails CLOSED on a script it cannot follow — a missing config, a variable, an unmapped flag, a broken package.json', async () => {
      const cases = [
        ['script-missing', { 'test:e2e': 'vitest run --config nope.ts' }, 'nope.ts, which does not exist'],
        ['script-variable', { 'test:e2e': 'vitest run --config $CFG' }, 'cannot resolve: $CFG'],
        ['script-root', { 'test:e2e': 'vitest run --root e2e' }, 'cannot map files through'],
        ['script-project', { 'test:e2e': 'vitest run --project e2e' }, 'cannot map files through'],
      ];
      for (const [name, scripts, why] of cases) {
        const { config } = await resolveFixture(name, { e2eSource: "it('x', () => {});", scripts });
        expect(config, name).toEqual([expect.stringContaining(why)]);
      }
      const { config } = await resolveFixture('pkgjson-broken', {
        e2eSource: "it('x', () => {});",
        files: { 'package.json': '{ not json' },
      });
      expect(config).toEqual([expect.stringContaining('package.json does not parse')]);
    });

    it('a shared helper no config includes is charged to EVERY config (over-read, the safe direction)', async () => {
      // `presets/k8s/src/__tests__/k8s-e2e/helpers.ts` is the real instance: a
      // non-test file can register hooks for whichever test imports it.
      const { pkg, bare, resolved } = await resolveFixture('shared-helper', {
        e2eSource: "it('x', () => {});",
        files: {
          'vitest.config.e2e.ts': e2eConfig(180_000),
          'src/__tests__/helpers.ts': [bigTest.replace('it(', 'export const t = () => it('), bareTeardown].join('\n'),
        },
      });
      for (const c of resolved.configs) {
        expect(c.files.map((f) => relative(pkg.dir, f)), c.label).toContain(join('src', '__tests__', 'helpers.ts'));
      }
      // Main (60_000) is charged with the helper's 180_000 and bare teardown; e2e (180_000) is not below it.
      expect(bare).toEqual([expect.stringContaining('[vitest.config.ts]')]);
    });

    it('does not treat a setup file as a config', async () => {
      const { resolved } = await resolveFixture('setup-file', {
        e2eSource: "it('x', () => {});",
        files: { 'vitest.setup.ts': 'export {};' },
      });
      expect(resolved.configs.map((c) => c.label)).toEqual(['vitest.config.ts']);
    });
  });

  // Bare, like the setup hook, and for the same reason: what the suite's
  // `hookTimeout` governs is the hooks that don't argue with it.
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
});

// TASK-567: what `scanTestTimeouts` reads out of a test call, one hostile shape
// per row (the #715 pattern). Each row names the test budget maximum it must
// report, the arguments it must REPORT as unreadable (fail closed), and how many
// bare teardowns it must count. The row count is pinned below so a deleted row
// is a red, not a silent loss of coverage.
describe('scanTestTimeouts reads test budgets and bare teardowns (TASK-567)', () => {
  const ROWS = [
    // --- budgets that must be READ ---
    ['numeric third argument', "it('x', () => {}, 30_000);", { max: 30_000 }],
    ['options object second', "it('x', { timeout: 40_000 }, () => {});", { max: 40_000 }],
    ['options object third', "it('x', () => {}, { timeout: 45_000 });", { max: 45_000 }],
    ['string-keyed timeout', "it('x', { 'timeout': 12_000 }, () => {});", { max: 12_000 }],
    ['shorthand { timeout }', "const timeout = 50_000;\nit('x', { timeout }, () => {});", { max: 50_000 }],
    ['file-local const', "const T = 60_000;\nit('x', () => {}, T);", { max: 60_000 }],
    ['parenthesised literal', "it('x', () => {}, (33_000));", { max: 33_000 }],
    // `presets/k8s`' real spelling. The condition is the modifier's argument, never a budget.
    ['it.skipIf(c)(…) chain', "it.skipIf(!E2E)('x', { timeout: 70_000 }, async () => {});", { max: 70_000 }],
    // The table is `it.each`'s argument, never a budget.
    ['it.each(t)(…) chain', "it.each([[1], [2]])('x %s', () => {}, 80_000);", { max: 80_000 }],
    ['test.concurrent', "test.concurrent('x', () => {}, 25_000);", { max: 25_000 }],
    ['it.only', "it.only('x', () => {}, 26_000);", { max: 26_000 }],
    // vitest's describe options set the budget of every test inside.
    ['describe options', "describe('d', { timeout: 90_000 }, () => {});", { max: 90_000 }],
    ['nested in describe body', "describe('d', () => {\n  it('x', () => {}, 34_000);\n});", { max: 34_000 }],
    ['maximum of two', "it('a', () => {}, 10_000);\nit('b', () => {}, 20_000);", { max: 20_000 }],
    // --- no budget at all: nothing read, nothing reported ---
    ['options without timeout', "it('x', { retry: 2 }, () => {});", { max: 0 }],
    ['undeclared test', "it('x', () => {});", { max: 0 }],
    ['a hook budget is not a test budget', 'beforeAll(() => {}, 99_000);', { max: 0 }],
    ['a method named test is not a test call', "const ok = /a/.test('a', 99_000);", { max: 0 }],
    ['no test or hook word at all', 'export const x = 1;', { max: 0 }],
    // --- budgets that must be REPORTED, never counted as zero ---
    ['spread options', "it('x', { ...opts }, () => {});", { max: 0, unreadable: ['...opts'] }],
    ['computed key', "it('x', { [k]: 1 }, () => {});", { max: 0, unreadable: ['[k]: 1'] }],
    ['arithmetic budget', "it('x', () => {}, 2 * 60_000);", { max: 0, unreadable: ['2 * 60_000'] }],
    [
      'arithmetic timeout in options',
      "it('x', { timeout: 2 * 60_000 }, () => {});",
      { max: 0, unreadable: ['timeout: 2 * 60_000'] },
    ],
    [
      'timeout as a method',
      "it('x', { timeout() { return 1; } }, () => {});",
      { max: 0, unreadable: ['timeout() { return 1; }'] },
    ],
    ['imported name', "import { T } from './b.js';\nit('x', () => {}, T);", { max: 0, unreadable: ['T'] }],
    [
      'reassigned const',
      "let T = 5_000;\nT = 90_000;\nit('x', () => {}, T);",
      { max: 0, unreadable: ['T'] },
    ],
    // Fail closed at a cost: an unresolved name might be a function reference or
    // a budget, and this cannot tell which. Spurious red, never a hidden budget.
    ['function reference', "it('x', runCase);", { max: 0, unreadable: ['runCase'] }],
    // --- bare teardowns ---
    ['bare afterAll', 'afterAll(async () => { await stop(); });', { max: 0, bare: 1 }],
    ['bare afterEach + timed afterAll', 'afterEach(() => {});\nafterAll(() => {}, 5_000);', { max: 0, bare: 1 }],
    ['bare beforeAll is not a teardown', 'beforeAll(() => {});\nbeforeEach(() => {});', { max: 0, bare: 0 }],
    ['teardown through a property', 'vitest.afterAll(() => {});', { max: 0, bare: 1 }],
    // A second argument, however odd, makes the teardown not bare; the hook rule
    // then reports `undefined` as an unreadable hook budget.
    ['afterAll(fn, undefined)', 'afterAll(() => {}, undefined);', { max: 0, bare: 0, hookUnreadable: ['undefined'] }],
  ];

  it('has the pinned number of rows — a deleted row reddens here', () => {
    expect(ROWS.length).toBe(32);
  });

  it.each(ROWS)('%s', (_name, source, want) => {
    const scan = scanTestTimeouts(source, 'fixture.test.ts');
    expect(scan.parseErrors).toEqual([]);
    expect(Math.max(0, ...scan.testDeclared.map((d) => d.ms))).toBe(want.max);
    expect(scan.testUnreadable.map((u) => u.expr)).toEqual(want.unreadable ?? []);
    expect(scan.bareTeardowns.length).toBe(want.bare ?? 0);
    expect(scan.unreadable.map((u) => u.expr)).toEqual(want.hookUnreadable ?? []);
  });

  it('scanHookTimeouts still returns exactly its three hook fields — its sibling guard reads them', () => {
    const r = scanHookTimeouts("afterAll(() => {}, 7_000);\nit('x', () => {}, 30_000);", 'f.test.ts');
    expect(Object.keys(r).sort()).toEqual(['declared', 'parseErrors', 'unreadable']);
    expect(r.declared.map((d) => d.ms)).toEqual([7_000]);
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
