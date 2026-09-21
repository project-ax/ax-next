// Direct unit tests for the response validators.
//
// WHY THESE EXIST SEPARATELY from the driver suites, which already push
// malformed bodies through the bus: the TASK-487 mutation pass changed
// `validate.ts`'s `isNullish` from `value == null` to `value === undefined`
// and all 137 tests stayed GREEN.
//
// That is the exact bug the card names as its headline trap. `HookBus.call`
// returns a handler's raw value when the hook declares no `returns` schema
// (ours declares none), and `JSON.parse('null')` is `null` — so a `null`
// arrives intact, a strict `=== undefined` is `false` for it, and control
// falls through to `value.length`. On TASK-434 that TypeError escaped from
// outside the consumer's try and turned one misconfigured provider into a
// deployment-wide WRITE OUTAGE.
//
// The through-the-bus tests could not see the difference because every
// `isNullish` call happens to be followed by an `Array.isArray` check, which
// is already `false` for `null`. The guard is therefore load-bearing only if
// something downstream of it changes — which is precisely when a test is worth
// having, and precisely when nobody would think to write one. The card also
// requires the `null` case be "tested explicitly"; through-the-bus coverage
// tests the OUTCOME, and these test the GUARD.

import { describe, expect, it } from 'vitest';
import { validateScores, validateVectors } from '../validate.js';

describe('validateVectors', () => {
  it('answers undefined for a literal null rather than throwing', () => {
    // `.not.toThrow()` is half the assertion and the more important half: a
    // throw here does not degrade, it escapes.
    expect(() => validateVectors(null, 1, 4)).not.toThrow();
    expect(validateVectors(null, 1, 4)).toBeUndefined();
  });

  it('answers undefined for a null VECTOR inside an otherwise fine array', () => {
    expect(() => validateVectors([null], 1, 4)).not.toThrow();
    expect(validateVectors([null], 1, 4)).toBeUndefined();
  });

  it('answers undefined for undefined, at both levels', () => {
    expect(validateVectors(undefined, 1, 4)).toBeUndefined();
    expect(validateVectors([undefined], 1, 4)).toBeUndefined();
  });

  it('returns the vectors when count and width both match', () => {
    expect(validateVectors([[1, 2]], 1, 2)).toEqual([[1, 2]]);
  });

  it.each([
    ['a short batch', [[1, 2]], 2, 2],
    ['a long batch', [[1, 2], [3, 4]], 1, 2],
    ['a narrow vector', [[1]], 1, 2],
    ['a wide vector', [[1, 2, 3]], 1, 2],
    ['a NaN component', [[1, Number.NaN]], 1, 2],
    ['an Infinity component', [[1, Number.POSITIVE_INFINITY]], 1, 2],
    ['a string component', [[1, '2']], 1, 2],
    ['a null component', [[1, null]], 1, 2],
    ['a non-array outer value', { 0: [1, 2] }, 1, 2],
  ])('answers undefined for %s', (_label, value, count, dimensions) => {
    expect(validateVectors(value, count, dimensions)).toBeUndefined();
  });

  it('accepts an empty batch when none was expected', () => {
    expect(validateVectors([], 0, 4)).toEqual([]);
  });
});

describe('validateScores', () => {
  it('answers undefined for a literal null rather than throwing', () => {
    expect(() => validateScores(null, 1)).not.toThrow();
    expect(validateScores(null, 1)).toBeUndefined();
  });

  it('answers undefined for a HOLE in a sparse array', () => {
    // This is the shape `cohereRerank` builds: `new Array(n)` filled by index.
    // A provider that skips an index leaves a hole, `for..of` yields
    // `undefined` for it, and that must not read as a score of any kind —
    // least of all as zero, which would sink the document to the bottom of the
    // ranking as though the provider had judged it irrelevant.
    const sparse = new Array<number>(3);
    sparse[0] = 0.5;
    sparse[2] = 0.1;
    expect(validateScores(sparse, 3)).toBeUndefined();
  });

  it('returns the scores when the count matches', () => {
    expect(validateScores([0.5, 0.1], 2)).toEqual([0.5, 0.1]);
  });

  it.each([
    ['a short answer', [0.5], 2],
    ['a long answer', [0.5, 0.1, 0.2], 2],
    ['a NaN score', [0.5, Number.NaN], 2],
    ['an Infinity score', [0.5, Number.NEGATIVE_INFINITY], 2],
    ['a string score', [0.5, '0.1'], 2],
    ['a null score', [0.5, null], 2],
    ['a non-array value', { 0: 0.5 }, 1],
    ['undefined', undefined, 1],
  ])('answers undefined for %s', (_label, value, count) => {
    expect(validateScores(value, count)).toBeUndefined();
  });

  it('accepts an empty answer when none was expected', () => {
    expect(validateScores([], 0)).toEqual([]);
  });

  it('accepts a negative score — lower is worse, not invalid', () => {
    // Cross-encoders are not all bounded to [0, 1]. Rejecting a negative here
    // would drop a perfectly good ranking from any provider that emits logits.
    expect(validateScores([-2.5, 0.1], 2)).toEqual([-2.5, 0.1]);
  });
});
