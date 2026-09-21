import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PENDING_SLOT as CONTRACT_PENDING_SLOT } from '@ax/memory-facts-contract';

import { SLOTS, SLOT_SYNONYMS, PENDING_SLOT, deriveSlot, relationToWords } from '../slots.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

interface KnownBad {
  predicate: string;
  mustNotMap: string;
  why: string;
}

const KNOWN_BAD: KnownBad[] = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'normalizer-known-bad.json'), 'utf8'),
) as KnownBad[];

// ---------------------------------------------------------------------------
// The table answers, or nothing answers.
// ---------------------------------------------------------------------------

describe('deriveSlot — the exact-synonym table alone', () => {
  it('maps every spelling in the table to the slot the table names', () => {
    for (const [words, slot] of SLOT_SYNONYMS) {
      expect(deriveSlot(words), words).toBe(slot);
    }
  });

  it('reads snake_case, mixed case and stray whitespace as the same relation', () => {
    // The extraction contract emits snake_case, a hand-written `memory:remember`
    // may not, and both must reach the same row. Underscores are separators,
    // not content.
    for (const spelling of ['lives_in', 'Lives_In', 'LIVES IN', '  lives   in  ', 'lives__in']) {
      expect(deriveSlot(spelling), spelling).toBe('lives_in');
    }
  });

  it('gives an unknown relation NO SLOT rather than the nearest one', () => {
    // The whole card, in one assertion. The embedding nearest-neighbour that
    // would have answered here was measured at rung 0 (13.2% precision) and
    // killed — `slots.ts` carries the numbers. A relation with no slot closes
    // nothing, which is the safe direction: a false positive deletes a true
    // fact and no read path recovers it.
    for (const relation of [
      'enjoys_hiking',
      'favourite_colour',
      'debugged',
      'thinks_about',
      'xyzzy',
    ]) {
      expect(deriveSlot(relation), relation).toBeNull();
    }
  });

  it('never answers with anything outside SLOTS', () => {
    for (const [, slot] of SLOT_SYNONYMS) {
      expect(SLOTS).toContain(slot);
    }
  });

  it('is a near-miss away from a mapping, not a fuzzy match away', () => {
    // `lives in` maps; `lived in`, `lives near` and `lives` do not. There is no
    // stemming, no prefix match and no distance metric anywhere in the path.
    for (const relation of ['lived_in', 'lives_near', 'lives', 'live_in', 'works']) {
      expect(deriveSlot(relation), relation).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// It runs inside the record path, so it must not throw and must not be
// steerable by model output.
// ---------------------------------------------------------------------------

describe('deriveSlot — degrades, never throws', () => {
  it.each([undefined, null, 42, {}, [], Symbol('s'), (): void => {}])(
    'answers null for a non-string relation (%s)',
    (bad) => {
      // Only reachable across a boundary that erases types — an IPC action, a
      // tool argument. A throw here would take the whole write down; TASK-434's
      // embedder bug is how that became a deployment-wide write outage.
      expect(deriveSlot(bad as unknown as string)).toBeNull();
    },
  );

  it('answers null for the empty relation and for pure whitespace', () => {
    for (const relation of ['', '   ', '___']) {
      expect(deriveSlot(relation), JSON.stringify(relation)).toBeNull();
    }
  });

  // ⚠ REGRESSION GUARD. `relation` is model output (design §6.3 — prompt
  // injection is the threat this design is *for*). The ported `dem-memory`
  // normalizer looked up the synonyms on a plain object, and a plain object
  // lookup walks `Object.prototype`: `table['constructor']` is the `Object`
  // constructor, so the `?? null` behind it never ran and a statement whose
  // relation was `constructor` would have carried a FUNCTION as its
  // supersession key onto the engine payload. `SLOT_SYNONYMS` is a `Map` for
  // exactly this reason.
  // Of the list below, `constructor` is the only one that is STILL a real
  // `Object.prototype` key after `relationToWords` runs: `__proto__` becomes
  // `proto`, and every other prototype method is camelCase and dies under
  // `.toLowerCase()` (`toString` -> `tostring`). One reachable key is enough,
  // and the rest are kept as cheap insurance against a future change to the
  // normalization.
  it('answers null for prototype keys — a relation cannot reach Object.prototype', () => {
    for (const relation of [
      'constructor',
      'Constructor',
      '__proto__',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'propertyIsEnumerable',
      'isPrototypeOf',
      'toLocaleString',
    ]) {
      const derived = deriveSlot(relation);
      expect(derived, relation).toBeNull();
      expect(typeof derived, relation).not.toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// The known-bad fixture: the relations that must never gain a slot.
// ---------------------------------------------------------------------------

describe('normalizer-known-bad.json — none of these may ever map', () => {
  it('carries the whole fixture, so a deletion is a visible diff rather than a quiet pass', () => {
    expect(KNOWN_BAD.length).toBe(22);
    for (const entry of KNOWN_BAD) {
      expect(typeof entry.predicate).toBe('string');
      expect(entry.predicate).not.toBe('');
      expect(typeof entry.why).toBe('string');
    }
  });

  it.each(KNOWN_BAD)('$predicate maps to nothing ($mustNotMap)', ({ predicate, mustNotMap }) => {
    // Asserted as "no slot at all", which is strictly stronger than the
    // fixture's `mustNotMap`. Every one of these is either multi-valued
    // (`visited`, `owns`, `purchased` — closure would delete a true fact) or a
    // different property wearing a similar shape (`born_in` is a birthplace,
    // not a residence; it measured 0.7790 against the `lives_in` description,
    // HIGHER than `lives in` itself at 0.7751, so no threshold could have
    // refused it — only a table can).
    const derived = deriveSlot(predicate);
    expect(derived).toBeNull();
    if (mustNotMap !== '*') {
      expect(derived).not.toBe(mustNotMap);
    }
  });
});

// ---------------------------------------------------------------------------
// The vocabulary: one list, one owner, and `pending` is not part of it.
// ---------------------------------------------------------------------------

describe('the slot vocabulary', () => {
  it('is the eight single-valued slots design §3.3 names', () => {
    expect([...SLOTS]).toEqual([
      'name',
      'pronouns',
      'lives_in',
      'works_at',
      'role',
      'timezone',
      'language',
      'birthday',
    ]);
    expect(new Set(SLOTS).size).toBe(SLOTS.length);
  });

  it('does not contain the reserved pending sentinel, and cannot produce it', () => {
    // `pending` is inert by contract (design §3.5): a row carrying it closes
    // nothing and nothing closes it. Reusing the spelling as a real slot would
    // silently make every `pending` row in the store a member of a live
    // supersession chain.
    expect([...SLOTS]).not.toContain(PENDING_SLOT);
    expect([...SLOT_SYNONYMS.values()] as string[]).not.toContain(PENDING_SLOT);
    // And nothing routes to it: derivation is a synchronous table lookup with
    // no producer that could be unavailable, so there is no deferral state.
    expect(deriveSlot(PENDING_SLOT)).toBeNull();
    expect(deriveSlot('pending')).toBeNull();
  });

  // The `@ax/memory-facts-sqlite` `src/pending.ts` precedent, for the same
  // reason: `@ax/memory-facts-contract` ships the shared vitest suite and so
  // depends on `vitest` at RUNTIME, which makes it a devDependency here and
  // `import type`-only under `eslint.config.mjs`'s `crossPluginImports`.
  // Duplicating the constant is only safe if something notices a drift.
  it('spells PENDING_SLOT exactly as the engine contract spells it (invariant 4)', () => {
    expect(PENDING_SLOT).toBe(CONTRACT_PENDING_SLOT);
  });
});

// ---------------------------------------------------------------------------
// One list, one owner — enforced against the source tree.
// ---------------------------------------------------------------------------

/**
 * `SLOTS` is *also* the profile whitelist of design §4.1: the block injected at
 * chat start renders the active rows whose slot is set. Design §3.3 is explicit
 * that this is the same constant and not a copy, because the two directions
 * fail differently and both fail silently — a slot missing from a copied
 * whitelist closes rows nobody can see, and a slot present only in a copied
 * whitelist renders a column that never fills.
 *
 * That consumer is a later card, so there is nothing yet to point at `SLOTS`.
 * This test is what stops it arriving with its own list: any production source
 * file that names both `lives_in` and `works_at` as string literals is holding
 * the slot vocabulary, and only `slots.ts` may.
 */
function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-web' || entry === 'dist-spa') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      productionSources(full, out);
    } else if (
      // `.tsx` too. The §4.1 profile block is a rendering surface, so the
      // copy most worth catching is the one that lands in `channel-web`.
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Block comments and `//` line comments — but not the `//` in a `https://` URL. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<![:/])\/\/.*$/gm, '');
}

/**
 * The most distinct slot names that appear as string literals inside any
 * {@link WINDOW}-character stretch of `code`.
 *
 * A window rather than a whole-file count, because a whole-file count reports
 * the shared engine-contract suite (which uses `lives_in` and `works_at` as
 * test data in unrelated cases hundreds of lines apart) and misses nothing a
 * window would. A COPY of the vocabulary is by its nature one literal list, so
 * it is dense: all eight names inside one array.
 */
const WINDOW = 200;

/**
 * Both spellings a copied list can take: a quoted literal (`'lives_in'`, in an
 * array or a union) and a bare object key (`lives_in:`, in a
 * `Record<Slot, …>`). Matching only the first is how a hand-copied
 * `Record<Slot, string>` sails through.
 */
const SLOT_MENTION = /['"`]([A-Za-z_][A-Za-z_0-9]*)['"`]|\b([A-Za-z_][A-Za-z_0-9]*)\s*:/g;

function densestSlotRun(code: string): string[] {
  const hits: Array<{ at: number; slot: string }> = [];
  for (const match of code.matchAll(SLOT_MENTION)) {
    const slot = match[1] ?? match[2];
    if (slot !== undefined && (SLOTS as readonly string[]).includes(slot)) {
      hits.push({ at: match.index, slot });
    }
  }
  let densest: string[] = [];
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i]!.at;
    const run = new Set(hits.slice(i).filter((h) => h.at - start <= WINDOW).map((h) => h.slot));
    if (run.size > densest.length) densest = [...run];
  }
  return densest;
}

/**
 * A run is a copy of the vocabulary when it is **dense** and contains
 * `lives_in`.
 *
 * Density alone would be a coincidence detector: `name`, `role`, `language`
 * and `timezone` are ordinary words, and three of them near each other in some
 * unrelated package would fail THIS package's suite with a message about a
 * vocabulary its author never heard of. `lives_in` is not an ordinary word and
 * any real copy of the eight contains it. MEASURED over all 840 production
 * `.ts`/`.tsx` files: **no file outside `slots.ts` reaches 3 by either rule**,
 * so the extra condition costs nothing today and buys the margin.
 */
const ANCHOR: string = 'lives_in';

function looksLikeACopy(run: readonly string[]): boolean {
  return run.length >= 3 && run.includes(ANCHOR);
}

describe('the slot list has exactly one owner (invariant 4)', () => {
  it('appears in no production source but slots.ts', () => {
    const slotsFile = join(REPO_ROOT, 'packages', 'memory', 'src', 'slots.ts');
    const offenders: string[] = [];

    for (const file of productionSources(join(REPO_ROOT, 'packages'))) {
      if (file === slotsFile) continue;
      const run = densestSlotRun(stripComments(readFileSync(file, 'utf8')));
      if (looksLikeACopy(run)) {
        offenders.push(`${relative(REPO_ROOT, file)} (${run.join(', ')})`);
      }
    }

    expect(
      offenders,
      'a second copy of the slot vocabulary — import SLOTS from @ax/memory instead',
    ).toEqual([]);
  });

  it('actually reads the tree it claims to read', () => {
    // Without this, a scanner that silently walked an empty directory would
    // pass the test above for the wrong reason — the shape of green that means
    // nothing was checked.
    const files = productionSources(join(REPO_ROOT, 'packages'));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(join(REPO_ROOT, 'packages', 'memory', 'src', 'slots.ts'));
    expect(files.some((f) => f.includes('__tests__'))).toBe(false);
    // …and `.tsx` is in scope, because the §4.1 profile block is a rendering
    // surface and `channel-web` is where a hand-copied list would land.
    expect(files.some((f) => f.endsWith('.tsx'))).toBe(true);
  });

  it('recognizes a copy in either spelling, and ignores an innocent cluster', () => {
    // The detector itself, since the case above can only ever assert an empty
    // list — a guard whose positive branch is never exercised is a guard
    // nobody has seen work.
    const asArray = "const WHITELIST = ['name', 'lives_in', 'works_at'] as const;";
    const asRecord = 'const LABELS = { name: "Name", lives_in: "Home", works_at: "Employer" };';
    const innocent = "type Field = 'name' | 'role' | 'language';";

    expect(looksLikeACopy(densestSlotRun(asArray))).toBe(true);
    expect(looksLikeACopy(densestSlotRun(asRecord))).toBe(true);
    // Three slot names, but no `lives_in` — ordinary words that happen to
    // collide, which is the false positive the anchor exists to refuse.
    expect(densestSlotRun(innocent)).toHaveLength(3);
    expect(looksLikeACopy(densestSlotRun(innocent))).toBe(false);
  });
});

describe('relationToWords', () => {
  it('turns the extraction contract snake_case into the table key form', () => {
    expect(relationToWords('Works_At')).toBe('works at');
    expect(relationToWords('  date__of___birth ')).toBe('date of birth');
    expect(relationToWords('already words')).toBe('already words');
  });
});
