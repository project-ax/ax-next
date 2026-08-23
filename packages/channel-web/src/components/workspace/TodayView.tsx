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
import { signInWithGoogle } from '@/lib/auth';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';
import type { DecisionReadError } from '@/lib/workspace-decisions';
import { isOpenDecision } from '@/lib/workspace-types';
import { DecisionRow } from './DecisionRow';
import {
  DECISION_READ_FAILED,
  DECISION_SESSION_EXPIRED,
} from './decision-copy';
import { Elapsed, StateDot } from './bits';

const WORDS = [
  'Nothing',
  'One decision',
  'Two decisions',
  'Three decisions',
  'Four decisions',
  'Five decisions',
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
  /** From the real activity feed — how many `done` rows landed today, local time. */
  doneToday?: number;
}

export function TodayView({
  decisions,
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
}: Props) {
  const readable = error === null;

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
    The headline speaks only for what we could read. While the queue is
    unreadable it says nothing about it — "Nothing is waiting on you" over a
    failed fetch is the single most damaging sentence this page could print.
  */
  const headline = !readable
    ? 'We could not check what is waiting on you.'
    : open.length === 0
      ? 'Nothing is waiting on you.'
      : `${WORDS[open.length] ?? `${open.length} decisions`} ${open.length === 1 ? 'is' : 'are'} waiting on you.`;

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
  if (open.length > 0) summary.push(`${open.length} waiting on you`);
  if (doneToday !== undefined && doneToday > 0) {
    summary.push(`${doneToday} done today`);
  }

  /*
    The hint describes an action on a row that exists. Rendered over an empty
    list it was instructions for furniture that is not there. "Line" also read
    like a phone line — these are rows.
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
          would contradict the sentence itself, and it would contradict the
          in-thread card, which draws this same line in the neutral variant.
        */
        <Alert
          variant={error.kind === 'expired' ? 'default' : 'destructive'}
          className="mb-4"
        >
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
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  /*
                    Fire-and-forget, like the LoginPage CTA: on success it
                    navigates away, and on a misconfigured provider it throws
                    with nowhere here to show why. Caught so that is a console
                    line rather than an unhandled rejection.

                    Called directly rather than through a prop: there is exactly
                    one way into this app, the in-thread card does the same, and
                    an optional `onSignIn` would be how a no-op default gets
                    added later and swallows the click.
                  */
                  void signInWithGoogle().catch((err: unknown) => {
                    console.warn('[decisions] could not start sign-in', err);
                  });
                }}
              >
                Sign in
              </Button>
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

      {/*
        The card is the list. With no list to show — the read failed and the
        alert above has already said so — an empty bordered box adds a second
        place for the eye to land and nothing for it to read there. The
        "Working" filter is unaffected: it is built from the roster, which
        loaded.
      */}
      {(readable || filter === 'working') && (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          {filter === 'needs' ? (
            <>
              {open.map((d) => renderRow(d, true))}
              {justResolved.map((d) => renderRow(d, false))}
              {readable && open.length === 0 && justResolved.length === 0 && (
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
