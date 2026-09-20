// Direct unit tests for the ONE shared RRF implementation (TASK-434 T1).
//
// The contract suite exercises fusion end-to-end through a backend, but that
// route can only see the ORDER that came out. It cannot see the scores, and it
// cannot distinguish "the tiebreak is deterministic" from "this backend
// happened to feed the channels in a lucky order". Both properties are why the
// function lives in the contract package at all — `@ax/memory-facts-sqlite` and
// (at TASK-457) `@ax/memory-facts-postgres` must fuse identically or the
// contract's ordering cases mean different things on the two engines — so they
// get pinned here, on the function itself.

import { describe, it, expect } from 'vitest';
import { DEFAULT_RRF_K, reciprocalRankFusion } from '../index.js';

describe('reciprocalRankFusion', () => {
  it('scores a single list as 1 / (k + rank + 1) with a 0-based rank', () => {
    // Written as literal reciprocals rather than as a re-derivation of the
    // formula: a test that recomputes `1 / (k + i + 1)` passes against an
    // implementation with the same off-by-one as itself.
    const fused = reciprocalRankFusion([['a', 'b', 'c']], 60);
    expect(fused).toEqual([
      { id: 'a', score: 1 / 61 },
      { id: 'b', score: 1 / 62 },
      { id: 'c', score: 1 / 63 },
    ]);
  });

  it('defaults k to DEFAULT_RRF_K (60) — the measured value, not a tuned one', () => {
    expect(DEFAULT_RRF_K).toBe(60);
    expect(reciprocalRankFusion([['a']])).toEqual([{ id: 'a', score: 1 / 61 }]);
    expect(reciprocalRankFusion([['a']], DEFAULT_RRF_K)).toEqual(reciprocalRankFusion([['a']]));
  });

  it('honours a caller-supplied k', () => {
    expect(reciprocalRankFusion([['a']], 0)).toEqual([{ id: 'a', score: 1 / 1 }]);
    expect(reciprocalRankFusion([['a', 'b']], 9)).toEqual([
      { id: 'a', score: 1 / 10 },
      { id: 'b', score: 1 / 11 },
    ]);
  });

  it('sums an id across lists UNWEIGHTED — every channel contributes the same reciprocal', () => {
    // `x` is rank 0 in the first list and rank 2 in the second; `y` is rank 0
    // in the second only. The sum must be the plain sum of the two
    // reciprocals: no per-channel weight, no normalisation by list length.
    const fused = reciprocalRankFusion([['x'], ['y', 'z', 'x']], 60);
    expect(fused).toEqual([
      { id: 'x', score: 1 / 61 + 1 / 63 },
      { id: 'y', score: 1 / 61 },
      { id: 'z', score: 1 / 62 },
    ]);
    // Two channels agreeing on a mediocre rank beats one channel's best hit —
    // the whole point of fusing, and the property a weighted variant breaks.
    expect(fused[0]!.score).toBeGreaterThan(1 / 61);
  });

  it('swapping the channel ORDER changes nothing — fusion is over sets of rankings, not a priority list', () => {
    const a = reciprocalRankFusion([['x'], ['y', 'z', 'x']], 60);
    const b = reciprocalRankFusion([['y', 'z', 'x'], ['x']], 60);
    expect(b).toEqual(a);
  });

  it('breaks an exact score tie by ascending id, whatever order the ids were first seen in', () => {
    // Both ids score 1 / 61. `Array.prototype.sort` is stable in V8, so
    // WITHOUT the `localeCompare` tiebreak the output would simply echo
    // first-seen order and these two calls would disagree — which is the drift
    // that makes an ordering assertion in the contract suite mean one thing on
    // sqlite and another on postgres.
    expect(reciprocalRankFusion([['b'], ['a']], 60).map((c) => c.id)).toEqual(['a', 'b']);
    expect(reciprocalRankFusion([['a'], ['b']], 60).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('applies the tiebreak only WITHIN a score, never across scores', () => {
    // `z` outscores `a` (two channels vs one). Ascending-id must not promote
    // `a` past it — a tiebreak applied as a primary sort would.
    const fused = reciprocalRankFusion([['z', 'a'], ['z']], 60);
    expect(fused.map((c) => c.id)).toEqual(['z', 'a']);
  });

  it('is deterministic across permutations of tied channels', () => {
    const permutations: string[][][] = [
      [['a'], ['b'], ['c']],
      [['c'], ['b'], ['a']],
      [['b'], ['c'], ['a']],
    ];
    for (const lists of permutations) {
      expect(reciprocalRankFusion(lists, 60).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    }
  });

  it('ignores empty channels and returns [] when every channel is empty', () => {
    // A channel that produced nothing (no embedder, no lexical hit) must not
    // shift the ranks of the channels that did.
    expect(reciprocalRankFusion([[], ['a', 'b'], []], 60)).toEqual(
      reciprocalRankFusion([['a', 'b']], 60),
    );
    expect(reciprocalRankFusion([], 60)).toEqual([]);
    expect(reciprocalRankFusion([[], []], 60)).toEqual([]);
  });
});
