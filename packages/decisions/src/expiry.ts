/**
 * The two things that have to happen on a timer, and nothing else.
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
 * The expiry half is a BACKSTOP, not the guarantee. `approveDecision` already
 * refuses an expired row on read and `decisions:list` sweeps before it returns,
 * so a sweep that never runs degrades to a stale-looking queue — never to a
 * wrong execution. The replay half is not a backstop: if it does not run, an
 * approved irreversible action does not happen. It leaves the row `executed`
 * with no receipt, which reads as "approved, nothing happened" — visible, and
 * wrong in the safe direction.
 */
import type { AgentContext, HookBus } from '@ax/core';
import { replayContext, settleReplay } from './replay.js';
import type { DecisionStore } from './store.js';
import { PLUGIN_NAME } from './pre-call.js';

/** How many due replays one pass will take on. */
export const DEFAULT_REPLAY_BATCH = 25;

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
