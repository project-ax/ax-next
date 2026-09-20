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
 * let a rule edited afterwards rewrite what somebody agreed to. `dismissedText`
 * is the same kind of thing and comes off the row for the same reason. The
 * remaining sentences are constants for the reason `templates.ts` gives at
 * length — a constant cannot be regexed out of a different outcome's line.
 */
import {
  ABANDONED_RECEIPT,
  EXPIRED_RECEIPT,
  FAILED_RECEIPT,
  PENDING_AGENT_RECEIPT,
} from './templates.js';
import { DECISION_STATUSES, OPEN_STATUSES } from './types.js';
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
 * DERIVED, NOT LISTED (TASK-447). This was a hand-written allow-list of three
 * statuses, and the two it left out were `dismissed` and `expired` — the
 * outcomes where nothing ran. So Activity showed every decision the person said
 * yes to and none of the ones they turned down or let lapse, while the rail's
 * "Brought to you" counter went on counting all of them. A list of what to
 * INCLUDE fails OPEN: the row it forgets is invisible, there is nothing on the
 * surface to say a row went missing, and the next status added to the union
 * would have vanished the same silent way.
 *
 * So the rule is stated as a complement of `OPEN_STATUSES`: a decision the
 * person can still act on has no outcome to report yet, and every other one
 * does. Adding a status to the union cannot drop it from the feed — and it
 * cannot slip past `receiptFor` either, whose switch is exhaustive over
 * `DecisionStatus`, so the omission is a COMPILE error rather than a missing
 * row.
 *
 * Still COARSE, deliberately. Being in here means "this row may have something
 * to report", not "it does": an `executed` row whose call has not gone out yet
 * is a candidate that `receiptFor` still answers `null` for. The SQL filter is
 * allowed to over-select; it must never under-select.
 *
 * TWO SPELLINGS OF ONE RULE, in two languages, which is the shape this package
 * already accepts elsewhere (`decisions:undo` checks the same guard the store's
 * `restore` predicate checks, deliberately). `receipts.test.ts` asserts the two
 * agree across every status, because the failure mode when they drift is
 * silent: a row that never reaches a reader looks exactly like a row that never
 * happened.
 */
export const RECEIPT_STATUSES: readonly DecisionStatus[] = DECISION_STATUSES.filter(
  (status) => !OPEN_STATUSES.includes(status),
);

/**
 * What this decision row says happened — or `null` when the honest answer is
 * "nothing yet".
 *
 * A RECEIPT IS NOT A RECORD OF THE CALL. It is a record of the QUESTION being
 * settled, and the difference is the whole of TASK-447. For four of the five
 * outcomes below nothing was sent, nothing was moved and nothing was spent, and
 * all four still owe the person a line — "you turned this down", "it ran out of
 * time", "it tried and it failed", "it will do this next time it runs" are
 * things that happened to them. Only `executed` claims the action itself
 * occurred.
 *
 * What has no receipt is a question still OPEN: `pending` and `stale`, where
 * the person has not answered and the row is still sitting in the queue; an
 * `executed` row whose call has not gone out yet; and an UNDONE row, which undo
 * puts back to `pending` so the derived receipt simply stops existing. A line
 * for any of those would be a claim about something that has not happened —
 * design H1, and in the undo case a claim the person has explicitly taken back.
 *
 * The branches are laid out in the switch below, each with the reason it says
 * what it says. `failed` is checked before anything that reads `made`, so a row
 * carrying both a failure and a spent authorisation can never be reported as a
 * success.
 *
 * `at` is `resolvedAt` and never the instant the call actually went out. One
 * value orders the feed, cuts the page, and prints on the row, so the sort key
 * and the rendered timestamp cannot disagree — and a cursor that disagrees with
 * what it paginates skips or repeats rows. The two differ by at most the undo
 * window on the one path that defers, which is ten seconds on a surface that
 * buckets by day.
 */
export function receiptFor(decision: Decision): DecisionReceipt | null {
  // Nothing to file it under. A settled row always has this; a row that
  // somehow does not is dropped rather than filed under "now", which would put
  // a months-old approval at the top of today's feed.
  const at = decision.resolvedAt;
  if (at === null) return null;

  const made = decision.replayedAt !== null || decision.consumedAt !== null;
  const row = { decisionId: decision.id, agentId: decision.agentId, at };

  // EXHAUSTIVE over `DecisionStatus`, and that is the point. The status used to
  // be checked against a list of three and everything else fell off the end of
  // the function as `null` — so a status nobody thought about became a row
  // nobody could see. Here the compiler asks the question instead: the `never`
  // arm below stops building the moment a status has no answer.
  switch (decision.status) {
    // Still the person's to answer. `stale` is in here with `pending` because
    // the freshness guard RE-OPENS a row rather than closing it — there is no
    // outcome yet, and a receipt would be a claim about a decision still
    // sitting in the queue.
    case 'pending':
    case 'stale':
      return null;

    // Checked before anything that reads `made`, so a row carrying both a
    // failure and a spent authorisation can never be reported as a success.
    case 'failed':
      return {
        ...row,
        outcome: 'failed',
        // TWO KINDS OF `failed`, AND ONLY ONE OF THEM CAN SAY WHAT DID NOT
        // HAPPEN. An ordinary failure is a report from the executor: it threw,
        // so "nothing was completed" is something we were told. An ABANDONED
        // row is the absence of a report — the host took the flight and died
        // inside it (TASK-253), and the crash could have landed either side of
        // the tool's own side effect. Printing the ordinary line over that
        // would send a person off to redo an action that may already have
        // happened.
        //
        // The outcome stays `failed` for both, deliberately. It is the same
        // thing to a reader deciding what to do next — this did not go
        // through, look at it — and splitting the union would make every
        // renderer choose a rendering for a case it has no different rendering
        // for.
        receipt: decision.replayAbandonedAt !== null ? ABANDONED_RECEIPT : FAILED_RECEIPT,
        // The executor's own message, already sanitised on the way onto the
        // row. It rides BESIDE the receipt and is never the receipt: a host
        // tool's failure text can quote model-authored input back at us, and
        // the sentence a person reads as our claim about what happened has to
        // be ours.
        error: decision.replayError,
      };

    // The call was MADE — `replayedAt` (the host performed it) or `consumedAt`
    // (the agent took the standing authorisation up at the gate). Both mean the
    // same thing to a reader, so both carry the same authored line: the only
    // one of the receipts that claims the thing happened.
    //
    // An `executed` row whose call has NOT gone out has no receipt — an
    // irreversible call inside its undo window, or an attended one waiting for
    // its warm agent. Saying anything there would be a claim about something
    // that has not happened (design H1).
    case 'executed':
      return made
        ? { ...row, outcome: 'executed', receipt: decision.approvedText, error: null }
        : null;

    // Same line once the agent has actually taken it up. Until then the host
    // cannot make this call at all, the approval stands at the gate, and the
    // agent will perform it on its next run — a promise about the future, and
    // it says exactly that.
    case 'approved-pending-agent':
      return made
        ? { ...row, outcome: 'executed', receipt: decision.approvedText, error: null }
        : { ...row, outcome: 'pending-agent', receipt: PENDING_AGENT_RECEIPT, error: null };

    // The person said no (TASK-447). `made` is deliberately not consulted: a
    // dismissed row cannot carry a spent authorisation through any transition
    // the store allows, and if one ever did, reporting it as a success is the
    // one answer that must stay unreachable.
    //
    // The sentence is the row's own `dismissedText`, authored when they were
    // asked and written from scratch rather than regexed out of `approvedText`
    // — it states what did NOT happen, which is the claim a dismissal is
    // actually making.
    case 'dismissed':
      return { ...row, outcome: 'declined', receipt: decision.dismissedText, error: null };

    // Nobody answered in time (TASK-447). A constant, not `dismissedText`:
    // nobody turned this down, it simply ran out, and attributing a choice to
    // someone who never made one is H1 aimed at the person it misrepresents.
    case 'expired':
      return { ...row, outcome: 'expired', receipt: EXPIRED_RECEIPT, error: null };

    default: {
      // Unreachable while the switch covers the union — and a build error the
      // moment it does not. An UNDONE row never arrives here at all: undo puts
      // it back to `pending`, so its receipt stops existing on its own.
      const unhandled: never = decision.status;
      return unhandled;
    }
  }
}
