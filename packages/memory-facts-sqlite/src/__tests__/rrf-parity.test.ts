// The anti-drift pin for the duplicated fusion arithmetic.
//
// `recall.ts` carries its own copy of `reciprocalRankFusion` and the three
// constants because `@ax/memory-facts-contract` depends on `vitest` at runtime
// and Invariant 2 forbids a cross-plugin runtime import — the same reason
// `pending.ts` re-spells `PENDING_SLOT`, and pinned the same way. Without this
// file the copy is exactly the split-brain the contract exists to prevent: two
// engines ranking differently behind one set of ordering assertions.
//
// A test file MAY import the contract as a value: it is a devDependency and
// the test graph is not the production graph.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RRF_K,
  DEFAULT_CHANNEL_LIMIT,
  DEFAULT_POOL_SIZE,
  reciprocalRankFusion as contractRrf,
} from '@ax/memory-facts-contract';
import {
  RRF_K,
  CHANNEL_LIMIT,
  POOL_SIZE,
  reciprocalRankFusion as localRrf,
} from '../recall.js';

describe('@ax/memory-facts-sqlite — RRF parity with the contract', () => {
  it('uses the same constants', () => {
    expect(RRF_K).toBe(DEFAULT_RRF_K);
    expect(CHANNEL_LIMIT).toBe(DEFAULT_CHANNEL_LIMIT);
    expect(POOL_SIZE).toBe(DEFAULT_POOL_SIZE);
  });

  // Each fixture targets one way the two could silently diverge: the summing,
  // the 0-vs-1-based rank, the tiebreak, and the empty case. Identical OUTPUT
  // (ids AND scores), not merely identical order — a `k` off by one reorders
  // nothing in small fixtures but changes every score.
  it.each([
    { name: 'disjoint lists', lists: [['a'], ['b'], ['c']] },
    { name: 'overlapping lists', lists: [['a', 'b', 'c'], ['c', 'a'], ['b']] },
    { name: 'a tie broken by id', lists: [['b'], ['a']] },
    { name: 'a repeated id within one list', lists: [['a', 'a', 'b']] },
    { name: 'an empty channel alongside a full one', lists: [[], ['a', 'b']] },
    { name: 'nothing at all', lists: [[], [], []] },
  ])('agrees on $name', ({ lists }) => {
    expect(localRrf(lists)).toEqual(contractRrf(lists));
  });

  it('agrees when an explicit k is passed', () => {
    const lists = [
      ['a', 'b'],
      ['b', 'a'],
    ];
    expect(localRrf(lists, 1)).toEqual(contractRrf(lists, 1));
  });
});
