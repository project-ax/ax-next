// Guard: the `scripts` vitest root declares its own test and hook budgets, and
// never budgets a bare hook below what a hook in this suite already asks for.
//
// Why this exists (TASK-331). `pnpm test:scripts` is `vitest run --root scripts`,
// and this directory had no vitest config at all — so every test here ran on
// vitest's `testTimeout: 5_000` / `hookTimeout: 10_000` defaults. That is a
// problem specific to THIS suite, because these guards are the only ones in the
// repo that do heavy out-of-process work as a matter of course: they spawn real
// `bash`, `zsh`, `git` and stub-`gh` subprocesses, and
// `eslint-ignores-worktrees.test.js` resolves the real `eslint.config.mjs`
// through ESLint's own loader.
//
// What went wrong, measured rather than reasoned about. On 2026-08-24 a single
// `pnpm test:scripts` run — fired straight after a full 78-package
// `pnpm -r --no-bail run test` — reported:
//
//     Tests  1 failed | 152 passed (153)
//
// and then passed 8 times in a row, with the failing test's name never captured.
// That count line is the whole trap: a vitest **test timeout** is counted in the
// collected total and reported as one failed test, so it is indistinguishable in
// the summary from a genuine assertion failure. (Probed directly: a test that
// sleeps past the default budget alongside 5 passing ones prints
// `Tests  1 failed | 5 passed (6)`.) The card for TASK-331 read the intact total
// as proof of an assertion failure — i.e. of a real product race — and so did
// this repo's own triage heuristic. Both were wrong for this suite.
//
// The actual culprit, reproduced 6/10 runs under ~11x CPU oversubscription, is
// `eslint-ignores-worktrees.test.js`'s first test. It used to pay ESLint's
// flat-config cold load — typescript-eslint and every plugin — inside its own
// per-test budget: ~1.1s on an idle machine, which is 2.7x the next slowest test
// in the suite and leaves only 4.5x headroom against 5_000ms. Measured peaks for
// that one test as contention rises: 2_693ms at 2x oversubscription, 3_959ms at
// 6x, 7_207ms at 11x. It is now warmed in a `beforeAll` so the per-test clock
// only ever sees the cached lookup.
//
// This guard is the tripwire for the configuration half of that fix, and it is
// deliberately narrow in the same way its container-package sibling is: it
// insists the two budgets are DECLARED and mutually consistent, and takes no
// position on their size. A budget too small for legitimate work is a bug; one
// raised past a genuine hang is a mask. Neither is decidable from source shape.
//
// Scoped to `scripts` on purpose. `eslint-rules`, the repo's other bare vitest
// root, was measured at the same time: its slowest test is 13ms — 385x headroom
// — and nothing in it leaves the process. Extending this guard there would be
// symmetry, not evidence.
//
// Runs under `pnpm test:scripts` with no network, no Docker, and no build.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = join(SCRIPTS_ROOT, '__tests__');

// `.mjs`, not `.ts`: this directory is plain ESM JavaScript, no tsconfig reaches
// it, and `vitest run --root scripts` resolves a `.mjs` config natively.
const CONFIG_PATH = join(SCRIPTS_ROOT, 'vitest.config.mjs');

/**
 * Strip `/* *\/` and `//` comments so the scans below read CODE, not prose.
 *
 * This is load-bearing, and it is here because the first draft of this file
 * proved why. `readTimeout` without it matched the phrase
 * "vitest's `hookTimeout: 10_000` defaults" in the new config's own explanatory
 * comment — ahead of the real setting further down — and the guard failed
 * demanding that 10_000 be raised to 120_000. A guard steered by the prose
 * beside the code is worse than a strict one: the same mistake pointed the other
 * way (a comment naming a LARGER number) would have passed a config that was too
 * low, silently. The same applies to the hook scan: an example hook written in a
 * doc comment, like the `}, 60_000)` in HOOK_WITH_TIMEOUT's own docs below,
 * otherwise counts toward the suite maximum and can demand a budget nobody asked
 * for.
 *
 * Conservative by design. `//` is only treated as a comment when it is not
 * preceded by `:` or `\`, so URLs and escaped slashes survive; a `//` inside a
 * string or regex literal is still stripped, which is acceptable because the only
 * thing read out of the result is a numeric timeout literal, and the vacuity
 * guard plus the explicit expected values below keep any mangling visible rather
 * than silent.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Read a numeric `test.<key>` from a vitest config, tolerating `_` separators.
 * Returns `undefined` when the key is absent — which is the failure this guard
 * is chiefly looking for, so absent and zero must stay distinguishable.
 *
 * Mirrors the helper in `container-test-timeouts.test.js` rather than importing
 * it: these guard files are deliberately self-contained, so one can be deleted
 * with its subject without breaking another. NOTE that the sibling does NOT
 * strip comments, so it carries the hole described on `stripComments` above for
 * the 21 container packages it covers — worth closing, but not from here.
 */
function readTimeout(configText, key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*(\\d[\\d_]*)`).exec(stripComments(configText));
  return m ? Number(m[1].replace(/_/g, '')) : undefined;
}

/**
 * A hook that declares its own timeout: `beforeAll(async () => { ... }, 60_000);`
 *
 * Same pattern and same caveats as `container-test-timeouts.test.js`: the body
 * match is non-greedy, so in a file where a bare hook precedes a timed one the
 * argument can be attributed to the wrong hook. That is harmless here for the
 * same reason — the assertion below consumes the MAXIMUM over the suite, and
 * mis-attributing a value between two hooks cannot change a maximum. The closing
 * brace is indentation-tolerant (`\n\s*\}`) so that describe-nested hooks are
 * seen; anchoring it at column 0 is the bug that made the sibling guard green on
 * the very violation it was written to catch.
 */
const HOOK_WITH_TIMEOUT =
  /\b(?:beforeAll|afterAll|beforeEach|afterEach)\s*\([\s\S]*?\n\s*\}\s*,\s*(\d[\d_]*)\s*\)\s*;/g;

/**
 * The named-constant spelling of the same thing (`}, TIMEOUT_MS)`), which this
 * file cannot evaluate.
 *
 * Fail closed, for the reason the sibling guard documents at length: a budget
 * that is not read counts as absent, which LOWERS the suite maximum and lets the
 * consistency assertion pass a config that is too low — a guard that
 * under-reports is worse than no guard, because it also reports success.
 */
const UNREADABLE_HOOK_TIMEOUT =
  /\b(?:beforeAll|afterAll|beforeEach|afterEach)\s*\([\s\S]*?\n\s*\}\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*;/g;

const testFiles = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => ({ name: f, text: stripComments(readFileSync(join(TESTS_DIR, f), 'utf8')) }));

// Read once, and keep "absent" as a value rather than as a throw: a missing
// config is the headline failure, and it should be reported by the assertion
// written for it instead of surfacing as a raw ENOENT from a later test.
const configText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : undefined;

describe('the scripts vitest root declares its own timeouts (TASK-331)', () => {
  it('finds the scripts guard files at all — a scan that matches nothing would pass everything below', () => {
    // Vacuity guard. The consistency assertion below is a fold over `testFiles`,
    // so an empty scan makes it trivially green. 15 as this is written; the floor
    // is deliberately loose — this catches the scan BREAKING, not the count
    // changing.
    expect(testFiles.length).toBeGreaterThanOrEqual(10);
  });

  it('has a vitest config setting both testTimeout and hookTimeout', () => {
    // The defaults are the bug. 5_000ms is not a budget anyone chose for a suite
    // that shells out to real interpreters; it is what you get for not having a
    // config file, and it turned one slow-but-correct test into a phantom
    // assertion failure nobody could name.
    expect(
      configText,
      `${CONFIG_PATH} is missing — the suite would inherit vitest's 5s/10s defaults`,
    ).not.toBeUndefined();

    const missing = [];
    if (readTimeout(configText, 'testTimeout') === undefined) {
      missing.push("no testTimeout (inherits vitest's 5s)");
    }
    if (readTimeout(configText, 'hookTimeout') === undefined) {
      missing.push("no hookTimeout (inherits vitest's 10s)");
    }
    expect(missing).toEqual([]);
  });

  it('no guard file declares a hook timeout this test cannot read', () => {
    const unreadable = [];
    for (const { name, text } of testFiles) {
      for (const m of text.matchAll(UNREADABLE_HOOK_TIMEOUT)) {
        unreadable.push(`${name}: hook timeout \`${m[1]}\` is not a numeric literal`);
      }
    }
    expect(unreadable).toEqual([]);
  });

  it('hookTimeout is at least the largest timeout a hook in this suite declares', () => {
    // The subtler half, and the one that keeps the config honest as the suite
    // changes. An explicit timeout ARGUMENT on a hook overrides the config, so
    // the config's `hookTimeout` governs exactly the hooks that DON'T carry one —
    // in practice the teardowns. Without this, a file can say "warming the ESLint
    // config may take two minutes" while a bare `afterAll` beside it still gets
    // ten seconds.
    if (configText === undefined) return; // reported by the test above
    const configured = readTimeout(configText, 'hookTimeout');
    if (configured === undefined) return; // ditto

    let maxDeclared = 0;
    let declaredBy = '(none)';
    for (const { name, text: src } of testFiles) {
      for (const m of src.matchAll(HOOK_WITH_TIMEOUT)) {
        const v = Number(m[1].replace(/_/g, ''));
        if (v > maxDeclared) {
          maxDeclared = v;
          declaredBy = name;
        }
      }
    }

    expect(
      configured,
      `hookTimeout ${configured} < ${maxDeclared} declared by a hook in ${declaredBy} — ` +
        'a bare afterAll here gets less budget than its own suite asks for',
    ).toBeGreaterThanOrEqual(maxDeclared);
  });

  // The reader's own regression tests. These exist because the first draft of
  // this guard failed on exactly the input below: it read a number out of the
  // config's explanatory comment instead of the setting. Both directions matter,
  // and the second is the dangerous one — a comment naming a larger number makes
  // the guard PASS a config that is too low.
  describe('readTimeout reads the setting, not the prose beside it', () => {
    it('ignores a smaller number mentioned in a line comment', () => {
      const cfg = [
        "// This root ran on vitest's hookTimeout: 10_000 defaults until TASK-331.",
        'export default defineConfig({ test: { hookTimeout: 120_000 } });',
      ].join('\n');
      expect(readTimeout(cfg, 'hookTimeout')).toBe(120_000);
    });

    it('ignores a larger number mentioned in a block comment', () => {
      const cfg = [
        '/* Do not raise this to 600_000: hookTimeout: 600_000 would mask a hang. */',
        'export default defineConfig({ test: { hookTimeout: 120_000 } });',
      ].join('\n');
      expect(readTimeout(cfg, 'hookTimeout')).toBe(120_000);
    });

    it('still reports an absent setting as undefined rather than as zero', () => {
      expect(readTimeout('export default defineConfig({ test: {} });', 'hookTimeout')).toBeUndefined();
    });

    it('keeps a `://` URL out of the line-comment rule', () => {
      const cfg = [
        '// see https://vitest.dev/config/#hooktimeout',
        'export default defineConfig({ test: { hookTimeout: 120_000 } });',
      ].join('\n');
      expect(readTimeout(cfg, 'hookTimeout')).toBe(120_000);
    });
  });
});
