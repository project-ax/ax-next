import type { AgentContext, HookBus } from '@ax/core';
import {
  EventTurnEndSchema,
  SaveRefusedCodeSchema,
  sanitizeActivityPhrase,
  type EventTurnEnd,
  type SaveRefusedCode,
} from '@ax/ipc-protocol';
import { validationError } from '../errors.js';
import type { HandlerErr } from './types.js';

// ---------------------------------------------------------------------------
// POST /event.turn-end
//
// Two responsibilities, in order:
//
//   1. TASK-66 (out-of-git Part B / B1 / B3 — persist-before-ack). Persist the
//      turn's DISPLAY frame (role + contentBlocks) into the display event log
//      via `conversations:append-event` — AWAITED, isolated to JUST the
//      persist (NOT the whole chat:turn-end broadcast, which carries the
//      title-LLM subscriber and would otherwise block every turn's ack). The
//      dispatcher awaits this handler before the 202 (EventSpec.awaitFire), so
//      a completed turn is durable in the redisplay SoT before the runner sees
//      it acked. The persist hook is an OPTIONAL dependency: deployments
//      without @ax/conversations (the single-session CLI) simply skip it.
//      A persist FAILURE propagates (we re-throw) so the dispatcher can signal
//      the runner with a non-2xx instead of falsely acking a turn that never
//      reached the log (no silent omission — B3).
//
//      TASK-731: when the runner reports `saveRefused`, a `save-refused`
//      display event follows the turn row (best-effort, never re-thrown), so
//      the notice survives a reload instead of living only on the `done`
//      frame.
//
//   2. Fire `chat:turn-end` (fire-and-forget broadcast) for every OTHER
//      observer — last_activity bump, clear-active-req-id, the buffer
//      evictor, conversation-titles, routines. These are not gated by the
//      persist-before-ack invariant, so a rejection is logged, never echoed.
// ---------------------------------------------------------------------------

export function validateEventTurnEnd(rawPayload: unknown):
  | { ok: true; payload: EventTurnEnd }
  | HandlerErr {
  const parsed = EventTurnEndSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`event.turn-end: ${parsed.error.message}`);
  }
  // TASK-271: same fence as the stream-chunk path — these blocks persist
  // into the display log (persist-before-ack below), so a hostile phrase
  // must be mangled before durability, not after.
  if (parsed.data.contentBlocks !== undefined) {
    for (const block of parsed.data.contentBlocks) {
      if (block.type === 'tool_use') {
        const clean = sanitizeActivityPhrase(block.activityPhrase);
        if (clean === undefined) {
          delete block.activityPhrase;
        } else {
          block.activityPhrase = clean;
        }
      }
    }
  }
  return { ok: true, payload: parsed.data };
}

interface AppendEventCall {
  conversationId: string;
  kind: 'turn';
  role: 'user' | 'assistant' | 'tool';
  payload: { blocks: unknown };
}

/**
 * TASK-731 — the `conversations:append-event` input for a `save-refused`
 * display event. Duck-typed like AppendEventCall (no import from
 * @ax/conversations — invariant 2). `key` is the fold key: rows with the same
 * key fold to the later one on read.
 */
export interface AppendSaveRefusedCall {
  conversationId: string;
  kind: 'save-refused';
  key: string;
  payload: { code: SaveRefusedCode };
}

const SAVE_REFUSED_CODES: ReadonlySet<string> = new Set(
  SaveRefusedCodeSchema.options,
);

/**
 * TASK-731 — write one `save-refused` display event, best-effort.
 *
 * Shared by the turn-end persist (key = the turn's reqId) and the chat-end
 * persist (key = a host-minted `final:<uuid>`). It never throws, and that is
 * deliberate:
 *   - on turn-end the `turn` row has already landed, so a throw would 5xx a
 *     turn the log already holds, and the runner's retry would write that
 *     turn row twice;
 *   - on chat-end a throw must not cost the `chat:end` that resolves the
 *     person's waiting turn;
 *   - the live `done` frame still carries the per-turn notice, so a lost row
 *     costs the notice only on a later reload.
 * The failure is logged at error so it is not silent.
 */
export async function appendSaveRefusedBestEffort(
  ctx: AgentContext,
  bus: HookBus,
  code: unknown,
  key: string,
): Promise<void> {
  const conversationId = ctx.conversationId;
  if (
    conversationId === undefined ||
    typeof code !== 'string' ||
    !SAVE_REFUSED_CODES.has(code) ||
    !bus.hasService('conversations:append-event')
  ) {
    return;
  }
  try {
    await bus.call<AppendSaveRefusedCall, void>(
      'conversations:append-event',
      ctx,
      {
        conversationId,
        kind: 'save-refused',
        key,
        payload: { code: code as SaveRefusedCode },
      },
    );
  } catch (err) {
    ctx.logger.error('save_refused_persist_failed', {
      code,
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * (1) Persist-before-ack — the display-log append, ISOLATED and AWAITED before
 * the 202. ONLY this runs in the awaited path (the dispatcher's `persist`
 * slot); the broadcast (fireEventTurnEnd) does NOT, so a slow observer (e.g.
 * the title-LLM subscriber) can't delay the runner's turn-end ack or its
 * downstream done-frame.
 *
 * Only non-heartbeat turns (role + non-empty contentBlocks) are displayed, so
 * only those persist. conversationId comes from the host-stamped ctx (NOT the
 * untrusted payload), so a runner can't aim a frame at a foreign conversation.
 * The append-event store retries the seq-allocation race internally; a genuine
 * persist failure re-throws → the dispatcher returns a non-2xx + logs loudly
 * (B3 no-omission: never a silent drop).
 */
export async function persistEventTurnEnd(
  ctx: AgentContext,
  bus: HookBus,
  payload: unknown,
): Promise<void> {
  const p = payload as Partial<EventTurnEnd>;
  const conversationId = ctx.conversationId;
  if (
    conversationId !== undefined &&
    p.role !== undefined &&
    Array.isArray(p.contentBlocks) &&
    p.contentBlocks.length > 0 &&
    bus.hasService('conversations:append-event')
  ) {
    await bus.call<AppendEventCall, void>('conversations:append-event', ctx, {
      conversationId,
      kind: 'turn',
      role: p.role,
      payload: { blocks: p.contentBlocks },
    });
  }
  // TASK-731: the refused-save notice, AFTER the turn row so it sorts after
  // the reply it belongs to. Also written when there was no turn row (a
  // turn-end with no blocks still carries the code). Keyed on the turn's
  // reqId: both turn-ends of one turn (tool, then assistant) carry the code,
  // and the read folds them to the later row. Best-effort (see the helper);
  // a failure of the TURN append above still re-throws, as before.
  if (p.saveRefused !== undefined) {
    const key =
      typeof p.reqId === 'string' && p.reqId.length > 0 ? p.reqId : '';
    await appendSaveRefusedBestEffort(ctx, bus, p.saveRefused, key);
  }
}

/**
 * (2) Broadcast `chat:turn-end` to every OTHER observer — last_activity bump,
 * clear-active-req-id, the buffer evictor, conversation-titles, routines.
 * These are not gated by persist-before-ack, so this is fire-and-forget at the
 * ack level (the dispatcher does NOT await it for turn-end). A rejection is
 * logged, never echoed.
 */
export async function fireEventTurnEnd(
  ctx: AgentContext,
  bus: HookBus,
  payload: unknown,
): Promise<void> {
  const result = await bus.fire('chat:turn-end', ctx, payload);
  if (result.rejected) {
    ctx.logger.warn('event_subscriber_rejected', {
      hook: 'chat:turn-end',
      reason: result.reason,
    });
  }
}
