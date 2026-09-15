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

  it('SUBJECT_DOC_CATEGORIES is DOC_CATEGORIES minus exactly rollup, order preserved', () => {
    expect(SUBJECT_DOC_CATEGORIES).not.toContain('rollup');
    expect(DOC_CATEGORIES).toContain('rollup');
    // Order matters: the consolidator's cross-category slug adoption scans this
    // list in order, and the "legacy multi-hit tree" regression test in
    // consolidator.test.ts depends on that order being deterministic.
    expect([...SUBJECT_DOC_CATEGORIES]).toEqual(DOC_CATEGORIES.filter((c) => c !== 'rollup'));
  });
});
