import type { AgentContext, HookBus } from '@ax/core';
import {
  EventTurnEndSchema,
  sanitizeActivityPhrase,
  type EventTurnEnd,
} from '@ax/ipc-protocol';
import { zodSummary, validationError } from '../errors.js';
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
//      dispatcher awaits this handler before the 202 (EventSpec.persist), so
//      a completed turn is durable in the redisplay SoT before the runner sees
//      it acked. The persist hook is an OPTIONAL dependency: deployments
//      without @ax/conversations (the single-session CLI) simply skip it.
//      A persist FAILURE propagates (we re-throw) so the dispatcher can signal
//      the runner with a non-2xx instead of falsely acking a turn that never
//      reached the log (no silent omission — B3).
//
//      TASK-995 removed the refused-save notice row TASK-731 wrote here, with
//      the workspace save it reported. The schema strips the field an older
//      runner may still send, so nothing below ever sees it.
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
    return validationError(`event.turn-end: ${zodSummary(parsed.error)}`);
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
 * (1) Persist-before-ack — the display-log append, ISOLATED and AWAITED before
 * the 202. ONLY this runs in the awaited path (the dispatcher's `persist`
 * slot); the broadcast (fireEventTurnEnd) does NOT, so a slow observer (e.g.
 * the title-LLM subscriber) can't delay the runner's turn-end ack or its
 * downstream done-frame.
 *
 * Only non-heartbeat turns (role + non-empty contentBlocks) are displayed, so
 * only those persist. conversationId comes from the host-stamped ctx (NOT the
 * untrusted payload), so a runner can't aim a frame at a foreign conversation.
 *
 * A failure propagates, and the dispatcher answers 500 instead of a false 202
 * (B3). Before it throws, @ax/conversations retries a checkout that never got
 * a connection, three attempts in all (TASK-1059); nothing else is retried.
 * The runner sends this event once and catches the 500 (agent-runner-core
 * `closeTurn`), so the row is then lost: the dispatcher's code-only
 * `event_persist_failed` line is the host's only record that it was.
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
