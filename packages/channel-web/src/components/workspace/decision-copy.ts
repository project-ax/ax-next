/**
 * What a decision SAYS — in one place, for all three renderers.
 *
 * There is one Decision row and three things that draw it: the Today queue
 * (`DecisionRow`), the in-thread card (`ApprovalCard`), and one day Slack. If
 * each of them decided for itself what `approved-pending-agent` means, we would
 * have three answers to a question with one true answer, and only one of them
 * would ever get fixed. So the branching lives here and the components render
 * what it returns. A test draws both components from the same fixture and
 * compares the strings; that test is the reason this file exists.
 *
 * TWO KINDS OF STRING LIVE HERE, and the difference matters:
 *
 *   - `approvedText` and `dismissedText` come from the SERVER. They are
 *     authored per decision, they know what the action actually was, and they
 *     are never derived from one another. We pass them through untouched.
 *   - The constants below are OURS, and they exist for the outcomes the server
 *     has no per-decision sentence for — an approval the agent has not acted on
 *     yet, a replay that failed, a decision nobody answered in time. Every one
 *     of them is a fixed string, not a template: a receipt assembled by string
 *     surgery out of another receipt is the exact bug the honesty rules were
 *     written for (design H1), and a constant cannot be assembled out of
 *     anything.
 *
 * The one line in here that is load-bearing above all others is
 * `DECISION_PENDING_AGENT`. When the host physically cannot make the call
 * itself — a tool that only runs inside the sandbox, and the turn has ended —
 * the approval is real and it stands, but NOTHING HAS HAPPENED. That row says
 * so. It never says "Sent", and it never says "Done".
 */
import { UNDO_WINDOW_MS, type Decision } from '@/lib/workspace-types';

/** Under the buttons of an open row. The whole promise of this surface. */
export const DECISION_NOTHING_YET = 'Nothing happens until you choose';

/**
 * The approval stands; the action has not happened. Word for word the sentence
 * `@ax/decisions` puts on the Activity receipt for the same outcome — the two
 * surfaces describing one event differently is how a reader learns not to trust
 * either.
 */
export const DECISION_PENDING_AGENT =
  'Approved — it will do this the next time it runs.';
export const DECISION_PENDING_AGENT_NOTE =
  'It needs its own tools for this one, so it happens on its next run rather than now.';

/** Approved, irreversible, and the grace period has not run out yet. */
export const DECISION_GOING_OUT = 'You said yes — this is about to go out.';
export const DECISION_GOING_OUT_NOTE =
  'Nothing has left yet. Undo now and it never will.';

/** The host tried the call and the tool threw. */
export const DECISION_FAILED = 'It tried to do this, and it did not work.';
export const DECISION_FAILED_NOTE =
  'Nothing was completed, and your approval is spent — it will ask again if it still needs to.';

/** Nobody answered in time. */
export const DECISION_EXPIRED = 'This one ran out of time, so nothing happened.';
export const DECISION_EXPIRED_NOTE =
  'It can raise it again the next time it comes up.';

/** The undo POST came back saying it changed nothing. */
export const DECISION_UNDO_TOO_LATE =
  'That one had already gone out, so it could not be taken back.';

/** An approve/dismiss/undo POST that never reached the server. */
export const DECISION_ACTION_FAILED =
  'We could not reach the server, so nothing changed. Have another go?';

/** `GET /api/workspace/decisions` failed. NOT an empty queue. */
export const DECISION_READ_FAILED =
  'We could not load what is waiting on you. Nothing has been decided without you — we just could not read the list back right now.';

/**
 * How a resolved row reads.
 *
 * `null` for a row that is still open: `pending` and `stale` are questions, not
 * receipts, and the caller renders the question instead.
 */
export interface DecisionOutcome {
  /** The sentence. One line, always present. */
  line: string;
  /**
   * A quieter second line, for the states a first-timer will not expect. Null
   * where the first line already says everything — an explanation nobody needs
   * is just noise between them and the next row.
   */
  note: string | null;
  /**
   * What the row's dot means. `done` is the only value that claims the thing
   * happened, so it is used only where it did.
   */
  tone: 'done' | 'quiet' | 'bad';
}

/**
 * True while an approved action has been authorised but has NOT been performed
 * yet — an irreversible call the host deferred until the undo window closes.
 *
 * For those few seconds the status says `executed` because the AUTHORISATION is
 * final, and the row must not read as though the email went. This is the check
 * that keeps those two facts apart.
 */
export function isAboutToHappen(d: Decision, now: number = Date.now()): boolean {
  if (d.pendingUntil === null) return false;
  const at = Date.parse(d.pendingUntil);
  return !Number.isNaN(at) && at > now;
}

export function decisionOutcome(
  d: Decision,
  now: number = Date.now(),
): DecisionOutcome | null {
  switch (d.status) {
    case 'pending':
    case 'stale':
      return null;
    case 'executed':
      // The authorisation is final either way; whether the thing has HAPPENED
      // is a different question, and `pendingUntil` is the only one who knows.
      return isAboutToHappen(d, now)
        ? { line: DECISION_GOING_OUT, note: DECISION_GOING_OUT_NOTE, tone: 'quiet' }
        : { line: d.approvedText, note: null, tone: 'done' };
    case 'approved-pending-agent':
      return {
        line: DECISION_PENDING_AGENT,
        note: DECISION_PENDING_AGENT_NOTE,
        tone: 'quiet',
      };
    case 'dismissed':
      return { line: d.dismissedText, note: null, tone: 'quiet' };
    case 'failed':
      return { line: DECISION_FAILED, note: DECISION_FAILED_NOTE, tone: 'bad' };
    case 'expired':
      return { line: DECISION_EXPIRED, note: DECISION_EXPIRED_NOTE, tone: 'quiet' };
  }
}

/**
 * Whole seconds of undo left, or 0 when the affordance must not be shown.
 *
 * Two gates, and both have to pass:
 *
 *   1. `d.undoable` — the SERVER's answer to "can this still be taken back at
 *      all". False the moment the call has actually been made, whoever made it.
 *   2. the clock — `UNDO_WINDOW_MS` from the server's `resolvedAt`.
 *
 * The first gate is the one that matters. Offering "Undo" on an action that has
 * already gone out is not a small cosmetic slip: it is a control that promises
 * to unsend an email and cannot, and a person who clicks it walks away believing
 * something that is not true.
 */
export function undoSecondsLeft(d: Decision, now: number = Date.now()): number {
  if (!d.undoable || d.resolvedAt === null) return 0;
  const resolved = Date.parse(d.resolvedAt);
  if (Number.isNaN(resolved)) return 0;
  const left = UNDO_WINDOW_MS - (now - resolved);
  return left <= 0 ? 0 : Math.ceil(left / 1000);
}
