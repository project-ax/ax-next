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

// Every pattern below is anchored to the START of a line (`^[ \t]*`), and that
// anchor is the whole trick for reading CODE rather than the prose beside it.
//
// It is here because two earlier drafts of this file got it wrong in both
// directions, and the second way was the dangerous one.
//
// Draft 1 did not filter comments at all. `readTimeout` matched the phrase
// "vitest's `hookTimeout: 10_000` defaults" in the new config's own explanatory
// comment, ahead of the real setting further down, and the guard failed
// demanding that the COMMENT be raised to 120_000. Loud, and merely wrong.
//
// Draft 2 stripped comments first — `/*...*\/` then `//...` — and that was
// silently fail-OPEN, which is the mode `out-of-process-test-timeouts.test.js`'s
// header warns about at length. Several guards here discuss ESLint globs in
// line comments, e.g. "`**/worktrees/**` does cross dot-segments". That text
// contains `/*`, so the block-comment pass treated it as a comment OPENER and
// ate everything up to the next `*\/` — across real code. Measured: the suite
// maximum computed from the stripped sources was **0**, so this file's own
// `beforeAll(..., 120_000)` went unseen and the consistency assertion below
// passed vacuously. A guard that under-reports is worse than no guard, because
// it also reports success.
//
// Line anchoring needs no stripper, so it cannot mangle the source the way
// draft 2 did. It reaches past prose because a comment's continuation lines
// CONVENTIONALLY begin with a character that is not the identifier being
// matched: `//` for line comments, ` * ` for a starred block. So
// `^[ \t]*hookTimeout` and `^[ \t]*beforeAll` are unreachable from inside either
// style as this repo writes them, while indentation-tolerance still finds a
// describe-nested hook (the column-0 anchor is the bug that made the sibling
// guard green on the very violation it was written to catch).
//
// That is a CONVENTION, not a language guarantee, and it is stated here rather
// than implied away — the sibling guard documents its own gaps the same way, and
// an absolute claim is the failure this guard family exists to make harder. JS
// does not require a block comment's continuation lines to start with `*`, and
// nothing machine-enforces it here (there is no `multiline-comment-style`
// eslint rule and no prettier config). A column-0 continuation line INSIDE a
// block comment therefore defeats the anchor. Measured, and the two scans fail
// in OPPOSITE directions, which is what decides how much each one matters:
//
//   - `readTimeout` is the fail-OPEN one, and the only one worth closing. A
//     block comment whose column-0 line reads `hookTimeout: 600_000` is matched
//     ahead of a real, lower setting, and the consistency assertion then passes
//     a budget nobody checked. `noBlockCommentsInConfig` below closes that for
//     real, on the 37-line file this guard owns, instead of trusting the
//     convention.
//   - `HOOK_WITH_TIMEOUT` is fail-CLOSED. A column-0 example hook inside a
//     block comment inflates the suite maximum, so the assertion demands a
//     budget nobody asked for and reddens loudly. Annoying, never silent, so it
//     is documented rather than guarded.
//
// The other way it errs closed: a real setting sharing a line with another
// — `test: { testTimeout: 30_000, hookTimeout: 120_000 }` — reads as ABSENT and
// fails the "declares both" assertion loudly, rather than passing a budget
// nobody checked. One key per line is the price, and
// `scripts/vitest.config.mjs` pays it.

/**
 * Read a numeric `test.<key>` from a vitest config, tolerating `_` separators.
 * Returns `undefined` when the key is absent — which is the failure this guard
 * is chiefly looking for, so absent and zero must stay distinguishable.
 *
 * The sibling guard (`out-of-process-test-timeouts.test.js`) used to carry a
 * copy of this helper, unanchored, and this comment used to say so and call it
 * "worth closing, but not from here". TASK-400 closed it differently: that guard
 * now IMPORTS each package's `vitest.config.ts` and reads the resolved object,
 * which removes the comments-vs-code question rather than answering it. Doing
 * the same here would mean importing `scripts/vitest.config.mjs` — possible, and
 * left alone deliberately, because this file's fail-open residue is already shut
 * by `noBlockCommentsInConfig` below on the one 37-line file it owns, and text
 * scanning keeps this guard readable without a hook.
 */
function readTimeout(configText, key) {
  const m = new RegExp(`^[ \\t]*${key}\\s*:\\s*(\\d[\\d_]*)`, 'm').exec(configText);
  return m ? Number(m[1].replace(/_/g, '')) : undefined;
}

/**
 * A hook that declares its own timeout: `beforeAll(async () => { ... }, 60_000);`
 *
 * Same pattern and same caveats as `out-of-process-test-timeouts.test.js`: the body
 * match is non-greedy, so in a file where a bare hook precedes a timed one the
 * argument can be attributed to the wrong hook. That is harmless here for the
 * same reason — the assertion below consumes the MAXIMUM over the suite, and
 * mis-attributing a value between two hooks cannot change a maximum. Both the
 * opening keyword and the closing brace are indentation-tolerant — `^[ \t]*` and
 * `\n[ \t]*\}` — so describe-nested hooks are seen; anchoring either at column 0
 * is the bug that made the sibling guard green on the very violation it was
 * written to catch. `[ \t]` rather than `\s` on purpose: `\s` matches newlines,
 * which would let the anchor drift off the line it is meant to pin.
 */
const HOOK_WITH_TIMEOUT =
  /^[ \t]*(?:beforeAll|afterAll|beforeEach|afterEach)\s*\([\s\S]*?\n[ \t]*\}\s*,\s*(\d[\d_]*)\s*\)\s*;/gm;

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
  /^[ \t]*(?:beforeAll|afterAll|beforeEach|afterEach)\s*\([\s\S]*?\n[ \t]*\}\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*;/gm;

const testFiles = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => ({ name: f, text: readFileSync(join(TESTS_DIR, f), 'utf8') }));

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

  it('the config carries no block comment, so a column-0 line cannot outrank the setting', () => {
    // Closes the one fail-OPEN residue of line anchoring (see the note above) on
    // the one file where it is cheap to close: this config is 37 lines and this
    // guard owns it. JS does not require a block comment's continuation lines to
    // begin with `*`, and nothing here enforces it, so a column-0
    // `hookTimeout: 600_000` inside a `/* ... */` would be read ahead of a real,
    // lower setting and pass a budget nobody checked. Having no block comment at
    // all makes that unreachable rather than merely unlikely.
    //
    // If a block comment is genuinely wanted here, this assertion is the wrong
    // thing to delete — teach `readTimeout` to skip block comments first, then
    // delete it.
    if (configText === undefined) return; // reported by the test above
    expect(
      configText.includes('/*'),
      'scripts/vitest.config.mjs must use `//` comments only — see the anchoring note in this file',
    ).toBe(false);
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

  // The scanners' own regression tests. Every case below is one this file got
  // wrong before it got it right, which is why they are pinned rather than
  // assumed. The dangerous direction is the LAST two: a scan that silently
  // misses a real value passes a config nobody checked.
  describe('the scanners read code, not the prose beside it', () => {
    const CONFIG = ['export default defineConfig({', '  test: {', '    hookTimeout: 120_000,', '  },', '});'];

    it('ignores a smaller number named in a line comment (draft 1 read this one)', () => {
      expect(
        readTimeout(["// it ran on vitest's `hookTimeout: 10_000` defaults", ...CONFIG].join('\n'), 'hookTimeout'),
      ).toBe(120_000);
    });

    it('ignores a LARGER number named in a block comment', () => {
      // The fail-open direction: believing this comment would pass a 120s config
      // as though it were budgeted for 600s.
      expect(
        readTimeout(['/**', ' * Never raise hookTimeout: 600_000 — it would mask a hang.', ' */', ...CONFIG].join('\n'), 'hookTimeout'),
      ).toBe(120_000);
    });

    it('reads two settings on ONE line as absent — the fail-closed direction', () => {
      // Documented above but previously unpinned, which in a file whose whole
      // ethos is "pin every case" was an omission. Absent reddens the
      // "declares both" assertion loudly; it never passes an unchecked budget.
      expect(
        readTimeout('  test: { testTimeout: 30_000, hookTimeout: 120_000 },', 'hookTimeout'),
      ).toBeUndefined();
    });

    it('a column-0 line inside a block comment DOES defeat the anchor (known gap)', () => {
      // Pinned as a known limitation, not as desired behaviour — the same way
      // the sibling guard states its blind spots rather than implying them away.
      // This is why `noBlockCommentsInConfig` exists for the file `readTimeout`
      // reads. If someone teaches the reader to skip block comments, this
      // assertion should flip to `toBe(120_000)` and the config guard can go.
      const cfg = ['/*', 'hookTimeout: 600_000', '*/', '    hookTimeout: 120_000,'].join('\n');
      expect(readTimeout(cfg, 'hookTimeout')).toBe(600_000);
    });

    it('reports an absent setting as undefined, never as zero', () => {
      expect(readTimeout('export default defineConfig({ test: {} });', 'hookTimeout')).toBeUndefined();
      // Zero is a real (terrible) budget and must stay distinguishable from absent.
      expect(readTimeout('    hookTimeout: 0,', 'hookTimeout')).toBe(0);
    });

    it('finds a describe-nested hook, not just a top-level one', () => {
      // The indentation-tolerant anchor. A column-0-only anchor is what made the
      // sibling guard green on the violation it was written to catch.
      const src = ['describe("x", () => {', '  beforeAll(async () => {', '    await warm();', '  }, 120_000);', '});'].join('\n');
      expect([...src.matchAll(HOOK_WITH_TIMEOUT)].map((m) => m[1])).toEqual(['120_000']);
    });

    it('does not count a hook written as an example inside a doc comment', () => {
      const src = [
        '/**', ' * A hook that declares its own timeout:', ' *', ' *     beforeAll(async () => {', ' *       await x();', ' *     }, 600_000);', ' */', 'it("real", () => {});',
      ].join('\n');
      expect([...src.matchAll(HOOK_WITH_TIMEOUT)].map((m) => m[1])).toEqual([]);
    });

    it("still sees this suite's own real hook — the fail-open case draft 2 hit", () => {
      // Draft 2 stripped comments before scanning, and a line comment discussing
      // the glob `**/worktrees/**` opened a phantom block comment that swallowed
      // real code: the suite maximum came out 0 and this file's consistency
      // assertion passed vacuously. Assert the positive, against the real file.
      const src = testFiles.find((f) => f.name === 'eslint-ignores-worktrees.test.js');
      expect(src, 'eslint-ignores-worktrees.test.js is missing from the scan').not.toBeUndefined();
      expect(src.text).toContain('**/worktrees/**'); // the text that broke draft 2
      expect([...src.text.matchAll(HOOK_WITH_TIMEOUT)].map((m) => m[1])).toEqual(['120_000']);
    });
  });
});
