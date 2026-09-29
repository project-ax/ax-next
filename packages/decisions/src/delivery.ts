/**
 * Handing a resolved decision back to a still-warm agent.
 *
 * The agent is parked inside `inbox-loop.ts`'s long-poll on
 * `session.next-message` — that is what "attended" means, mechanically. So the
 * delivery is one `session:queue-work` onto that session's inbox, and the
 * runner wakes with a `decision-resolved` entry.
 *
 * WHAT THIS IS NOT. It is not the authorisation. The standing approval lives on
 * the decision row, keyed on the held call's fingerprint (AW-4), and it is
 * consumed at the pre-call gate exactly once. This module only tells the agent
 * that a person answered. A delivery that never arrives costs the agent its
 * narration, never its correctness.
 *
 * WHICH IS WHY IT NEVER THROWS. If the session is gone — the person took a
 * minute, the idle reaper won, the pod was rescheduled — there is nothing here
 * to deliver to and nothing here to fix. Every outcome comes back as a VALUE.
 *
 * THE CALLER MUST READ THAT VALUE (TASK-277). A failed delivery is not a
 * cosmetic loss of narration; it is evidence that the agent this decision was
 * routed to does not exist. `decisions:approve` reads it that way and takes the
 * host replay itself, because the standing authorisation on the row only helps
 * if the agent ever runs again — and for a conversation whose session has
 * already expired, it does not. Discarding this return is exactly how an
 * approval came to be consumed with nothing behind it.
 */
import type { AgentContext, HookBus } from '@ax/core';
import { conversationChannel } from './attendance.js';
import { PLUGIN_NAME } from './pre-call.js';
import { replayContext } from './replay.js';
import { decisionApprovedNote, decisionDismissedNote } from './templates.js';
import type { Decision } from './types.js';

/** Named once — it appears in the manifest's `optionalCalls` and in the guard below. */
export const SESSION_QUEUE_HOOK = 'session:queue-work';

/**
 * The veto fired before a resolution wakes a parked agent (TASK-692). A
 * subscriber hook, not a service: many may weigh in (usage limits today), any
 * one can refuse, and none is required to exist.
 */
export const CHAT_RESUME_HOOK = 'chat:resume';

/**
 * Bound on each `chat:resume` subscriber, in ms. `fire` puts no clock on
 * subscribers by default, and this runs on the approve/sweep path where a
 * subscriber that never settles would wedge every delivery behind it. Past the
 * bound the subscriber is skipped and the delivery proceeds. The same bound as
 * the orchestrator's `chat:start` (60 s) and the same posture, so the two gates
 * of one policy cannot disagree about how long a stalled check is waited on.
 */
export const CHAT_RESUME_SUBSCRIBER_TIMEOUT_MS = 60_000;

/** What a person said. Human vocabulary, deliberately not the row's status. */
export type ResolutionOutcome = 'approved' | 'dismissed';

export type DeliveryResult =
  /**
   * The entry is on the session's inbox. `streamReqId` is the continuation
   * id the entry carries, or null when the turn runs dark (TASK-278).
   */
  | { delivered: true; streamReqId: string | null }
  /**
   * Nobody was listening. `reason` is for the log and the test, never for a
   * receipt: a person who clicked Approve does not need to hear about session
   * lifecycles, and the thing they approved still happens.
   */
  | {
      delivered: false;
      reason: 'no-session' | 'no-session-plugin' | 'queue-failed' | 'refused';
    };

/**
 * Bound on the continuation reqId riding a `decision-resolved` entry. reqIds
 * are `req-<12 hex>` (16 chars); 128 is headroom, not a second format — the
 * same cap the chat wire uses for short subject ids. Anything longer is not a
 * reqId and is dropped, never fatal.
 */
export const CONTINUATION_REQ_ID_MAX = 128;

/**
 * The one bound on a continuation reqId, as a value: the id itself when it is
 * one, null when it is absent or malformed. Shared by the approve path (which
 * STORES the id for the deferred delivery, TASK-574) and `deliverResolution`
 * (which re-checks what it is handed), so the two cannot disagree about what
 * counts as an id.
 */
export function validContinuationReqId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= CONTINUATION_REQ_ID_MAX
    ? raw
    : null;
}

export interface DeliverResolutionInput {
  bus: HookBus;
  /**
   * The APPROVING request's context — used only for its logger. Every bus call
   * below runs under a context built from the DECISION instead; see the body.
   */
  ctx: AgentContext;
  decision: Decision;
  outcome: ResolutionOutcome;
  /**
   * TASK-278 — opaque chat correlation for the continuation turn. Passed
   * through onto the inbox entry untouched so the woken runner emits under
   * it; omitted when absent or malformed. Validated HERE, once, so every
   * caller below speaks for a real value.
   */
  continuationReqId?: string;
}

export async function deliverResolution({
  bus,
  ctx,
  decision,
  outcome,
  continuationReqId,
}: DeliverResolutionInput): Promise<DeliveryResult> {
  if (!bus.hasService(SESSION_QUEUE_HOOK)) return { delivered: false, reason: 'no-session-plugin' };

  // Under the DECISION's owner and agent, never the approving request's — the
  // same rule AW-5's host replay follows, and for a sharper reason here.
  //
  // `conversations:get-metadata` pre-filters on `(conversationId, userId)` and
  // answers `not-found` for a row belonging to anyone else. `decisions:approve`
  // takes its `userId` from the INPUT, so an approver whose ctx names a
  // different user than the decision's owner would read nothing back — and
  // "nothing" is indistinguishable from "the session is gone". The delivery
  // would be skipped silently on every approval, forever, and every test that
  // passes the same user for both would still be green.
  const deliveryCtx = replayContext(decision);

  // The SAME single indexed read the attendance lookup used, for the same
  // reason: the answer to "is anyone there" and "who is there" is one row.
  const channel = await conversationChannel(bus, deliveryCtx, decision.conversationId);
  if (channel === null || channel.activeSessionId === null) {
    ctx.logger.info('decision_delivery_skipped_no_session', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      outcome,
    });
    return { delivered: false, reason: 'no-session' };
  }

  const note = outcome === 'approved' ? decisionApprovedNote() : decisionDismissedNote();
  // Fail-closed: a malformed id rides as ABSENT, and the approval still
  // delivers — the runner then runs dark exactly as it did before TASK-278.
  const streamReqId = validContinuationReqId(continuationReqId);
  if (continuationReqId !== undefined && streamReqId === null) {
    ctx.logger.warn('decision_delivery_dropped_bad_continuation', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      outcome,
    });
  }

  // TASK-692 — a `decision-resolved` entry wakes the runner into a NEW turn
  // (the agent reads the note and carries on, spending tokens) without that turn
  // ever passing `agent:invoke`, so `chat:start` — where per-user usage limits
  // and the kill switch live — never sees it. `chat:resume` is the veto that
  // closes that door: fired as the decision's OWNER (the person whose money it
  // is, never the approver), subscribers judge it exactly as they would a
  // `chat:start`. A refusal is not a failure of the approval: the click already
  // succeeded; the agent just is not woken, and the caller treats it like any
  // other delivery nobody received (the sweep's replay fallback still makes the
  // call the person approved). Bounded, and it proceeds past a subscriber that
  // never settles.
  const gate = await bus.fire(
    CHAT_RESUME_HOOK,
    deliveryCtx,
    { decisionId: decision.id, outcome },
    { subscriberTimeoutMs: CHAT_RESUME_SUBSCRIBER_TIMEOUT_MS },
  );
  if (gate.rejected) {
    ctx.logger.info('decision_delivery_refused', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      outcome,
      reason: gate.reason,
    });
    return { delivered: false, reason: 'refused' };
  }

  try {
    await bus.call(SESSION_QUEUE_HOOK, deliveryCtx, {
      sessionId: channel.activeSessionId,
      entry: {
        type: 'decision-resolved',
        decisionId: decision.id,
        outcome,
        note,
        ...(streamReqId !== null ? { reqId: streamReqId } : {}),
      },
    });
    ctx.logger.info('decision_delivered', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      outcome,
    });
    return { delivered: true, streamReqId };
  } catch (err) {
    // `unknown-session` is the ordinary case: the row still names a session the
    // reaper has since torn down. It is logged at warn rather than error
    // because nothing is broken and nothing is lost — the standing
    // authorisation outlives the session.
    ctx.logger.warn('decision_delivery_failed', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      outcome,
      err: err instanceof Error ? err : new Error(String(err)),
    });
    return { delivered: false, reason: 'queue-failed' };
  }
}
