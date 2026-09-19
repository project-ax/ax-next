/**
 * The in-thread approval — the attended half of the model.
 *
 * Same Decision row the Today queue renders; different disposition. Because the
 * conversation is attended, the agent is still parked on `session.next-message`
 * and will execute the call itself the moment this resolves. Nothing re-spawns,
 * nothing is replayed, and the world cannot have moved meaningfully in the
 * seconds involved — which is why this card carries no freshness guard while
 * the queue version does.
 *
 * If the human walks away instead, the reaper ends the turn and this exact
 * decision is waiting in Today. Same row, degraded path.
 *
 * IT RENDERS ON BOTH SURFACES (TASK-261). `/workspace` draws it inside the
 * thread; the default `/` chat surface draws it above the composer via
 * `<InThreadApprovals>`. One component, one queue, one set of controls — a
 * second, reduced renderer on the surface most people actually use is exactly
 * the fork this card exists to avoid.
 *
 * THE THIRD RENDERER OF ONE ROW (the queue, this, and one day Slack). Every
 * sentence about an OUTCOME comes from `decision-copy.ts`, shared with
 * `DecisionRow`, and a test renders both from one fixture and compares what
 * they say. Two components deciding separately what "approved but not yet done"
 * means is how one of them ends up saying "Sent".
 *
 * IT MOVES FOCUS ONTO ITS OWN ANSWER (TASK-427). The controls are replaced by
 * the receipt, so without this the browser drops focus on `<body>` and the
 * ten-second Undo in that receipt is ten blind Tabs away. `lib/consent-focus.ts`
 * carries the argument for landing on the outcome line rather than on Undo
 * itself.
 */
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  RESOLUTION_FOCUS_RING,
  useResolutionFocus,
} from '@/lib/consent-focus';
import type { Decision } from '@/lib/workspace-api';
import {
  DECISION_STALE_ADVICE,
  DECISION_STALE_LEAD,
  decisionOutcome,
  undoSecondsLeft,
} from './decision-copy';
import { useDecisionClock } from './use-decision-clock';

interface Props {
  decision: Decision;
  onApprove: () => void;
  onDismiss: () => void;
  onUndo: () => void;
  /** A POST is in flight for this row: controls go quiet, never absent. */
  busy?: boolean;
  /** What the last action came back with, when it was not what was asked for. */
  notice?: string | null;
}

export function ApprovalCard({
  decision: d,
  onApprove,
  onDismiss,
  onUndo,
  busy = false,
  notice = null,
}: Props) {
  // Same clock the queue row uses. The card sits in a transcript rather than a
  // live list, but the two claims it makes are the same two — how long undo has
  // left, and whether a deferred action has gone ahead — and a card that only
  // re-read them when the thread was refetched would sit there offering an undo
  // the server would refuse.
  const now = useDecisionClock(d);
  const outcome = decisionOutcome(d, now);
  const stale = d.status === 'stale';
  /*
    Focus follows whatever the card says back. THREE things can be that answer,
    and the third is the one that is easy to miss: approving a row whose
    freshness guard trips does not resolve it — the machine hands back a row
    that is still `pending`-shaped, `status: 'stale'`, and the card RE-OPENS as
    a question with a new sentence at the top of it. No receipt, no notice, and
    on the primary action of a consent surface. Without it in here the person
    is on `<body>` in front of a page that looks like nothing happened.

    Ordered to match document order below, because when two of these are on
    screen at once the last one mounted owns the ref.
  */
  const answerKey =
    /*
      NOTICE FIRST, and this order is load-bearing. A REFUSED undo
      (`DECISION_UNDO_TOO_LATE` — the window shut between the click and the
      server) is the one case where a notice lands on a row that is already
      RESOLVED: the outcome stays exactly as it was, so an outcome-first key
      never changes, nothing fires, and the person is on `<body>` while a red
      line they cannot see says the thing cannot be taken back after all. The
      freshest thing the card has to say always wins — and the nodes below are
      hung in the same order, because the last `answerRef` in document order
      is the one that gets it.
    */
    notice !== null
      ? `notice:${notice}`
      : outcome !== null
        ? `outcome:${d.status}:${d.resolvedAt ?? ''}`
        : stale && d.staleReason !== null
          ? `stale:${d.freshness?.value ?? ''}:${d.staleReason}`
          : // Back to being a QUESTION. Undo inside the window returns the row
            // to `pending` (`decisions/machine.ts`), so the receipt and its
            // Undo button both unmount and there is nothing left in the card
            // that was ever a resolution. Landing on the question is the
            // honest answer: we are asking again, and this says so.
            `open:${d.status}:${d.resolvedAt ?? ''}`;
  const { answerRef, armForResolution } = useResolutionFocus(answerKey);

  if (outcome !== null) {
    const undoLeft = undoSecondsLeft(d, now);
    return (
      <div
        className="flex flex-col gap-1 text-[13px] text-muted-foreground"
        data-testid={`approval-${d.id}`}
        data-status={d.status}
      >
        {/*
          THE FOCUS TARGET, and the reason Undo lives inside it rather than
          beside it: the first tabbable thing after this node has to BE Undo,
          or the ten-second window is not one Tab away and the landing is
          decoration. `tabIndex={-1}` keeps it out of everyone else's Tab
          order — it is a destination, not a stop.
        */}
        <div
          ref={answerRef}
          tabIndex={-1}
          data-testid={`approval-outcome-${d.id}`}
          className={`flex items-center gap-2 ${RESOLUTION_FOCUS_RING}`}
        >
          <span>{outcome.line}</span>
          {undoLeft > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                armForResolution();
                onUndo();
              }}
              disabled={busy}
              className="h-6 gap-1.5 px-2 text-[12px] text-primary"
            >
              <RotateCcw size={10} />
              Undo · {undoLeft}s
            </Button>
          )}
        </div>
        {outcome.note !== null && <span className="text-[12px]">{outcome.note}</span>}
        {/*
          A REFUSED UNDO lands here (TASK-427): the row is still resolved, the
          Undo button has gone, and this line is the only thing that changed.
          Last among this branch's `answerRef` holders, so it wins the ref over
          the outcome line above — which is what the notice-first key asks for.
        */}
        {notice !== null && (
          <span
            ref={answerRef}
            tabIndex={-1}
            className={`text-[12px] text-destructive ${RESOLUTION_FOCUS_RING}`}
          >
            {notice}
          </span>
        )}
      </div>
    );
  }

  return (
    <Card
      className="max-w-[560px] border-warning/40 bg-warning-soft/40"
      data-testid={`approval-${d.id}`}
      data-status={d.status}
    >
      <CardContent className="p-4">
        {/*
          THE QUESTION, and therefore a focus target (TASK-427). Undo re-opens
          this card, which unmounts the receipt the person was standing on — so
          this is where they land, hearing the question they are being asked
          again. It is FIRST in document order among the nodes that share
          `answerRef`, so a stale reason or a notice below it takes precedence,
          which is the same order `answerKey` is built in.
        */}
        <div
          ref={answerRef}
          tabIndex={-1}
          data-testid={`approval-question-${d.id}`}
          className={`text-[13.5px] font-medium ${RESOLUTION_FOCUS_RING}`}
        >
          {d.summary}
        </div>
        {/*
          The paragraph is shown OUTRIGHT here, where the queue row hides it
          behind a disclosure. The queue is a list to triage; this is a
          conversation the reader is already inside, and there is nothing below
          it competing for the space.

          It is also what lets this card drop the secondary button. `secondaryLabel`
          is "Show me the details" — in the queue that opens the agent, and there
          is nowhere for it to go from inside the thread. The version this
          replaced wired it to DISMISS, so a person asking to see more would have
          turned the request down instead. A control that does something other
          than what it says is worse than no control, so the details are simply
          here and the button is gone.
        */}
        {d.detail.length > 0 && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            {d.detail}
          </p>
        )}
        {/*
          A stale card in a live thread is rare — the agent is warm and the
          world has had seconds, not hours, to move — but "rare" is not "never",
          and a card that quietly acted on the new situation would be the worst
          version of this surface. Same sentence the queue row leads with.
        */}
        {/*
          A FOCUS TARGET, because this is an ANSWER (TASK-427). Approving a row
          the guard trips re-opens it rather than resolving it, so there is no
          receipt to land on and the controls the person was standing in are
          still here — just re-worded. Focusing it is also what gets it read
          out: unlike the queue row's version this is a plain paragraph rather
          than an `Alert`, matching the compact in-thread treatment the rest of
          this card uses, so nothing announces it on its own.
        */}
        {stale && d.staleReason && (
          <p
            ref={answerRef}
            tabIndex={-1}
            className={`mt-2 text-[12.5px] leading-relaxed text-destructive ${RESOLUTION_FOCUS_RING}`}
          >
            <strong className="font-medium">{DECISION_STALE_LEAD}</strong>{' '}
            {d.staleReason} {DECISION_STALE_ADVICE}
          </p>
        )}
        {d.preview && (
          <div className="mt-3 rounded-md bg-background/70 px-3.5 py-3">
            <div className="mb-1.5 text-[11.5px] text-muted-foreground">
              {d.preview.meta}
            </div>
            <div className="text-[13px] leading-relaxed">{d.preview.body}</div>
          </div>
        )}
        {/*
          The row stayed open because the resolve did not land. Focus comes
          here for the same reason it goes to the receipt: the person pressed
          something, and this is the answer. Without it they are on `<body>`
          with an unread error behind them — the same bug, minus the receipt.
        */}
        {notice !== null && (
          <p
            ref={answerRef}
            tabIndex={-1}
            className={`mt-3 text-[12.5px] leading-relaxed text-destructive ${RESOLUTION_FOCUS_RING}`}
          >
            {notice}
          </p>
        )}
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              armForResolution();
              onApprove();
            }}
            disabled={busy}
          >
            {stale ? `${d.primaryLabel} anyway` : d.primaryLabel}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              armForResolution();
              onDismiss();
            }}
            disabled={busy}
          >
            {d.ghostLabel}
          </Button>
        </div>
        <p className="mt-2.5 text-[11.5px] text-muted-foreground">
          {busy
            ? 'Working on it…'
            : 'Nothing is sent until you choose. I am holding here, so we can carry straight on.'}
        </p>
      </CardContent>
    </Card>
  );
}
