/**
 * The three things that have to happen on a timer, and nothing else.
 *
 *   1. Decisions expire. Approving something drafted a week ago is approving a
 *      world that is gone. The freshness guard (AW-7) is a per-call answer to a
 *      per-call question and is NOT a substitute for a bound on how long an
 *      intention stays live — a question nobody answered should stop being a
 *      question, not sit in the queue forever looking answerable.
 *
 *   2. Deferred replays come due. An irreversible call waits out the undo
 *      window before it actually runs, so that "undo" is a real grace period
 *      before the outward action rather than a button that cannot undo
 *      anything (design H1). Something has to run it when the window closes.
 *
 *   3. Flights nobody is flying get given up on (TASK-253). A host that died
 *      mid-replay left a row holding a standing authorisation that nothing will
 *      ever cash, and holding it is what makes a later approval of the same
 *      call collide and do nothing.
 *
 * The expiry half is a BACKSTOP, not the guarantee. `approveDecision` already
 * refuses an expired row on read and `decisions:list` sweeps before it returns,
 * so a sweep that never runs degrades to a stale-looking queue — never to a
 * wrong execution. The replay half is not a backstop: if it does not run, an
 * approved irreversible action does not happen. It leaves the row `executed`
 * with no receipt, which reads as "approved, nothing happened" — visible, and
 * wrong in the safe direction. The reclaim is a backstop again, and the mildest
 * of the three: if it never runs, the stranded row stays stranded and the
 * approve path says so out loud rather than absorbing the click.
 */
import type { AgentContext, HookBus } from '@ax/core';
import { deliverResolution } from './delivery.js';
import { replayContext, settleReplay } from './replay.js';
import type { DecisionStore } from './store.js';
import type { Decision } from './types.js';
import { PLUGIN_NAME } from './pre-call.js';

/** How many due replays one pass will take on. */
export const DEFAULT_REPLAY_BATCH = 25;

/** How many due deliveries one pass will hand over. */
export const DEFAULT_DELIVERY_BATCH = 25;

/** How many stranded flights one pass will give up on. */
export const DEFAULT_RECLAIM_BATCH = 25;

/**
 * How long a replay may be in flight before we conclude nobody is flying it.
 *
 * FIFTEEN MINUTES, AND THE NUMBER IS DERIVED RATHER THAN FELT. A host replay is
 * one `bus.call('tool:execute:<name>')`, and `HookBus` wraps every service call
 * in a timeout — `DEFAULT_SERVICE_TIMEOUT_MS`, 120 s, which nothing in this repo
 * overrides for a tool executor. So a live flight cannot outlast 120 s plus the
 * two store writes around it, in this process or in any other replica: they all
 * run the same bus with the same ceiling. Fifteen minutes is that bound with an
 * order of magnitude of headroom, which is where the clock skew between two
 * hosts comparing `replay_claimed_at` against their own `now()` goes.
 *
 * IT IS NOT THE SAFETY PROPERTY, THOUGH, AND SHOULD NOT BE READ AS ONE. The
 * safety property is that the reclaim RUNS NOTHING (see
 * `reclaimStrandedFlights`): giving up on a flight that is somehow still live
 * cannot execute anything twice, because giving up executes nothing at all. The
 * cutoff exists so we do not routinely cancel authorisations out from under
 * healthy hosts, not because a wrong answer here would send an email twice.
 *
 * Erring long is therefore the safe direction, and this errs long. A row that
 * stays stranded for fifteen minutes is visible — it holds its slot, and the
 * approve path now says why — while a cutoff tight enough to race a real
 * executor would quietly cancel yeses that were about to be honoured.
 */
export const STRANDED_REPLAY_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Move every open decision past its expiry to `expired`. Returns how many
 * moved.
 *
 * A resolved row is untouched — the underlying UPDATE is conditional on the row
 * still being open, so a decision someone approved a second ago cannot be
 * expired out from under them by a sweep that read slightly stale state.
 */
export async function sweepExpired(store: DecisionStore, now: Date): Promise<number> {
  return store.expireDue(now.toISOString());
}

/**
 * Give up on every replay that has been in flight longer than we can explain,
 * and hand back the standing authorisation it was holding. Returns how many.
 *
 * NO `bus`, AND THE SIGNATURE IS THE POINT. Recovery here is never a retry: we
 * cannot know whether the crash landed before or after the tool's own side
 * effect, so re-running the call would be a coin-flip on sending it twice —
 * the one outcome worse than the stranded row itself. This function therefore
 * has no way to reach an executor even by accident, and `expiry.test.ts` pins
 * that it stays that way.
 *
 * Each reclaimed row gets a WARN line, not an info one. Nothing here is
 * routine: every row this touches is a host that died with a call on its way
 * out, and somebody may need to go and look at whether the call landed.
 */
export async function reclaimStrandedReplays(args: {
  store: DecisionStore;
  now: Date;
  limit?: number | undefined;
  timeoutMs?: number | undefined;
  logCtx: AgentContext;
}): Promise<number> {
  const { store, now, logCtx } = args;
  const timeoutMs = args.timeoutMs ?? STRANDED_REPLAY_TIMEOUT_MS;
  const reclaimed = await store.reclaimStrandedFlights({
    nowIso: now.toISOString(),
    claimedBeforeIso: new Date(now.getTime() - timeoutMs).toISOString(),
    limit: args.limit ?? DEFAULT_RECLAIM_BATCH,
  });

  for (const decision of reclaimed) {
    logCtx.logger.warn('decision_replay_abandoned', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      tool: decision.call.name,
      // WHEN the flight was taken, which is the only clue to which host died
      // and roughly when. Never `call.input` — model-authored, and an operator
      // log is not a place to echo it.
      claimedAt: decision.replayClaimedAt,
    });
  }
  return reclaimed.length;
}

/**
 * Claim and run every deferred replay whose undo window has closed.
 *
 * The claim clears `replay_due_at` in the same statement that returns the row,
 * so a second replica sweeping concurrently gets an empty list rather than a
 * duplicate send. Each replay is settled independently: one failing tool must
 * not strand the rest of the batch.
 */
export async function runDueReplays(args: {
  store: DecisionStore;
  bus: HookBus;
  now: Date;
  limit?: number | undefined;
  /** Logging context. The REPLAY itself always runs under the decision's own. */
  logCtx: AgentContext;
}): Promise<number> {
  const { store, bus, now, logCtx } = args;
  const due = await store.claimDueReplays(now.toISOString(), args.limit ?? DEFAULT_REPLAY_BATCH);

  let ran = 0;
  for (const decision of due) {
    try {
      // A ctx built for the DECISION's owner and agent, never the sweep's.
      await settleReplay({
        store,
        bus,
        ctx: replayContext(decision),
        decision,
        now: () => now,
      });
      ran += 1;
    } catch (err) {
      // `settleReplay` is already total, so reaching here means the STORE
      // failed. The row keeps whatever status it had; the next pass will not
      // pick it up (the claim already cleared `replay_due_at`), so this is
      // logged loudly rather than swallowed.
      logCtx.logger.error('decision_deferred_replay_failed', {
        plugin: PLUGIN_NAME,
        decisionId: decision.id,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
  return ran;
}

/**
 * Hand every approval whose undo window has closed to its warm agent
 * (TASK-574). Returns how many were claimed.
 *
 * WHY THIS WAITS AT ALL. Delivering at approve time meant the runner pulled
 * the `decision-resolved` entry within milliseconds and the model started
 * re-issuing its call. An Undo inside the window then put the row back to
 * `pending` — the store only refused once the call had been CONSUMED — so the
 * re-issued call met an open question and was held a second time: a second
 * "held" reply for one question, which is what the TASK-358 walk measured. An
 * Undo cannot recall an inbox entry the runner has already read, so the only
 * fix is not to send it until the Undo can no longer happen. The cost is up to
 * one undo window of latency on every attended approval, accepted by ruling.
 *
 * WHEN NOBODY IS THERE ANY MORE. The liveness read at approve time said a warm
 * agent existed; ten seconds later it may not. A delivery that does not land
 * means the agent was NOT told, and the standing yes on the row would then
 * wait for a run that may never come (TASK-277). So the host takes the replay
 * itself — and takes the FLIGHT first, as one conditional UPDATE off the same
 * columns `restore` and `takeApproval` guard, so a consuming agent or another
 * resolver that got there first wins and nothing runs. Gated on the executor
 * existing: with no executor `settleReplay` parks the row for the agent's next
 * run, and a flight taken on that side would close the row to nothing.
 *
 * Each row is settled independently: one failing delivery must not strand the
 * rest of the batch.
 */
export async function runDueDeliveries(args: {
  store: DecisionStore;
  bus: HookBus;
  now: Date;
  limit?: number | undefined;
  /** Logging context. Every bus call runs under the decision's own. */
  logCtx: AgentContext;
}): Promise<number> {
  const { store, bus, now, logCtx } = args;
  const due = await store.claimDueDeliveries(
    now.toISOString(),
    args.limit ?? DEFAULT_DELIVERY_BATCH,
  );

  for (const { decision, continuationReqId } of due) {
    try {
      const delivery = await deliverResolution({
        bus,
        ctx: logCtx,
        decision,
        outcome: 'approved',
        ...(continuationReqId !== null ? { continuationReqId } : {}),
      });
      if (delivery.delivered) continue;

      // TASK-692 — a REFUSED wake-up (a `chat:resume` gate: per-user usage
      // limits, the kill switch) lands here too, on purpose. The gate decides
      // whether the AGENT may start another turn, which is model spend; it does
      // not decide whether a call the person already said yes to may run. So the
      // agent stays parked and the host makes the approved call, exactly as it
      // does when nobody is home, and the yes is never stranded. Consequence,
      // stated rather than hidden: a paused account can still see one approval
      // through per hold that existed before it was paused (no model spend, no
      // new turn).
      logCtx.logger.warn('decision_delivery_fell_back_to_replay', {
        plugin: PLUGIN_NAME,
        decisionId: decision.id,
        reason: delivery.reason,
      });
      let flight: Decision = decision;
      if (bus.hasService(`tool:execute:${decision.call.name}`)) {
        const taken = await store.claimReplayFlight(decision.id, now.toISOString());
        if (taken === null) {
          logCtx.logger.warn('decision_replay_flight_lost', {
            plugin: PLUGIN_NAME,
            decisionId: decision.id,
          });
          continue;
        }
        flight = taken;
      }
      await settleReplay({
        store,
        bus,
        ctx: replayContext(flight),
        decision: flight,
        now: () => now,
      });
    } catch (err) {
      // `deliverResolution` and `settleReplay` are both total, so reaching here
      // means the STORE failed. The claim already stamped `delivered_at`, so no
      // later pass retries this row: logged loudly rather than swallowed. The
      // standing authorisation is still at the gate for the agent's next run.
      logCtx.logger.error('decision_deferred_delivery_failed', {
        plugin: PLUGIN_NAME,
        decisionId: decision.id,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
  return due.length;
}
