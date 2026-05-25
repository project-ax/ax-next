import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTurnError,
  autoRetryTurn,
  shouldAutoRetry,
  lastUserMessageId,
  RETRYING_STATUS,
} from '../lib/turn-error';
import {
  agentStatusActions,
  getAgentStatusSnapshot,
} from '../lib/agent-status-store';
import { CONNECTION_LOST, DEFAULT_TURN_ERROR } from '../lib/transport';

// The runtime's onError glue (TASK-24): a PROVABLY-DEAD turn (orchestrator
// `error` frame) auto-retries the whole turn via autoRetryTurn with a visible
// RETRYING_STATUS; a CONNECTION_LOST drop (runner maybe alive) surfaces
// applyTurnError's manual-retry banner instead, since neither auto-recovery is
// loss-free AND duplicate-free there.

describe('applyTurnError', () => {
  afterEach(() => {
    agentStatusActions.reset();
  });

  it('flips the status row to error mode with the Error message and a retry', () => {
    const retry = vi.fn();
    applyTurnError(new Error('boom'), retry);

    const snap = getAgentStatusSnapshot();
    expect(snap.mode).toBe('error');
    expect(snap.text).toBe('boom');
    expect(typeof snap.retry).toBe('function');

    snap.retry!();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default message for a non-Error value', () => {
    applyTurnError('weird', () => undefined);
    expect(getAgentStatusSnapshot().text).toBe(DEFAULT_TURN_ERROR);
  });

  it('falls back to the default message for an Error with an empty message', () => {
    applyTurnError(new Error(''), () => undefined);
    expect(getAgentStatusSnapshot().text).toBe(DEFAULT_TURN_ERROR);
  });
});

describe('shouldAutoRetry', () => {
  it('auto-retries a provably-dead orchestrator terminal-error frame (the mapped labels only)', () => {
    expect(shouldAutoRetry(new Error(DEFAULT_TURN_ERROR), false)).toBe(true);
    expect(shouldAutoRetry(new Error('The agent timed out. Retry to continue.'), false)).toBe(true);
  });

  it('does NOT auto-retry a CONNECTION_LOST drop (runner may still be alive → duplicate/truncation risk)', () => {
    expect(shouldAutoRetry(new Error(CONNECTION_LOST), false)).toBe(false);
  });

  it('does NOT auto-retry a sendMessages REJECTION (unknown server state, not a terminal frame)', () => {
    // A POST/SSE-open failure carries an arbitrary message — NOT one of the
    // orchestrator terminal-error labels — so it must NOT auto-retry (it could
    // duplicate a turn that already started server-side). Codex round-3 P2.
    expect(
      shouldAutoRetry(new Error('chat-flow SSE open failed: 503 Service Unavailable'), false),
    ).toBe(false);
    expect(shouldAutoRetry(new Error('chat-flow POST failed: 500'), false)).toBe(false);
    expect(shouldAutoRetry(new Error('NetworkError when attempting to fetch resource.'), false)).toBe(false);
  });

  it('does NOT auto-retry a second time for the same turn (bounded to once)', () => {
    expect(shouldAutoRetry(new Error(DEFAULT_TURN_ERROR), true)).toBe(false);
  });
});

describe('lastUserMessageId', () => {
  it('returns the id of the last user message', () => {
    expect(
      lastUserMessageId([
        { role: 'user', id: 'u1' },
        { role: 'assistant', id: 'a1' },
        { role: 'user', id: 'u2' },
        { role: 'assistant', id: 'a2' },
      ]),
    ).toBe('u2');
  });

  it('returns null when there is no user message or the list is undefined', () => {
    expect(lastUserMessageId([{ role: 'assistant', id: 'a1' }])).toBeNull();
    expect(lastUserMessageId([])).toBeNull();
    expect(lastUserMessageId(undefined)).toBeNull();
  });

  it('a regenerate (same last user message id) reads as already-retried; a new turn (new id) resets', () => {
    // The runtime keys the once-per-turn auto-retry guard off this id: a
    // regenerate re-runs the SAME last user message (id unchanged → bounded),
    // a fresh send appends a new one (id changes → fresh budget). Codex r3 P2.
    const turn1 = [{ role: 'user', id: 'u1' }];
    const afterRegen = [{ role: 'user', id: 'u1' }, { role: 'assistant', id: 'a1-partial' }];
    expect(lastUserMessageId(turn1)).toBe(lastUserMessageId(afterRegen)); // same turn
    const turn2 = [...afterRegen, { role: 'user', id: 'u2' }];
    expect(lastUserMessageId(turn2)).not.toBe(lastUserMessageId(turn1)); // new turn
  });
});

describe('autoRetryTurn', () => {
  afterEach(() => {
    agentStatusActions.reset();
  });

  it('invokes the retry callback (re-runs the whole turn)', () => {
    const retry = vi.fn();
    autoRetryTurn(retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('RETRYING_STATUS is honest "retrying" copy (not the same as the manual-retry banner)', () => {
    // The runtime shows RETRYING_STATUS as a WORKING row (a retry is in flight),
    // distinct from applyTurnError's ERROR row (manual retry needed).
    expect(RETRYING_STATUS).toMatch(/retry/i);
    agentStatusActions.show(RETRYING_STATUS);
    const snap = getAgentStatusSnapshot();
    expect(snap.mode).toBe('working');
    expect(snap.text).toBe(RETRYING_STATUS);
    expect(snap.retry).toBeNull(); // no manual-retry button while auto-retrying
  });
});
