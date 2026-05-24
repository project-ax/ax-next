import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTurnError } from '../lib/turn-error';
import {
  agentStatusActions,
  getAgentStatusSnapshot,
} from '../lib/agent-status-store';
import { DEFAULT_TURN_ERROR } from '../lib/transport';

// applyTurnError is the runtime's onError glue (Fault A): it flips the
// agent-status row to error mode with a retry handler so a turn that died
// mid-stream surfaces as error+retry instead of a hung spinner.

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
