import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTurnError } from '../lib/turn-error';
import {
  agentStatusActions,
  getAgentStatusSnapshot,
} from '../lib/agent-status-store';
import { CONNECTION_LOST, DEFAULT_TURN_ERROR } from '../lib/transport';
import { HttpError, HTTP_SESSION_ENDED } from '../lib/http';

// applyTurnError is the runtime's onError glue: it flips the agent-status row
// to error mode with a retry handler so a turn that ended in an error chunk
// (Fault A orchestrator-terminated, OR a CONNECTION_LOST sentinel after the
// transport exhausted its transparent reconnects) surfaces as error+retry
// instead of a hung spinner or a silent finalize.

describe('applyTurnError', () => {
  afterEach(() => {
    agentStatusActions.reset();
  });

  it('flips the status row to error mode with a retry', () => {
    const retry = vi.fn();
    applyTurnError(new Error(CONNECTION_LOST), retry);

    const snap = getAgentStatusSnapshot();
    expect(snap.mode).toBe('error');
    expect(snap.text).toBe(CONNECTION_LOST);
    expect(typeof snap.retry).toBe('function');

    snap.retry!();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  /*
    TASK-288 — this row renders directly above the composer, and it used to
    print `error.message` whatever that message was. The predecessor of this
    test asserted exactly that (`new Error('boom')` → the row reads `boom`),
    which is how `chat-flow POST failed: 401 Unauthorized` reached readers.

    The rule now: an error only speaks here if we can point at where its words
    came from. Everything else gets the default line on screen and its real
    message in the console, which is where an unrecognised message is useful.
  */
  it('does NOT publish the message of an error it cannot vouch for', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    applyTurnError(new Error('boom'), () => undefined);
    expect(getAgentStatusSnapshot().text).toBe(DEFAULT_TURN_ERROR);
    // Quiet on screen is not silent anywhere else: the real error still goes
    // somewhere an operator can read it.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('do not publish'),
      expect.objectContaining({ message: 'boom' }),
    );
    warn.mockRestore();
  });

  it('publishes an HttpError, whose message is authored by construction', () => {
    applyTurnError(new HttpError('/api/chat/messages', 401), () => undefined);
    expect(getAgentStatusSnapshot().text).toBe(HTTP_SESSION_ENDED);
  });

  /*
    Fault A sends `${label}\n${detail}` — an authored headline with an
    untrusted, server-clamped detail line under it. The allow-list matches on
    the FIRST LINE so the detail still rides along; matching the whole string
    would silently drop every Fault A message that carried one.
  */
  it('publishes a known label that carries a detail line', () => {
    applyTurnError(
      new Error('The agent timed out. Retry to continue.\nran 30m'),
      () => undefined,
    );
    expect(getAgentStatusSnapshot().text).toBe(
      'The agent timed out. Retry to continue.\nran 30m',
    );
  });

  it('does not publish an unknown headline just because it has a detail line', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    applyTurnError(new Error('psql: FATAL: role missing\nat line 3'), () => undefined);
    expect(getAgentStatusSnapshot().text).toBe(DEFAULT_TURN_ERROR);
    vi.restoreAllMocks();
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
