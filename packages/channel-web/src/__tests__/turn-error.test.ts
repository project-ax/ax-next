import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTurnError,
  autoRetryTurn,
  shouldAutoRetry,
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
  it('auto-retries a provably-dead orchestrator error (any non-CONNECTION_LOST message)', () => {
    expect(shouldAutoRetry(new Error('The agent stopped unexpectedly. Retry to continue.'), false)).toBe(true);
    expect(shouldAutoRetry(new Error('The agent timed out. Retry to continue.'), false)).toBe(true);
  });

  it('does NOT auto-retry a CONNECTION_LOST drop (runner may still be alive → duplicate/truncation risk)', () => {
    expect(shouldAutoRetry(new Error(CONNECTION_LOST), false)).toBe(false);
  });

  it('does NOT auto-retry a second time (bounded to once per turn)', () => {
    // Even a provably-dead error won't auto-retry again once we've already retried.
    expect(shouldAutoRetry(new Error('The agent stopped unexpectedly. Retry to continue.'), true)).toBe(false);
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
