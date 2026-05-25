import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTurnError, handleTurnError } from '../lib/turn-error';
import {
  agentStatusActions,
  getAgentStatusSnapshot,
} from '../lib/agent-status-store';
import { CONNECTION_LOST, DEFAULT_TURN_ERROR } from '../lib/transport';

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

// handleTurnError routes a failed turn to either a SILENT retry or the
// error banner (Faults B/D, FAULTA-5): a done-less close surfaces the
// CONNECTION_LOST sentinel, which on the FIRST failure of a turn retries
// silently (no banner) and on the SECOND surfaces the banner. Any other
// error (Fault A / orchestrator-terminated) shows the banner immediately.
describe('handleTurnError — Faults B/D silent-retry then banner', () => {
  afterEach(() => {
    agentStatusActions.reset();
  });

  it('silently retries (no banner) on the FIRST connection-lost error', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new Error(CONNECTION_LOST),
      isFirstFailure: true,
      silentRetry,
      showError,
    });
    expect(silentRetry).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
    // The row shows a transient working-mode label, NOT the error banner.
    const snap = getAgentStatusSnapshot();
    expect(snap.mode).toBe('working');
    expect(snap.text).toBe(CONNECTION_LOST);
  });

  it('shows the error banner on a SECOND connection-lost error', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new Error(CONNECTION_LOST),
      isFirstFailure: false,
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(new Error(CONNECTION_LOST));
  });

  it('shows the error banner immediately for a non-connection-lost error (even on first failure)', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    const err = new Error('The agent timed out. Retry to continue.');
    handleTurnError({
      error: err,
      isFirstFailure: true,
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(err);
  });

  it('treats a non-Error value as a non-connection-lost error → banner', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: 'weird string',
      isFirstFailure: true,
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
  });

  // Fault D — a HARD network drop mid-turn doesn't reach our flush() (the
  // fetch body ReadableStream errors, so the TransformStream flush is
  // skipped). The AI SDK surfaces the raw fetch TypeError to onError
  // ("Failed to fetch" / network error). handleTurnError must treat THAT
  // as connection-lost too, so a genuine network drop still gets the first
  // silent retry instead of the banner.
  it('silently retries on a fetch-failure TypeError (hard network drop, first failure)', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new TypeError('Failed to fetch'),
      isFirstFailure: true,
      silentRetry,
      showError,
    });
    expect(silentRetry).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });

  it('matches a network-error TypeError (NetworkError when attempting to fetch resource)', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new TypeError('NetworkError when attempting to fetch the resource'),
      isFirstFailure: true,
      silentRetry,
      showError,
    });
    expect(silentRetry).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });

  it('shows the banner on a SECOND fetch-failure TypeError (one silent retry max)', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new TypeError('Failed to fetch'),
      isFirstFailure: false,
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('does NOT treat an unrelated TypeError as connection-lost → banner', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new TypeError('Cannot read properties of undefined'),
      isFirstFailure: true,
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
  });
});
