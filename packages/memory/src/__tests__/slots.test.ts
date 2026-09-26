import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PENDING_SLOT as CONTRACT_PENDING_SLOT } from '@ax/memory-facts-contract';

import { SLOTS, SLOT_SYNONYMS, PENDING_SLOT, deriveSlot, relationToWords } from '../slots.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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
// One list, one owner — enforced against the source tree, but NOT here.
//
// The scanner that fails when a second copy of SLOTS appears in production
// source lives in `scripts/__tests__/slot-vocabulary-single-owner.test.js`
// (TASK-518). It used to be in this file, where CI's affected-packages test job
// never ran it for the PR that actually added a copy — nothing depends on
// @ax/memory, so a `channel-web` change did not select this suite.
// `pnpm test:scripts` runs on every PR.
// ---------------------------------------------------------------------------

describe('relationToWords', () => {
  it('turns the extraction contract snake_case into the table key form', () => {
    expect(relationToWords('Works_At')).toBe('works at');
    expect(relationToWords('  date__of___birth ')).toBe('date of birth');
    expect(relationToWords('already words')).toBe('already words');
  });
});
