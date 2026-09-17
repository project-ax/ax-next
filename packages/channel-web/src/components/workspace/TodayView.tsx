/**
 * Today — the queue of things waiting on a human, and nothing else.
 *
 * Four deliberate properties:
 *
 *   1. The headline is TEMPLATED FROM COUNTS, never generated prose. "Nothing
 *      has gone wrong" being wrong once ends the relationship, so the only
 *      claims made here are ones derived directly from rows that were counted.
 *
 *   2. There is no "Done" filter. Done was a third renderer over the same event
 *      stream that Activity already owns; the reassurance it carried lives in
 *      the sub-line instead, and the footer links to the real feed.
 *
 *   3. Nothing here is a fixture. The rows are real `@ax/decisions` rows served
 *      by `GET /api/workspace/decisions`, and acting on one posts to the host.
 *
 *   4. AN EMPTY QUEUE IS A CLAIM — the most reassuring one this product makes.
 *      It may only be rendered when we actually READ the queue. A failed read
 *      shows the failure, not "nothing is waiting on you"; those two look
 *      identical from the outside and mean opposite things (design H7).
 */
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SignInAgainButton } from '@/components/SignInAgainButton';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';
import type { DecisionReadError } from '@/lib/workspace-decisions';
import { readAlertVariant } from '@/lib/read-register';
import { isOpenDecision } from '@/lib/workspace-types';
import { DecisionRow } from './DecisionRow';
import { GrantRow } from './GrantRow';
import {
  DECISION_READ_FAILED,
  DECISION_SESSION_EXPIRED,
  GRANT_READ_FAILED,
} from './decision-copy';
import { Elapsed, StateDot } from './bits';
import type { WorkspaceGrant } from '@/lib/workspace-grant-store';

/*
  The heading's job is a COUNT, not a taxonomy — the rows below say what each
  thing is.

  These read "One decision"… until TASK-350, which put capability grants in the
  same queue. A grant is deliberately NOT a decision (2026-09-12: a grant is
  durable and agent-scoped with no recorded call; a decision is a one-shot
  outward action with a verbatim call and a freshness guard — two types, two
  rows, one list), so the old wording made the heading lie about a third of what
  it was counting. An over-specific heading that is sometimes false is worse
  than a general one that is always true, and the zero case already carried no
  noun, so the whole set is nounless now.
*/
const WORDS = [
  'Nothing',
  'One thing',
  'Two things',
  'Three things',
  'Four things',
  'Five things',
];

/**
 * How long a row that has just been resolved stays on screen under the queue.
 *
 * Long enough that the receipt lands where the person was looking — and, for
 * the ten seconds that matter, that Undo is still under their cursor rather
 * than somewhere in the Activity feed.
 */
const JUST_RESOLVED_MS = 60_000;

interface Props {
  decisions: Decision[];
  /**
   * Open capability grants (TASK-350). A separate array from `decisions`
   * because they are a separate type with a separate lifecycle — they arrive on
   * the turn stream rather than through the decisions fetch, and nothing
   * persists them. They render in the same list and count toward the same
   * heading, which is the whole point: one queue of things waiting on a person.
   */
  grants: readonly WorkspaceGrant[];
  /** A grant was answered or turned down. */
  onGrantResolved: (key: string) => void;
  /**
   * A grant was APPROVED — pick the stopped agent back up (TASK-374). Passed
   * straight to `GrantRow`, which owns the difference between approving and
   * turning down; see there for why the seam is on the row and not here.
   */
  onGranted: (grant: WorkspaceGrant) => Promise<boolean>;
  agents: WorkspaceAgent[];
  filter: 'needs' | 'working';
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  onOpenAgent: (id: string) => void;
  /**
   * The three ways out of a decision. REQUIRED — the routes behind them ship in
   * the same change as the rows themselves, so there is no longer a state where
   * a decision is on screen with nothing able to resolve it. Deliberately not
   * optional-with-a-no-op-default: a button that swallows a click is worse than
   * a button that is not there, and an optional handler is how the no-op default
   * gets added later without anyone noticing.
   */
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  onUndo: (id: string) => void;
  /** Rows with a POST in flight. Their controls go quiet, not absent. */
  busyIds?: ReadonlySet<string>;
  /** Per-row line from an action that failed or was refused. */
  notices?: ReadonlyMap<string, string>;
  /**
   * Non-null means we do not have the QUEUE. Never rendered as an empty queue,
   * and `kind` picks which of two sentences — and which button — the reader
   * gets. Not a string: a raw thrown message used to be printed on this page
   * verbatim, which is how "workspace /decisions → 401" ended up being copy.
   */
  error?: DecisionReadError | null;
  /** True while the first read is still in flight — not the same as empty. */
  loading?: boolean;
  onRetry?: () => void;
  onSeeActivity: () => void;
  /**
   * From the real activity feed — how many `done` rows landed today, local
   * time. `undefined` when the pages the shell holds cannot back that number
   * (see `doneTodayFrom` in `WorkspaceShell`); the line is then simply absent,
   * never a zero standing in for "we did not look far enough".
   */
  doneToday?: number;
  /**
   * How the pending-grants read-back went (TASK-373). `null` = read fine (or
   * not attempted); `'failed'` = blip, retryable; `'expired'` = 401, the
   * session ran out and no retry can work.
   *
   * TASK-350 could say grants "are never unreadable — they arrive on the turn
   * stream rather than through a fetch that can fail". The read-back broke
   * that premise, so the headline may no longer count an empty grants array
   * as an empty day: when this is non-null and nothing else is waiting, the
   * page says it could not check rather than saying nobody needs you (H7).
   */
  grantsError?: 'expired' | 'failed' | null;
  /** Re-read the grants. Only offered on the retryable branch. */
  onRetryGrants?: () => void;
}

export function TodayView({
  decisions,
  grants,
  onGrantResolved,
  onGranted,
  agents,
  filter,
  expandedId,
  onExpand,
  onOpenAgent,
  onApprove,
  onDismiss,
  onUndo,
  busyIds,
  notices,
  error = null,
  loading = false,
  onRetry,
  onSeeActivity,
  doneToday,
  grantsError = null,
  onRetryGrants,
}: Props) {
  const readable = error === null;
  const grantsUnknown = grantsError !== null;

  const open = readable ? decisions.filter(isOpenDecision) : [];
  /*
    A row resolved a moment ago stays put and turns into its own receipt. It is
    also the only place the ten-second Undo lives, so it must not disappear the
    instant the status changes.
  */
  const justResolved = readable
    ? decisions.filter(
        (d) =>
          !isOpenDecision(d) &&
          d.resolvedAt !== null &&
          Date.now() - Date.parse(d.resolvedAt) < JUST_RESOLVED_MS,
      )
    : [];
  const working = agents.filter((a) => a.state === 'working');
  /*
    Grants are counted with the decisions, not beside them. They are in the same
    list and they ask the same thing of the person, so a heading that counted
    only one of them would be wrong in the ordinary case where both are open.

    TASK-373 — the second half of the old note here is gone: grants DO arrive
    through a fetch that can fail now, so an empty `grants` array is no longer
    evidence that no grant is waiting. What keeps the page honest is the
    headline gate below (never the empty sentence over an unchecked read) and
    the alert the shell renders when the read failed. When something IS
    readable and waiting, the count stands as a floor: true even if the grants
    read knows nothing.
  */
  const waiting = open.length + grants.length;

  /*
    The headline speaks only for what we could read. While the queue is
    unreadable it says nothing about it — "Nothing is waiting on you" over a
    failed fetch is the single most damaging sentence this page could print.
    The grants read-back is the second way to not know, and the empty sentence
    is exactly as false over it.
  */
  const headline =
    !readable || (waiting === 0 && grantsUnknown)
      ? 'We could not check what is waiting on you.'
      : waiting === 0
        ? 'Nothing is waiting on you.'
        : `${WORDS[waiting] ?? `${waiting} things`} ${waiting === 1 ? 'is' : 'are'} waiting on you.`;

  /*
    A COUNT IS ONLY RENDERED WHEN IT IS POSITIVE.

    This line used to read "0 agents working · 0 waiting on you" beside a green
    tick whenever the workspace was quiet — a reassuring report on a system we
    had not measured. `working` is derived from `session:is-alive`, and when
    that service is not registered every agent reads `resting`, so the zero is
    not even "nothing is happening": it is "we did not look". A zero is a
    claim; an absent line is the truth.
  */
  const summary: string[] = [];
  if (working.length > 0) {
    summary.push(
      `${working.length} ${working.length === 1 ? 'agent' : 'agents'} working`,
    );
  }
  if (waiting > 0) summary.push(`${waiting} waiting on you`);
  if (doneToday !== undefined && doneToday > 0) {
    summary.push(`${doneToday} done today`);
  }

  /*
    The hint describes an action on a row that exists. Rendered over an empty
    list it was instructions for furniture that is not there. "Line" also read
    like a phone line — these are rows.
  */
  /*
    Keyed on decisions, not on `waiting`. The sentence is about opening a row to
    see its detail, and only a decision row expands — a grant is already open
    and has its buttons on show. Counting grants here printed "Open a row…" over
    a queue with no expandable row in it, and (before the gate above was fixed)
    over no visible rows at all.
  */
  const hint =
    filter === 'needs'
      ? open.length > 0
        ? 'Open a row to see the detail and act on it.'
        : null
      : working.length > 0
        ? 'Read-only — nothing here asks anything of you.'
        : null;

  const agentFor = (id: string) => agents.find((a) => a.id === id);

  const renderRow = (d: Decision, expandable: boolean) => {
    const agent = agentFor(d.agentId);
    /*
      A decision whose agent is not in the roster has nowhere to be shown — the
      row is built around the agent's name and the link to it. It is dropped
      rather than rendered nameless, and it cannot silently be the only thing in
      the queue: the server ACLs the list against the same roster, so the two
      agree by construction.
    */
    if (!agent) return null;
    return (
      <DecisionRow
        key={d.id}
        decision={d}
        agent={agent}
        expanded={expandable && expandedId === d.id}
        onToggle={() => {
          if (expandable) onExpand(expandedId === d.id ? null : d.id);
        }}
        onOpenAgent={() => onOpenAgent(d.agentId)}
        onApprove={() => onApprove(d.id)}
        onDismiss={() => onDismiss(d.id)}
        onUndo={() => onUndo(d.id)}
        busy={busyIds?.has(d.id) === true}
        notice={notices?.get(d.id) ?? null}
      />
    );
  };

  return (
    <div className="mx-auto w-full max-w-[900px] px-6 py-6">
      <div className="mb-6 flex flex-col gap-2.5">
        <h1 className="max-w-[620px] text-[21px] font-medium leading-snug tracking-[-0.02em] text-pretty">
          {headline}
        </h1>
        {readable && summary.length > 0 && (
          <div className="flex items-center gap-2.5 text-[13.5px] text-muted-foreground">
            <CheckCircle2 size={14} className="shrink-0 text-primary" />
            <span>{summary.join(' · ')}</span>
          </div>
        )}
      </div>

      {error !== null && (
        /*
          THE REGISTER FOLLOWS THE FACT. `destructive` is the red one and it
          says "something has gone wrong" — true of a blip, and not true of a
          session that simply ran out. Sitting the signed-out sentence in red
          would contradict the sentence itself.

          The branch this comment used to spell out inline now lives in
          `readAlertVariant` (TASK-290), unchanged in behaviour: this page has
          no automatic retry, so it passes no `retrying` and a blip is terminal
          until the reader clicks — `destructive`. The clause about the
          in-thread card came off: that card draws a SPENT retry budget red now
          too, for the same reason this one does, and it stays neutral only
          while an attempt is genuinely still coming — a state this page is
          never in.
        */
        <Alert variant={readAlertVariant(error.kind)} className="mb-4">
          <AlertDescription className="flex flex-col items-start gap-2.5">
            {/*
              NOTHING RAW IS RENDERED HERE ANY MORE.

              This box used to end with `{error}` — the thrown message, in mono,
              verbatim. On a 401 that read "workspace /decisions → 401" to a
              person, which is a request path and a status code standing in for
              a sentence, on the one screen whose own comment already forbade
              exactly that. The message now goes to a `console.warn` (see
              `InThreadApprovals`) and the reader gets authored copy instead.

              Two branches, because the two need different people to act. A blip
              is ours to retry. An expired session is not retryable at all —
              every retry returns the same 401 — so the offer is to sign in.
            */}
            <span className="text-[13px] leading-relaxed">
              {error.kind === 'expired'
                ? DECISION_SESSION_EXPIRED
                : DECISION_READ_FAILED}
            </span>
            {error.kind === 'expired' ? (
              /*
                A console line was all a failed sign-in used to produce, on the
                one screen where this is the only way forward (TASK-288). The
                shared button owns the failure now.

                Rendered directly rather than through an `onSignIn` prop: there
                is exactly one way into this app, the in-thread card uses the
                same component, and an optional prop would be how a no-op
                default gets added later and swallows the click.
              */
              <SignInAgainButton variant="secondary" />
            ) : (
              onRetry && (
                <Button variant="secondary" size="sm" onClick={onRetry}>
                  Try again
                </Button>
              )
            )}
          </AlertDescription>
        </Alert>
      )}

      {grantsError !== null && (
        /*
          The pending-grants read-back failed (TASK-373). A SECOND alert, not a
          branch inside the one above, on purpose: the decisions list and the
          grants list are two fetches of two collections, either can fail alone,
          and one sentence covering both would have to say "we could not check"
          about a list that DID come back. Each alert names its own fact and its
          own retry — a Try again that re-runs the fetch that failed, never a
          decoration on a button that cannot work.

          Same two-branch shape as the queue alert, for the same reason: a 401
          is the session running out, and every retry returns the same 401, so
          the offer there is sign-in rather than a button that cannot move.
        */
        <Alert variant={readAlertVariant(grantsError)} className="mb-4">
          <AlertDescription className="flex flex-col items-start gap-2.5">
            <span className="text-[13px] leading-relaxed">
              {grantsError === 'expired'
                ? DECISION_SESSION_EXPIRED
                : GRANT_READ_FAILED}
            </span>
            {grantsError === 'expired' ? (
              <SignInAgainButton variant="secondary" />
            ) : (
              onRetryGrants && (
                <Button variant="secondary" size="sm" onClick={onRetryGrants}>
                  Try again
                </Button>
              )
            )}
          </AlertDescription>
        </Alert>
      )}

      {/*
        The card is the list. With no list to show — the read failed and the
        alert above has already said so — an empty bordered box adds a second
        place for the eye to land and nothing for it to read there. The
        "Working" filter is unaffected: it is built from the roster, which
        loaded.

        GRANTS SURVIVE AN UNREADABLE QUEUE. The decisions read and the grants
        read are separate — a failure of one says nothing about the other — so
        hiding a row we did read would re-create the exact dead-end this card
        removes: an agent stopped at the wall, a person who cannot answer, and
        a turn that goes nowhere, triggered by an unrelated failure on a
        different route. When the GRANTS read itself is the one that failed,
        the alert above says so; the headline refuses the empty sentence, and
        this list simply shows whatever rows we do have.
      */}
      {(readable || filter === 'working' || (filter === 'needs' && grants.length > 0)) && (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          {filter === 'needs' ? (
            <>
              {/*
                Grants sit above the decisions. A held action is waiting; an
                agent that hit the wall is STOPPED until this is answered, so it
                is the more urgent of the two and goes where the eye lands
                first. They are also the rows most likely to be unfamiliar, and
                burying an unfamiliar row under familiar ones is how it goes
                unread.
              */}
              {grants.map((g) => (
                <GrantRow
                  key={g.key}
                  grant={g}
                  onResolved={onGrantResolved}
                  onGranted={onGranted}
                />
              ))}
              {open.map((d) => renderRow(d, true))}
              {justResolved.map((d) => renderRow(d, false))}
              {readable &&
                open.length === 0 &&
                justResolved.length === 0 &&
                grants.length === 0 && (
                /*
                  The headline already said the queue is empty. Saying it again
                  two inches lower tells a first-timer nothing; what they do not
                  know is what this list is FOR, and this is the one moment they
                  have the attention to read it.

                  Held back while the FIRST read is still in flight: "nothing is
                  waiting" flashing up before the rows arrive is the same claim,
                  just briefer.
                */
                <div className="px-5 py-10 text-center text-[13.5px] text-muted-foreground">
                  {loading
                    ? 'Checking what is waiting on you…'
                    : 'When an agent hits something it wants your OK on, it’ll wait for you here.'}
                  </div>
                )}
            </>
          ) : working.length === 0 ? (
            <div className="px-5 py-10 text-center text-[13.5px] text-muted-foreground">
              Nobody is mid-task right now.
            </div>
          ) : (
            working.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onOpenAgent(a.id)}
                className="flex w-full items-center gap-3 border-b border-rule-soft px-5 py-3.5 text-left last:border-b-0"
              >
                <StateDot state="working" />
                <span className="shrink-0 text-[13px] font-medium">{a.name}</span>
                {/*
                  `now` is null until something real produces the activity line
                  (AW-8/AW-14). The name and the state dot already say "working";
                  a placeholder phrase here would read as a report.
                */}
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">
                  {a.now ?? ''}
                </span>
                <span className="shrink-0 text-[12.5px] text-muted-foreground">
                  {a.counter
                    ? `${a.counter.done} of ${a.counter.total} ${a.counter.unit}`
                    : ''}
                </span>
                <span className="shrink-0 text-[12.5px] text-muted-foreground">
                  <Elapsed since={a.startedAt} />
                </span>
              </button>
            ))
          )}
        </div>
      )}

      <div className="flex items-center gap-3 px-1 pt-3.5 text-[12.5px] text-muted-foreground">
        {hint !== null && <span>{hint}</span>}
        <Button
          variant="ghost"
          size="sm"
          onClick={onSeeActivity}
          className="ml-auto h-7 gap-1.5 text-[12px] text-primary"
        >
          Everything they did
          <ArrowRight size={11} />
        </Button>
      </div>
    </div>
  );
}
