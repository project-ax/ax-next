import { describe, expect, it } from 'vitest';
import { createHoldLatch, drainHoldLatch } from '../hold-latch.js';

describe('createHoldLatch', () => {
  it('starts untripped', () => {
    const l = createHoldLatch();
    expect(l.tripped).toBe(false);
    expect(l.decisionId).toBeNull();
  });

  it('keeps the FIRST decision id when tripped twice', () => {
    const l = createHoldLatch();
    l.trip('dec_1');
    l.trip('dec_2');
    expect(l.decisionId).toBe('dec_1');
  });

  it('resets between turns', () => {
    const l = createHoldLatch();
    l.trip('dec_1');
    l.reset();
    expect(l.tripped).toBe(false);
  });
});

describe('drainHoldLatch', () => {
  it('returns the held decision id AND clears the latch, in that order', () => {
    const l = createHoldLatch();
    l.trip('dec_1');
    // The regression this pins: reset-then-read always yields null, so the
    // hold is never recorded anywhere and nothing else in the suite notices.
    expect(drainHoldLatch(l)).toBe('dec_1');
    expect(l.tripped).toBe(false);
    expect(l.decisionId).toBeNull();
  });

  it('returns null for a turn that never held', () => {
    expect(drainHoldLatch(createHoldLatch())).toBeNull();
  });
});
