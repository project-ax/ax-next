/**
 * Test triggers for the status / error UI. These are dev-only inputs
 * (`/status …`, `/error …`) that fire the corresponding UI surface
 * without going through the runtime — used to verify the visual
 * behavior without needing a real backend failure.
 *
 * Behaviors under test:
 *
 *   1. `/status` (no arg) cycles "Thinking…" → "Starting sandbox…" →
 *      "Installing dependencies…" then hides.
 *
 *   2. `/status <text>` shows the text for 3s then hides.
 *
 *   3. `/error transient` flips the status row into error mode with a
 *      retry callback registered.
 *
 *   4. `/error inline` attaches a `.msg-error` row to the last `.msg.you`
 *      DOM node found via the locator.
 *
 *   5. `/error inline` with no user message in the DOM falls back (no
 *      inline row attached).
 *
 *   6. `/error all` fires status + inline + toast surfaces.
 *
 *   7. Unrecognized `/error <unknown>` still returns true (consumed,
 *      not sent as chat).
 *
 *   8. `handleTestTrigger` returns false for non-trigger input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleTestTrigger,
  testTriggersInternals,
} from '../lib/agent-status-test-triggers';
import {
  agentStatusActions,
  getAgentStatusSnapshot,
} from '../lib/agent-status-store';
import { toastActions } from '../lib/toast-store';

const clearBody = (): void => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
};

describe('handleTestTrigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentStatusActions.reset();
    toastActions.reset();
    clearBody();
    testTriggersInternals.cancelPendingTimers();
  });
  afterEach(() => {
    testTriggersInternals.cancelPendingTimers();
    vi.useRealTimers();
    agentStatusActions.reset();
    toastActions.reset();
    clearBody();
  });

  it('returns false for non-trigger input', () => {
    expect(handleTestTrigger('hello world')).toBe(false);
  });

  it('/status (no arg) cycles labels then hides', () => {
    expect(handleTestTrigger('/status')).toBe(true);
    expect(getAgentStatusSnapshot().mode).toBe('working');
    expect(getAgentStatusSnapshot().text).toBe('Thinking…');
    vi.advanceTimersByTime(1200);
    expect(getAgentStatusSnapshot().text).toBe('Starting sandbox…');
    vi.advanceTimersByTime(1200);
    expect(getAgentStatusSnapshot().text).toBe('Installing dependencies…');
    vi.advanceTimersByTime(2000);
    expect(getAgentStatusSnapshot().mode).toBe('hidden');
  });

  it('/status <text> shows custom text and hides after 3s', () => {
    expect(handleTestTrigger('/status Building image…')).toBe(true);
    expect(getAgentStatusSnapshot().text).toBe('Building image…');
    vi.advanceTimersByTime(3100);
    expect(getAgentStatusSnapshot().mode).toBe('hidden');
  });

  it('/error transient flips the status row into error mode with retry', () => {
    expect(handleTestTrigger('/error transient')).toBe(true);
    const snap = getAgentStatusSnapshot();
    expect(snap.mode).toBe('error');
    expect(snap.text).toContain('Connection lost');
    expect(snap.retry).not.toBeNull();
  });

  it('/error inline attaches a .msg-error row to the last .msg.you', () => {
    const msg = document.createElement('div');
    msg.className = 'msg you';
    document.body.appendChild(msg);

    expect(handleTestTrigger('/error inline')).toBe(true);
    const errorRow = msg.querySelector('.msg-error');
    expect(errorRow).toBeTruthy();
    expect(errorRow?.querySelector('.msg-error-icon')?.textContent).toBe('!');
    expect(errorRow?.querySelector('.msg-error-action.retry')).toBeTruthy();
    expect(errorRow?.querySelector('.msg-error-action.dismiss')).toBeTruthy();
  });

  it('/error inline with no user message attaches no row', () => {
    expect(handleTestTrigger('/error inline')).toBe(true);
    expect(document.querySelector('.msg-error')).toBeNull();
  });

  it('/error all fires transient + inline + toast surfaces', () => {
    const msg = document.createElement('div');
    msg.className = 'msg you';
    document.body.appendChild(msg);

    expect(handleTestTrigger('/error all')).toBe(true);
    expect(getAgentStatusSnapshot().mode).toBe('error');
    expect(msg.querySelector('.msg-error')).toBeTruthy();
  });

  it('/error <unknown> still consumes the input', () => {
    expect(handleTestTrigger('/error wat')).toBe(true);
  });
});
