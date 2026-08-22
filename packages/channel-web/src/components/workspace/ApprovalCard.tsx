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
 * THE THIRD RENDERER OF ONE ROW (the queue, this, and one day Slack). Every
 * sentence about an OUTCOME comes from `decision-copy.ts`, shared with
 * `DecisionRow`, and a test renders both from one fixture and compares what
 * they say. Two components deciding separately what "approved but not yet done"
 * means is how one of them ends up saying "Sent".
 */
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { Decision } from '@/lib/workspace-api';
import { decisionOutcome, undoSecondsLeft } from './decision-copy';

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
  const outcome = decisionOutcome(d);

  if (outcome !== null) {
    // The undo window is read once, at render. This card lives inside a
    // transcript rather than a live queue, so it does not run a timer of its
    // own — the row is re-read whenever the thread is, and an expired window
    // simply comes back without the button.
    const undoLeft = undoSecondsLeft(d);
    return (
      <div
        className="flex flex-col gap-1 text-[13px] text-muted-foreground"
        data-testid={`approval-${d.id}`}
        data-status={d.status}
      >
        <div className="flex items-center gap-2">
          <span>{outcome.line}</span>
          {undoLeft > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onUndo}
              disabled={busy}
              className="h-6 gap-1.5 px-2 text-[12px] text-primary"
            >
              <RotateCcw size={10} />
              Undo · {undoLeft}s
            </Button>
          )}
        </div>
        {outcome.note !== null && <span className="text-[12px]">{outcome.note}</span>}
        {notice !== null && (
          <span className="text-[12px] text-destructive">{notice}</span>
        )}
      </div>
    );
  }

  const stale = d.status === 'stale';

  return (
    <Card
      className="max-w-[560px] border-warning/40 bg-warning-soft/40"
      data-testid={`approval-${d.id}`}
      data-status={d.status}
    >
      <CardContent className="p-4">
        <div className="text-[13.5px] font-medium">{d.summary}</div>
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
        {stale && d.staleReason && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-destructive">
            <strong className="font-medium">Nothing was sent.</strong>{' '}
            {d.staleReason} Read it again before you approve — approving now acts
            on the situation as it stands.
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
        {notice !== null && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-destructive">
            {notice}
          </p>
        )}
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onApprove} disabled={busy}>
            {stale ? `${d.primaryLabel} anyway` : d.primaryLabel}
          </Button>
          <Button size="sm" variant="secondary" onClick={onDismiss} disabled={busy}>
            {d.secondaryLabel}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss} disabled={busy}>
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
