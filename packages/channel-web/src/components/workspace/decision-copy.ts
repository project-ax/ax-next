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
 * WORDS ONLY — the REGISTER lives in `lib/read-register.ts` (TASK-290). Which
 * variant an error alert takes, and whether it may carry a title at all, is one
 * rule shared by every surface in the app; the sentences below are deliberately
 * NOT shared, for the reason spelled out at `DECISION_THREAD_READ_FAILED`. Two
 * files because the two answers pull in opposite directions. A surface outside
 * decisions should import the register and none of this.
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
 * Above a HELD composer (TASK-275). One sentence, two surfaces: the `/`
 * composer and the `/workspace` composer render this same string, so it lives
 * here next to the other decision vocabulary instead of once per component.
 */
export const COMPOSER_HOLD_COPY =
  "We're waiting on your approval above — send is paused until you choose.";

/**
 * What a stale row leads with.
 *
 * Deliberately NOT "Nothing was sent" — the sentence this replaced. Most held
 * calls are not sends: a calendar move, a file deletion, a payment. Telling
 * someone nothing was SENT, about something that was never going to be sent,
 * is a reassurance aimed slightly past them, and on the one screen where they
 * are deciding whether to trust what we say.
 */
export const DECISION_STALE_LEAD = 'Nothing has happened yet.';
export const DECISION_STALE_ADVICE =
  'Have another look before you approve — it would act on how things are now, not how they were.';

/** The collapsed stale row, where there is room for one clause. */
export const DECISION_STALE_SUMMARY = 'Needs another look — things changed since it asked';

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

/**
 * Approved, irreversible, and the grace period has not run out yet.
 *
 * Phrased without naming the action. "About to be sent" would be right for an
 * email and wrong for a calendar move, a payment, a file deletion — and the one
 * thing this line must be is true for whatever it is sitting under.
 */
export const DECISION_GOING_OUT = 'You said yes — it is about to go ahead.';
export const DECISION_GOING_OUT_NOTE =
  'Nothing has happened yet. Undo now and it never will.';

/** The host tried the call and the tool threw. */
export const DECISION_FAILED = 'It tried to do this, and it did not work.';
export const DECISION_FAILED_NOTE =
  'Nothing was completed. Your yes does not carry over, so it will ask again if it still needs to.';

/** Nobody answered in time. */
export const DECISION_EXPIRED = 'This one ran out of time, so nothing happened.';
export const DECISION_EXPIRED_NOTE =
  'It can ask again the next time this comes up.';

/** The undo POST came back saying it changed nothing. */
export const DECISION_UNDO_TOO_LATE =
  'That had already happened, so it could not be taken back.';

/** An approve/dismiss/undo POST that never reached the server. */
export const DECISION_ACTION_FAILED =
  'We could not reach the server, so nothing changed. Try again in a moment.';

/**
 * The heading over a failed read, on the `/` chat surface.
 *
 * It leads with the fact that survives the outage — somebody is waiting on you
 * — rather than with our plumbing. The body (below) does the apologising. This
 * pair is only ever shown when a live `decisionRaised` frame says a hold really
 * does exist, so it is safe for it to state that as a fact.
 *
 * That precondition is now the general rule, not a local habit: a title needs
 * positive evidence for what it asserts, or the surface goes without one. See
 * `lib/read-register.ts`. It is why `TodayView` has no heading over the same
 * failure and why adding one would be a regression, not a tidy-up.
 */
export const DECISION_READ_FAILED_TITLE = 'Your assistant is waiting on you';

/**
 * `GET /api/workspace/decisions` failed and nothing is coming on its own right
 * now, so the offer is a button. NOT an empty queue.
 *
 * "Nothing coming" is the state, not a claim about attempts having been made —
 * this constant is shared, and there are three ways to be in it. `/workspace`
 * (`TodayView`) has no automatic retry at all, so it shows this on the FIRST
 * failure. The in-thread card shows it before there is a conversation (no
 * retry is armed then, deliberately) and again once `READ_RETRY_DELAYS_MS` is
 * spent. Only the last of those has attempts behind it, which is why the
 * sentence promises nothing about them — see `DECISION_READ_RETRYING` for the
 * one that does, and only while it is true.
 */
export const DECISION_READ_FAILED =
  'We could not load what is waiting on you. Nothing has been decided without you — we just could not read the list back right now.';

/**
 * The same failed read, while another attempt is still coming.
 *
 * "Trying again" is a claim about the code, so it may only be on screen while
 * the code is actually doing it — `useConversationDecisions` retries a failed
 * read a bounded number of times and says so through `retrying`. This sentence
 * was written for TASK-276 and deliberately NOT shipped there, because the
 * retry did not exist yet and a promise with no mechanism behind it is the
 * exact failure this epic keeps finding. It lands here, with the mechanism.
 *
 * It keeps the reassurance the other two lines carry — nothing was decided
 * while we could not see the list — because that is the fact a person actually
 * needs, and the one an unread queue puts in doubt. Shorter than
 * `DECISION_READ_FAILED` on purpose: this state resolves itself, so it is a
 * status line rather than an apology.
 */
export const DECISION_READ_RETRYING =
  'We couldn’t check what’s waiting. Trying again. Nothing has been decided without you.';

/**
 * The read was REFUSED, not failed — the session ran out (401).
 *
 * A separate pair from `DECISION_READ_FAILED` because the two need different
 * people to act. A blip is ours to retry; an expired session is nobody’s to
 * retry — the reader has to sign in again, and until they do, every retry
 * returns the same 401. Offering “try again” there is a button that cannot
 * work, which is how someone ends up clicking at a thing that will never move.
 *
 * The title claims nothing about approvals on purpose. `DECISION_READ_FAILED_TITLE`
 * says an assistant is waiting, and that is only sayable with evidence that one
 * is; this line is about the reader’s session, which the 401 IS the evidence for.
 * Registered like `ConnectorOAuthConnect`’s reconnect copy: plain, blameless,
 * one thing to do next.
 */
export const DECISION_SESSION_EXPIRED_TITLE = 'You’ve been signed out';
export const DECISION_SESSION_EXPIRED =
  'Sign in to pick up where you left off. Nothing has been decided without you.';

/**
 * The approval read behind ONE conversation failed — the notice at the foot of
 * that agent's thread.
 *
 * A separate string from `DECISION_READ_FAILED` above, and not a rewording of
 * it for variety's sake. That one is the whole-queue sentence: it stands over
 * the Today page and speaks about everything waiting on this person. This one
 * stands inside a single conversation, where the honest claim is narrower — we
 * do not know whether THIS conversation is waiting — and where the reader can
 * still go and look at Today. Sharing one string would have meant one of the
 * two surfaces overstating what it actually knows.
 *
 * Two different reads can put it on screen: the server's per-thread read, and
 * the client's queue read that carries the rows the thread's cards point at.
 * They fail differently and cost the reader the same thing, so they say the
 * same thing — a person cannot act on which fetch it was, and telling them
 * would be plumbing dressed up as information.
 */
export const DECISION_THREAD_READ_FAILED =
  'We could not check whether this conversation is waiting on you. Nothing has been decided without you — we just could not read the approvals back right now.';

/**
 * How close an expiry has to be before the row mentions it. A deadline three
 * days out is not a fact anybody needs while triaging, and a line on every row
 * is a line nobody reads.
 */
export const EXPIRY_HINT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long an open decision has left, in plain words — or `null` when saying so
 * would be noise or a guess.
 *
 * Doing nothing is a choice here, and it is the one whose consequence is
 * invisible: an expired decision cannot be approved at all, only asked again. A
 * first-timer has no way to know that from a row that just sits there.
 *
 * Returns `null` for an unparseable date and for one already past — "expires in
 * -2 hours" is worse than silence, and a row that is somehow open past its own
 * expiry is a state we should not narrate.
 */
export function expiresSoonNote(d: Decision, now: number = Date.now()): string | null {
  const at = Date.parse(d.expiresAt);
  if (Number.isNaN(at)) return null;
  const left = at - now;
  if (left <= 0 || left > EXPIRY_HINT_WINDOW_MS) return null;
  const hours = Math.round(left / 3_600_000);
  const when =
    hours < 1
      ? 'in under an hour'
      : hours === 1
        ? 'in about an hour'
        : `in about ${hours} hours`;
  return `If nobody answers, it expires ${when} and has to be asked again.`;
}

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
