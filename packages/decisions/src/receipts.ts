/**
 * The receipt, DERIVED from the decision row.
 *
 * There is no receipt table and no receipt event. This file reads a row and
 * answers what happened, and that is the entire mechanism.
 *
 * WHY IT IS NOT AN EVENT ANY MORE. Until TASK-279 this package fired a
 * `decisions:executed` subscriber hook carrying exactly the payload below, and
 * an undo fired a fourth outcome — `retracted` — meaning "delete the row you
 * wrote for me earlier". Nothing ever subscribed, so no receipt existed and the
 * retraction landed on nothing. Adding the missing subscriber was the obvious
 * fix and the wrong one: a persisted receipt is a SECOND store for something
 * the row already describes in full (`status`, `resolvedAt`, `approvedText`,
 * `consumedAt`, `replayedAt`, `replayError`), which is invariant 4 pointing
 * straight at the answer. Deriving instead buys three things:
 *
 *   * Undo is free. `restore` writes the row back to `pending` and clears
 *     `resolvedAt`, so the derived receipt simply stops existing. No delete
 *     path, no retraction bookkeeping, and no window in which the receipt and
 *     the row disagree.
 *   * A whole defect class goes with it. An emit that runs after a conditional
 *     write LOST reports an outcome that did not happen; that was a real,
 *     filed bug on two call sites at once. There is no emit left to get wrong.
 *   * The receipt cannot lag the row. A parked decision the agent has since
 *     performed reads as performed, rather than going on promising the future
 *     because that is what the emit said at the time.
 *
 * WHAT IS NOT DERIVED, and must not be: `approvedText` is written ONTO the row
 * at hold time, from the policy rule that held the call. It is the sentence the
 * human was shown when they were asked, and re-deriving it at read time would
 * let a rule edited afterwards rewrite what somebody agreed to. The other two
 * sentences are constants for the reason `templates.ts` gives at length — a
 * constant cannot be regexed out of a different outcome's line.
 */
import { ABANDONED_RECEIPT, FAILED_RECEIPT, PENDING_AGENT_RECEIPT } from './templates.js';
import type { Decision, DecisionReceipt, DecisionStatus } from './types.js';

/**
 * The statuses a receipt can possibly come from — the COARSE half of the rule
 * `receiptFor` below states in full.
 *
 * It exists so the store can push the filter into SQL instead of fetching a
 * page of rows and throwing most of them away: a page that drops rows after
 * the LIMIT is a page that under-fills, and a feed paging through under-filled
 * pages stalls short of the history it has.
 *
 * TWO SPELLINGS OF ONE RULE, in two languages, which is the shape this package
 * already accepts elsewhere (`decisions:undo` checks the same guard the store's
 * `restore` predicate checks, deliberately). `receipts.test.ts` asserts the two
 * agree across every status, because the failure mode when they drift is
 * silent: a row that never reaches a reader looks exactly like a row that never
 * happened.
 */
export const RECEIPT_STATUSES: readonly DecisionStatus[] = [
  'executed',
  'approved-pending-agent',
  'failed',
];

/**
 * What this decision row says happened — or `null` when the honest answer is
 * "nothing yet".
 *
 * The three receipt-bearing shapes, in the order they are checked:
 *
 *   1. `failed` — the host tried the call and it did not go through. Checked
 *      FIRST so that a row carrying both a failure and a spent authorisation
 *      can never be reported as a success. Two sentences live here, and which
 *      one depends on whether the tool ever reported back: see the branch.
 *   2. The call was MADE — `replayedAt` (the host performed it) or `consumedAt`
 *      (the agent took the standing authorisation up at the gate). Both mean
 *      the same thing to a reader, so both carry the same authored line.
 *   3. `approved-pending-agent` with nothing yet spent — the host cannot make
 *      this call at all, the approval stands at the gate, and the agent will
 *      perform it on its next run. A promise about the future, and it says
 *      exactly that.
 *
 * Everything else has no receipt, and the two cases that matter are worth
 * naming: an `executed` row whose call has NOT gone out (an irreversible call
 * inside its undo window, or an attended one waiting for its warm agent) and an
 * UNDONE row, which is `pending` again. A receipt for either would be a claim
 * about something that has not happened — design H1, and in the undo case a
 * claim the person has explicitly taken back.
 *
 * `at` is `resolvedAt` and never the instant the call actually went out. One
 * value orders the feed, cuts the page, and prints on the row, so the sort key
 * and the rendered timestamp cannot disagree — and a cursor that disagrees with
 * what it paginates skips or repeats rows. The two differ by at most the undo
 * window on the one path that defers, which is ten seconds on a surface that
 * buckets by day.
 */
export function receiptFor(decision: Decision): DecisionReceipt | null {
  // The status gate comes FIRST, and it is not redundant with the checks
  // below. Without it a `dismissed` or `expired` row that somehow carried a
  // spent authorisation would read back as a success — unreachable through the
  // store's transitions today, and exactly the kind of "unreachable" that stops
  // being true when somebody adds a status. It is also the half the store's
  // query can express, so gating here keeps the two spellings identical rather
  // than merely compatible.
  if (!RECEIPT_STATUSES.includes(decision.status)) return null;

  // Nothing to file it under. A resolved row always has this; a row that
  // somehow does not is dropped rather than filed under "now", which would put
  // a months-old approval at the top of today's feed.
  const at = decision.resolvedAt;
  if (at === null) return null;

  const made = decision.replayedAt !== null || decision.consumedAt !== null;

  if (decision.status === 'failed') {
    return {
      decisionId: decision.id,
      agentId: decision.agentId,
      outcome: 'failed',
      // TWO KINDS OF `failed`, AND ONLY ONE OF THEM CAN SAY WHAT DID NOT
      // HAPPEN. An ordinary failure is a report from the executor: it threw, so
      // "nothing was completed" is something we were told. An ABANDONED row is
      // the absence of a report — the host took the flight and died inside it
      // (TASK-253), and the crash could have landed either side of the tool's
      // own side effect. Printing the ordinary line over that would send a
      // person off to redo an action that may already have happened.
      //
      // The outcome stays `failed` for both, deliberately. It is the same thing
      // to a reader deciding what to do next — this did not go through, look at
      // it — and splitting the union would make every renderer choose a
      // rendering for a case it has no different rendering for.
      receipt: decision.replayAbandonedAt !== null ? ABANDONED_RECEIPT : FAILED_RECEIPT,
      at,
      // The executor's own message, already sanitised on the way onto the row.
      // It rides BESIDE the receipt and is never the receipt: a host tool's
      // failure text can quote model-authored input back at us, and the
      // sentence a person reads as our claim about what happened has to be
      // ours.
      error: decision.replayError,
    };
  }

  if (made) {
    return {
      decisionId: decision.id,
      agentId: decision.agentId,
      outcome: 'executed',
      // The line authored when the human was asked — the only one of the three
      // that claims the thing happened.
      receipt: decision.approvedText,
      at,
      error: null,
    };
  }

  if (decision.status === 'approved-pending-agent') {
    return {
      decisionId: decision.id,
      agentId: decision.agentId,
      outcome: 'pending-agent',
      receipt: PENDING_AGENT_RECEIPT,
      at,
      error: null,
    };
  }

  return null;
}
