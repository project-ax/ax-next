import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import {
  IPC_TIMEOUTS_MS,
  SessionNextMessageResponseSchema,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { HandlerResult } from './types.js';

// ---------------------------------------------------------------------------
// GET /session.next-message?cursor=N
//
// Bounded long-poll — I12 caps the wait at 30s via IPC_TIMEOUTS_MS. The
// cursor is carried in the query string (not the body — GET has no body
// by HTTP's and our body-reader's contract), so we validate it by hand.
//
// `session:claim-work` owns the actual wait. Its response matches the
// SessionNextMessageResponseSchema directly (three-variant discriminated
// union keyed on `type`).
// ---------------------------------------------------------------------------

/**
 * Strict non-negative-integer parse. `Number('')` yields 0 (accepts missing
 * cursor), `Number('abc')` yields NaN, `Number('-1')` yields -1. Number parses
 * are famously forgiving — the explicit checks here are the whole point.
 *
 * Rejects: missing param, empty string, non-integers, negatives, Infinity/NaN,
 * scientific notation that decodes to a non-integer, strings with trailing
 * junk (`'1abc'` is rejected because Number returns NaN for it).
 */
function parseCursor(raw: string | null): number | null {
  if (raw === null || raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

export async function sessionNextMessageHandler(
  url: URL,
  ctx: AgentContext,
  bus: HookBus,
): Promise<HandlerResult> {
  const rawCursor = url.searchParams.get('cursor');
  const cursor = parseCursor(rawCursor);
  if (cursor === null) {
    return validationError('session.next-message: cursor must be a non-negative integer');
  }

  let result: unknown;
  try {
    result = await bus.call(
      'session:claim-work',
      ctx,
      {
        sessionId: ctx.sessionId,
        cursor,
        timeoutMs: IPC_TIMEOUTS_MS['session.next-message'],
      },
    );
  } catch (err) {
    logInternalError(ctx.logger, 'session.next-message', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  const checked = SessionNextMessageResponseSchema.safeParse(result);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'session.next-message',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
}
