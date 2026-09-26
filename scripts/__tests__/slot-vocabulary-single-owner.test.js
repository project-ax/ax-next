// Guard: the slot vocabulary (`SLOTS`, packages/memory/src/slots.ts) has
// exactly one owner — CLAUDE.md invariant 4.
//
// `SLOTS` is both the supersession normalizer's slot list and the injected
// profile's whitelist (design §3.3 / §4.1): the same constant, not a copy. The
// two directions of drift fail differently and both fail silently — a slot
// missing from a copied whitelist closes rows nobody can see, and a slot present
// only in a copied whitelist renders a column that never fills. This scans the
// repo's production source for a second, hand-written copy.
//
// WHY IT LIVES HERE AND NOT IN @ax/memory (TASK-518). It used to be a case in
// packages/memory/src/__tests__/slots.test.ts. CI's PR `test` job runs only the
// packages a PR affects, plus their dependents — and nothing depends on
// @ax/memory — so a PR that added a copy to `channel-web` (the case this guard
// exists for) never ran it. The copy merged green, and the red landed later on
// main's full suite, or on the next unrelated @ax/memory PR, blamed on a package
// its author never touched. `pnpm test:scripts` runs on EVERY PR (ci.yml,
// "Test (affected packages + dependents)"), so here it fails the PR that
// actually adds the copy. The reach across packages is deliberate: a guard for
// "no second copy anywhere" has to read everywhere.
//
// WHAT IT CAN AND CANNOT SEE. It is a heuristic, not a proof. It reports a file
// when 3+ distinct slot names, ONE OF THEM `lives_in`, are mentioned within
// WINDOW characters of each other. Anything else passes, including:
//
//   - A PARTIAL copy without `lives_in`, e.g.
//     `type ProfileField = 'name' | 'role' | 'language' | 'timezone'`. That IS a
//     second copy of part of the vocabulary and this guard lets it through.
//     The anchor is a deliberate trade: `name`, `role`, `language` and
//     `timezone` are ordinary words, and without the anchor any three of them
//     near each other anywhere in the repo would fail this suite. Every FULL
//     copy contains `lives_in`; sub-copies without it are a known blind spot.
//     The case table below pins that miss so it cannot quietly change.
//   - A copy spread thinner than WINDOW characters, e.g. one slot per line with
//     a long comment beside each. Distance is measured on the source as
//     written, comments included.
//   - A copy built at runtime (`'lives' + '_in'`), or held in a non-source file
//     (JSON, YAML, Markdown).
//
// WHAT IT READS. Every file `git ls-files` tracks under packages/ and presets/
// with a JS/TS extension, minus `__tests__/` directories and `*.test.*` /
// `*.spec.*` files. Each file is parsed with the TypeScript compiler, not
// matched with a regex: the TASK-489 version stripped comments with a regex
// that also ate string contents (`' // '` or `'/*'` inside a literal blanked the
// rest of the line or file) and matched keys with `\bx\s*:`, which missed
// `lives_in?: string` in an interface. A file the parser reports errors for is
// reported as an OFFENDER, not skipped: a file we could not read is a file we
// did not check, and that must not look like a pass.
//
// THE NEAREST MISS TODAY. packages/memory-facts-contract/src/index.ts ships the
// shared contract suite as production code and names `lives_in` and `works_at`
// as test data, a few characters apart — one adjacent third slot away from
// tripping this. If it reddens there, that is this guard working as designed on
// data that is not a copy: spread the literals out, and say why in that PR. Do
// NOT narrow this guard's reach to make it pass — that loses the `channel-web`
// case it exists for.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { SLOTS } from '../../packages/memory/src/slots.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER = 'packages/memory/src/slots.ts';
const ROOTS = ['packages', 'presets'];

/** How close (in source characters, start to start) mentions must sit to count as one run. */
const WINDOW = 200;
/** The slot a run must contain to count as a copy — see the header on sub-copies. */
const ANCHOR = 'lives_in';
/** Distinct slot names a run needs, anchor included. */
const MIN_RUN = 3;

const SCRIPT_KIND = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
]);

function extensionOf(path) {
  const m = /\.[^./]+$/.exec(path);
  return m === null ? '' : m[0];
}

/** Tracked production JS/TS sources under ROOTS, repo-relative. Throws if git does. */
function productionSources() {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => SCRIPT_KIND.has(extensionOf(p)))
    .filter((p) => !p.split('/').includes('__tests__'))
    .filter((p) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p));
}

/**
 * Declarations whose NAME is a bare identifier that spells a field: an object
 * key, an interface/class member, an enum member, a destructured binding.
 */
function isFieldName(node) {
  const parent = node.parent;
  if (parent === undefined) return false;
  switch (parent.kind) {
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.ShorthandPropertyAssignment:
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.EnumMember:
      return parent.name === node;
    case ts.SyntaxKind.BindingElement:
      return parent.name === node || parent.propertyName === node;
    default:
      return false;
  }
}

/** Every mention of a slot name, in source order: string literals and field names. */
function slotMentions(sourceFile) {
  const slots = new Set(SLOTS);
  const hits = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (slots.has(node.text)) hits.push({ at: node.getStart(sourceFile), slot: node.text });
    } else if (ts.isIdentifier(node) && isFieldName(node)) {
      if (slots.has(node.text)) hits.push({ at: node.getStart(sourceFile), slot: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits.sort((a, b) => a.at - b.at);
}

/**
 * The largest run that looks like a copy, or null. EVERY window is asked, not
 * only the densest one: asking only the densest let an innocent four-word
 * cluster elsewhere in the file mask a real anchored copy (TASK-518 finding 2).
 */
function largestCopy(hits) {
  let best = null;
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i].at;
    const run = new Set();
    for (let j = i; j < hits.length && hits[j].at - start <= WINDOW; j += 1) run.add(hits[j].slot);
    if (run.size >= MIN_RUN && run.has(ANCHOR) && (best === null || run.size > best.slots.length)) {
      best = { at: start, slots: [...run] };
    }
  }
  return best;
}

/**
 * `null` when the source holds no copy. Otherwise a one-line reason — either
 * the copy (with its line) or why the file could not be read, because an
 * unreadable file is an unchecked file and must not pass.
 */
function scanSource(fileName, text) {
  const kind = SCRIPT_KIND.get(extensionOf(fileName));
  if (kind === undefined) return `unreadable: no parser for ${fileName}`;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  // `parseDiagnostics` is not in the public typings. If a TypeScript upgrade
  // renames it, we cannot tell a clean parse from a broken one — so refuse.
  const diagnostics = sourceFile.parseDiagnostics;
  if (!Array.isArray(diagnostics)) {
    return 'unreadable: this TypeScript no longer exposes parseDiagnostics — cannot confirm a clean parse';
  }
  if (diagnostics.length > 0) {
    const d = diagnostics[0];
    const { line } = sourceFile.getLineAndCharacterOfPosition(d.start ?? 0);
    return `unreadable: parse error at line ${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  }
  const copy = largestCopy(slotMentions(sourceFile));
  if (copy === null) return null;
  const { line } = sourceFile.getLineAndCharacterOfPosition(copy.at);
  return `copy at line ${line + 1}: ${copy.slots.join(', ')}`;
}

describe('the slot vocabulary has exactly one owner (invariant 4)', () => {
  it('appears in no production source but slots.ts', () => {
    const offenders = [];
    for (const file of productionSources()) {
      if (file === OWNER) continue;
      const verdict = scanSource(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
      if (verdict !== null) offenders.push(`${file} — ${verdict}`);
    }
    expect(
      offenders,
      'a second copy of the slot vocabulary — import SLOTS from @ax/memory instead',
    ).toEqual([]);
  });

  it('actually reads the tree it claims to read', () => {
    // A scanner that walked nothing would pass the case above for the wrong
    // reason. No exact count on purpose: the population grows with every PR,
    // and a pinned number goes stale (the TASK-489 comment said 840 when the
    // same walk already found 970). It was ~1,000 files at TASK-518; the
    // floor only has to be far above "empty".
    const files = productionSources();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(OWNER);
    expect(files).toContain('packages/memory-facts-contract/src/index.ts');
    expect(files.some((f) => f.startsWith('packages/channel-web/') && f.endsWith('.tsx'))).toBe(true);
    expect(files.some((f) => f.split('/').includes('__tests__'))).toBe(false);
    expect(files.some((f) => /\.test\.[cm]?[jt]sx?$/.test(f))).toBe(false);
  });

  it('flags the real owner — the detector works on real code, not only on the fixtures', () => {
    // The positive control: slots.ts IS the one legitimate copy, so the scanner
    // must see all eight there. If this goes quiet, the scan above is vacuous.
    expect(SLOTS).toContain(ANCHOR);
    const verdict = scanSource(OWNER, readFileSync(join(REPO_ROOT, OWNER), 'utf8'));
    expect(verdict).toMatch(/^copy at line \d+: /);
    expect(verdict.split(': ')[1].split(', ').sort()).toEqual([...SLOTS].sort());
  });
});

// Hostile synthetic inputs. `copy` = must be flagged, `none` = must pass,
// `unreadable` = must be flagged as unreadable (fail closed). The row count is
// pinned so a deleted row is a visible diff rather than a quieter guard.
const CASES = [
  // --- every spelling a real copy can take ---
  ['copy', 'array literal', "export const WHITELIST = ['name', 'lives_in', 'works_at'] as const;"],
  ['copy', 'Record with bare keys', 'const L = { name: "Name", lives_in: "Home", works_at: "Employer" };'],
  ['copy', 'Record with quoted keys', "const L = { 'name': 1, 'lives_in': 2, 'works_at': 3 };"],
  ['copy', 'union of literal types', "type Slot = 'name' | 'lives_in' | 'works_at';"],
  ['copy', 'interface with OPTIONAL members (the TASK-489 regex missed `?:`)', 'interface P { name?: string; lives_in?: string; works_at?: string }'],
  ['copy', 'enum members', 'enum S { name, lives_in, works_at }'],
  ['copy', 'shorthand object', 'const o = { name, lives_in, works_at };'],
  ['copy', 'destructured field list', 'const { name, lives_in, works_at } = profile;'],
  ['copy', 'template literals', 'const L = [`name`, `lives_in`, `works_at`];'],
  ['copy', 'a JSX surface', 'export const F = () => <select><option value="name"/><option value="lives_in"/><option value="works_at"/></select>;', 'F.tsx'],
  // --- the ways the TASK-489 regex under-read ---
  ['copy', "copy after a ' // ' string on the same line", "const SEP = ' // '; const L = ['name', 'lives_in', 'works_at'];"],
  ['copy', "copy after a '/*' string, with a */ later in the file", "const OPEN = '/*'; const L = ['name', 'lives_in', 'works_at']; const CLOSE = '*/';"],
  ['copy', 'a real copy masked by a denser innocent cluster (finding 2)', "type F = 'name' | 'role' | 'language' | 'timezone';\n" + '/* ' + 'x'.repeat(WINDOW) + " */\nconst L = ['lives_in', 'works_at', 'birthday'];"],
  // --- must pass ---
  ['none', 'innocent cluster without the anchor', "type Field = 'name' | 'role' | 'language';"],
  ['none', 'KNOWN MISS: four-slot sub-copy without lives_in (see header)', "type ProfileField = 'name' | 'role' | 'language' | 'timezone';"],
  ['none', 'slot names only in comments', "// 'name', 'lives_in', 'works_at'\n/* 'name' | 'lives_in' | 'works_at' */\nexport {};"],
  ['none', 'slot names only inside a longer string', "const s = 'name lives_in works_at';"],
  ['none', 'anchored pair with the third mention past the window', "const a = ['lives_in', 'works_at'];\nconst pad = '" + 'x'.repeat(WINDOW) + "';\nconst b = 'role';"],
  ['none', 'slot words as plain variables and calls', 'const name = 1; lives_in(); const works_at = role(language);'],
  // --- fail closed ---
  ['unreadable', 'a file the parser cannot read', "const L = ['name', 'lives_in', 'works_at'"],
  ['unreadable', 'an extension there is no parser for', "['name', 'lives_in', 'works_at']", 'x.vue'],
];

describe('the detector, against hostile synthetic sources', () => {
  it('carries every row', () => {
    expect(CASES).toHaveLength(21);
  });

  it.each(CASES)('%s — %s', (expected, _label, source, fileName = 'x.ts') => {
    const verdict = scanSource(fileName, source);
    if (expected === 'none') expect(verdict).toBeNull();
    if (expected === 'copy') expect(verdict).toMatch(/^copy at line \d+: /);
    if (expected === 'unreadable') expect(verdict).toMatch(/^unreadable: /);
  });

  it('names the anchored copy, not the denser innocent cluster that used to mask it', () => {
    const masked = CASES.find(([, label]) => label.includes('finding 2'));
    expect(scanSource('x.ts', masked[2])).toBe('copy at line 3: lives_in, works_at, birthday');
  });
});
