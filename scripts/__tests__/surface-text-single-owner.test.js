// Guard: the "rewrites the surface" character class has exactly one owner —
// packages/core/src/surface-text.ts (TASK-562, CLAUDE.md invariant 4).
//
// Before TASK-562 the class lived in seven hand-kept copies across six packages,
// each with a comment asking the reader to "keep the two in step". They had not
// stayed in step: six of the seven stopped short of U+2060-U+2064 and
// U+2028/U+2029, and the validator scanners carried a narrower subset still.
// A new copy is how that happens again, so this fails the PR that adds one.
//
// WHY IT LIVES HERE. CI's PR `test` job runs only the packages a PR changes plus
// their dependents. A copy added to, say, @ax/teams would not select @ax/core's
// suite. `pnpm test:scripts` runs on EVERY PR, so it catches the copy where it
// lands (the same reasoning as slot-vocabulary-single-owner.test.js).
//
// WHAT IT CATCHES. Every bidi override/embedding (U+202A-U+202E) and isolate
// (U+2066-U+2069) is the unmistakable anchor of this class: no other code in the
// repo has a reason to name one. So a production source file that names any of
// them — as a `\uXXXX` escape, a `\u{XXXX}` escape, a `0xXXXX` number (for
// `String.fromCharCode`), or the literal character itself — is reported, unless
// it is the owner.
//
// WHAT IT CANNOT SEE, stated rather than implied away:
//   - A copy that omits every bidi control (e.g. only zero-width characters).
//     That is a narrower class, not a copy of this one; it is also exactly the
//     bug TASK-562 fixed in the validators, so review should still catch it.
//   - A class built at runtime from parts (`'\\u20' + '2E'`), or spelled with
//     `\p{Bidi_Control}` — the latter is a legitimate alternative spelling this
//     guard would let through.
//   - Test files. They are excluded on purpose: a test that feeds U+202E into a
//     fence has to name it. Tests that assert on the class should import it.
//   - Files that are not JS/TS, under packages/ and presets/.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HIDDEN_FORMAT_CHARS, REWRITES_THE_SURFACE } from '../../packages/core/src/surface-text.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER = 'packages/core/src/surface-text.ts';
const ROOTS = ['packages', 'presets'];
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_PATH = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

// The anchor code points, as hex digits without the leading zeroes.
const ANCHORS = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

const hex = ANCHORS.map((cp) => cp.toString(16)).join('|');
/**
 * `‮`, `\u{202E}` / `\u{0202e}`, `0x202E`, or the character itself. Escapes
 * are matched case-insensitively; a doubled backslash (`\\u202E` inside a
 * string that builds a RegExp) still contains `‮` and is caught.
 */
const ANCHOR_RE = new RegExp(
  `\\\\u(?:${hex})|\\\\u\\{0*(?:${hex})\\}|0x0*(?:${hex})\\b|[${ANCHORS.map((cp) => String.fromCodePoint(cp)).join('')}]`,
  'i',
);

/** Returns the 1-based line numbers in `source` that name an anchor. */
export function anchorLines(source) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    if (ANCHOR_RE.test(line)) out.push(i + 1);
  });
  return out;
}

function productionSources() {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return listed
    .split('\0')
    .filter((p) => p.length > 0 && SCRIPT.test(p) && !TEST_PATH.test(p));
}

describe('surface-text class has one owner (TASK-562)', () => {
  it('finds no copy of the class outside packages/core/src/surface-text.ts', () => {
    const files = productionSources();
    // A walk that found nothing checked nothing; that must not read as a pass.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(OWNER);

    const offenders = [];
    for (const path of files) {
      if (path === OWNER) continue;
      const lines = anchorLines(readFileSync(join(REPO_ROOT, path), 'utf8'));
      if (lines.length > 0) offenders.push(`${path}:${lines.join(',')}`);
    }
    expect(
      offenders,
      'A second copy of the surface-rewriting character class. Import ' +
        "REWRITES_THE_SURFACE / HIDDEN_FORMAT_CHARS / replaceSurfaceRewriters from '@ax/core/surface-text' " +
        'instead, and widen the class there if it is missing something.',
    ).toEqual([]);
  });

  it('the owner still covers every anchor, and the scan can see it do so', () => {
    for (const cp of ANCHORS) {
      const c = String.fromCodePoint(cp);
      expect(REWRITES_THE_SURFACE.test(c), cp.toString(16)).toBe(true);
      expect(HIDDEN_FORMAT_CHARS.test(c), cp.toString(16)).toBe(true);
    }
    // If the owner stopped naming the anchors this guard keys on, the scan
    // above would be looking for a spelling nobody uses any more.
    expect(anchorLines(readFileSync(join(REPO_ROOT, OWNER), 'utf8')).length).toBeGreaterThan(0);
  });

  // The scanner against the shapes the old copies actually took, plus the ones a
  // new copy plausibly would. Each must be reported.
  it.each([
    ['a regex-literal copy', 'const R = /[\\u0000-\\u001F\\u202A-\\u202E]+/g;'],
    ['a lowercase copy', 'const R = /[\\u202a-\\u202e]/gu;'],
    ['an isolate-only copy', 'const R = /[\\u2066-\\u2069]/;'],
    ['a string-built RegExp', "new RegExp('[\\\\u202A-\\\\u202E]')"],
    ['a code-point escape', 'const R = /[\\u{202E}]/u;'],
    ['a padded code-point escape', 'const R = /[\\u{0202e}]/u;'],
    ['a fromCharCode number', 'String.fromCharCode(0x202E)'],
    ['the literal RLO character', `const R = /[${String.fromCodePoint(0x202e)}]/;`],
    ['the literal PDI character', `const R = /[${String.fromCodePoint(0x2069)}]/;`],
  ])('reports %s', (_label, line) => {
    expect(anchorLines(`// header\n${line}\n`)).toEqual([2]);
  });

  it.each([
    ['prose naming the code point', '// A lone U+202E reverses the text after it.'],
    ['a neighbouring escape', 'const nbsp = /\\u202F/;'],
    ['a longer hex number', 'const x = 0x202E1;'],
    ['the import of the owner', "import { REWRITES_THE_SURFACE } from '@ax/core/surface-text';"],
  ])('does not report %s', (_label, line) => {
    expect(anchorLines(line)).toEqual([]);
  });
});
