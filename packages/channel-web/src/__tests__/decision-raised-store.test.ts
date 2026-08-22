import { afterEach, describe, expect, it } from 'vitest';
import {
  decisionRaisedActions,
  getDecisionRaisedSnapshot,
} from '../lib/decision-raised-store';

describe('decision-raised-store', () => {
  afterEach(() => decisionRaisedActions.resetForTest());

  it('starts at zero', () => {
    expect(getDecisionRaisedSnapshot()).toEqual({ raised: 0 });
  });

  it('raise() increments the counter', () => {
    decisionRaisedActions.raise();
    expect(getDecisionRaisedSnapshot().raised).toBe(1);
    decisionRaisedActions.raise();
    expect(getDecisionRaisedSnapshot().raised).toBe(2);
  });

  it('reset() zeroes the counter', () => {
    decisionRaisedActions.raise();
    decisionRaisedActions.raise();
    decisionRaisedActions.reset();
    expect(getDecisionRaisedSnapshot().raised).toBe(0);
  });

  it('notifies subscribers on raise() and reset()', () => {
    let hits = 0;
    const unsub = decisionRaisedActions.subscribeForTest(() => {
      hits += 1;
    });
    decisionRaisedActions.raise();
    decisionRaisedActions.reset();
    unsub();
    expect(hits).toBe(2);
  });

  it('getSnapshot returns the SAME object reference when nothing changed', () => {
    // useSyncExternalStore requires a stable snapshot between renders when
    // state hasn't changed — a new object every call would infinite-loop.
    const a = getDecisionRaisedSnapshot();
    const b = getDecisionRaisedSnapshot();
    expect(a).toBe(b);
  });

  it('getSnapshot returns a NEW object reference after a change', () => {
    const before = getDecisionRaisedSnapshot();
    decisionRaisedActions.raise();
    const after = getDecisionRaisedSnapshot();
    expect(after).not.toBe(before);
    expect(after.raised).toBe(before.raised + 1);
  });
});
