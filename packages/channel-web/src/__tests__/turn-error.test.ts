import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTurnError,
  createRetryBudget,
  handleTurnError,
} from '../lib/turn-error';
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
// CONNECTION_LOST sentinel (and a hard network drop surfaces a fetch
// TypeError), which on the FIRST failure of a turn retries silently (no
// banner) and on the SECOND surfaces the banner. Any other error (Fault A /
// orchestrator-terminated) shows the banner immediately. The one-retry cap
// is scoped PER-TURN via the budget keyed on `turnKey`.
describe('handleTurnError — Faults B/D silent-retry then banner', () => {
  afterEach(() => {
    agentStatusActions.reset();
  });

  // A fresh single-turn budget keyed to the same turn for the simple cases.
  const TURN = 'msg-user-1';

  it('silently retries (no banner) on the FIRST connection-lost error', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new Error(CONNECTION_LOST),
      turnKey: TURN,
      budget: createRetryBudget(),
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

  it('shows the error banner on a SECOND connection-lost error (same turn)', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    const budget = createRetryBudget();
    // First failure of this turn spends the silent retry.
    handleTurnError({
      error: new Error(CONNECTION_LOST),
      turnKey: TURN,
      budget,
      silentRetry,
      showError,
    });
    // Second failure of the SAME turn → banner.
    handleTurnError({
      error: new Error(CONNECTION_LOST),
      turnKey: TURN,
      budget,
      silentRetry,
      showError,
    });
    expect(silentRetry).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(new Error(CONNECTION_LOST));
  });

  it('shows the error banner immediately for a non-connection-lost error (even on a fresh turn)', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    const err = new Error('The agent timed out. Retry to continue.');
    handleTurnError({
      error: err,
      turnKey: TURN,
      budget: createRetryBudget(),
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(err);
  });

  it('a non-connection-lost error does NOT spend the silent-retry budget', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    const budget = createRetryBudget();
    // Fault A on this turn → banner, budget untouched.
    handleTurnError({
      error: new Error('orchestrator terminated'),
      turnKey: TURN,
      budget,
      silentRetry,
      showError,
    });
    // A subsequent connection-lost on the SAME turn still has its silent retry.
    handleTurnError({
      error: new Error(CONNECTION_LOST),
      turnKey: TURN,
      budget,
      silentRetry,
      showError,
    });
    expect(silentRetry).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('treats a non-Error value as a non-connection-lost error → banner', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: 'weird string',
      turnKey: TURN,
      budget: createRetryBudget(),
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
  });

  // IDEMPOTENCY GUARD — a raw fetch/network `TypeError` is NOT treated as
  // connection-lost. It can surface from the non-idempotent POST or the
  // initial GET (both run BEFORE the SSE stream exists); a silent re-POST
  // could duplicate the conversation/turn. Only the transport-controlled
  // CONNECTION_LOST sentinel (raised exclusively after the stream is
  // established) is silently retried. A pre-stream fetch TypeError → banner.
  it('does NOT silently retry a raw fetch-failure TypeError → banner (idempotency guard)', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new TypeError('Failed to fetch'),
      turnKey: TURN,
      budget: createRetryBudget(),
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('does NOT silently retry a NetworkError TypeError → banner (idempotency guard)', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new TypeError('NetworkError when attempting to fetch the resource'),
      turnKey: TURN,
      budget: createRetryBudget(),
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
  });

  // The silent-retry path must FORCE working mode even when a prior error
  // banner is still on screen (e.g. the previous turn's error hadn't been
  // cleared yet). Using the label-only set() would leave mode:'error' + the
  // stale retry/dismiss handlers, so the "silent" retry would still show the
  // red banner. show() flips to working mode and clears those handlers.
  it('forces working mode (clears a stale error banner) on the silent-retry path', () => {
    // Pre-seed a visible error row from a prior turn.
    const staleRetry = vi.fn();
    agentStatusActions.error('a previous turn died', { retry: staleRetry });
    expect(getAgentStatusSnapshot().mode).toBe('error');

    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new Error(CONNECTION_LOST),
      turnKey: TURN,
      budget: createRetryBudget(),
      silentRetry,
      showError,
    });

    const snap = getAgentStatusSnapshot();
    expect(snap.mode).toBe('working'); // forced back to working, NOT error
    expect(snap.text).toBe(CONNECTION_LOST);
    expect(snap.retry).toBeNull(); // stale retry/dismiss handlers cleared
    expect(snap.dismiss).toBeNull();
    expect(silentRetry).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });
});

// createRetryBudget scopes the one-retry cap PER USER TURN (Codex finding):
// after a connection-lost turn spends its retry and the retry also fails,
// a FRESH turn (different turnKey) must get its own silent retry instead of
// going straight to the banner.
describe('createRetryBudget — per-turn silent-retry budget', () => {
  it('allows exactly one retry per turn key', () => {
    const budget = createRetryBudget();
    expect(budget.consume('turn-A')).toBe(true); // first failure spends it
    expect(budget.consume('turn-A')).toBe(false); // already spent for turn-A
    expect(budget.consume('turn-A')).toBe(false);
  });

  it('resets the budget when a NEW turn key arrives (no leak across turns)', () => {
    const budget = createRetryBudget();
    expect(budget.consume('turn-A')).toBe(true);
    expect(budget.consume('turn-A')).toBe(false); // turn-A spent
    // User submits a different message — fresh turn gets its own retry.
    expect(budget.consume('turn-B')).toBe(true);
    expect(budget.consume('turn-B')).toBe(false);
  });

  it('treats null/undefined keys as a single shared turn', () => {
    const budget = createRetryBudget();
    expect(budget.consume(null)).toBe(true);
    expect(budget.consume(undefined)).toBe(false); // same (null) turn
    expect(budget.consume(null)).toBe(false);
  });

  // The exact end-to-end scenario Codex flagged: a connection-lost turn that
  // spends its retry AND fails the retry must NOT leak the spent budget into
  // a subsequent fresh turn.
  it('a fresh turn after an exhausted+failed turn still gets a silent retry', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    const budget = createRetryBudget();
    // Turn A: drop → silent retry, retry also drops → banner.
    handleTurnError({ error: new Error(CONNECTION_LOST), turnKey: 'A', budget, silentRetry, showError });
    handleTurnError({ error: new Error(CONNECTION_LOST), turnKey: 'A', budget, silentRetry, showError });
    expect(silentRetry).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledTimes(1);
    // Turn B (user submits a new message): its first drop retries silently.
    handleTurnError({ error: new Error(CONNECTION_LOST), turnKey: 'B', budget, silentRetry, showError });
    expect(silentRetry).toHaveBeenCalledTimes(2);
    expect(showError).toHaveBeenCalledTimes(1); // no new banner
  });
});
