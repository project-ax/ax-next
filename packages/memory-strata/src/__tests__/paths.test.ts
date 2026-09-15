// TASK-367: DOC_CATEGORIES / SUBJECT_DOC_CATEGORIES.
//
// WHY this test exists: `.claude/memory/decisions.md` (2026-07-07) records that
// `DocCategory` used to be hand-copied in several places and a missed copy is a
// SILENT no-op (a category that exists on the type but not in the list a caller
// iterates).
//
// NOTE ON THE DIVISION OF LABOUR — the interesting half of that guarantee is
// NOT here. "Every `DocCategory` union member appears in `DOC_CATEGORIES`" is a
// statement about a TYPE, and a runtime test cannot enumerate a TypeScript
// union: it could only compare against a hand-written array, which would be the
// very second copy this work exists to delete (and would go stale in exactly
// the same way). That half is enforced at compile time by
// `_everyDocCategoryIsListed` in `paths.ts`.
//
// What IS worth asserting at runtime is the derivation between the two exported
// lists and the absence of duplicates — neither is expressible in the type.

import { describe, it, expect } from 'vitest';
import { DOC_CATEGORIES, SUBJECT_DOC_CATEGORIES } from '../paths.js';

describe('DOC_CATEGORIES', () => {
  it('has no duplicate entries', () => {
    expect(new Set(DOC_CATEGORIES).size).toBe(DOC_CATEGORIES.length);
  });

  it('SUBJECT_DOC_CATEGORIES is DOC_CATEGORIES minus exactly rollup, in a pinned order', () => {
    expect(SUBJECT_DOC_CATEGORIES).not.toContain('rollup');
    expect(DOC_CATEGORIES).toContain('rollup');
    // Pinned as a LITERAL, deliberately, rather than re-derived as
    // `DOC_CATEGORIES.filter(c => c !== 'rollup')`. To be precise about why,
    // because the obvious reason is the wrong one: that phrasing DOES catch a
    // change to the source predicate (flip it to `c !== 'entity'` and the two
    // sides diverge). What it cannot catch is a change to `DOC_CATEGORIES`
    // itself — membership or ORDER — because both sides re-derive from it and
    // move together. Order is the half that matters here: the consolidator's
    // cross-category slug adoption scans this list in order and returns the
    // FIRST hit, which is what makes adoption deterministic on a legacy tree
    // holding the same slug under two categories. Note the "legacy multi-hit"
    // test in consolidator.test.ts asserts only that the choice is STABLE, not
    // which category wins — so this literal is the only thing pinning
    // entity-before-general. Reordering or extending the categories SHOULD fail
    // here and be re-confirmed deliberately.
    expect([...SUBJECT_DOC_CATEGORIES]).toEqual([
      'entity', 'preference', 'decision', 'episode', 'general',
    ]);
  });
});
