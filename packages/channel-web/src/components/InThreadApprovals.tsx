/**
 * The approval control on the default `/` chat surface.
 *
 * Before this, a held tool call on `/` produced prose telling the reader to
 * approve something and NOTHING TO APPROVE IT WITH — the card existed, but only
 * `/workspace` rendered it, and only behind a preview flag. Same card, same
 * queue, same routes; it just needed to be somewhere people actually are.
 *
 * It sits above the composer, next to `<PermissionCard />`, which is the shipped
 * shape for an interactive card on this surface. That is not a compromise
 * placement: `/workspace` also appends open approvals to the END of the thread
 * rather than interleaving them with the tool call that raised them.
 *
 * ONE OPEN CARD AT A TIME, and this is the part worth explaining. The composer
 * cluster is `position: fixed` at the bottom of the window and grows UPWARD.
 * Stack three full approval cards in it and the oldest one leaves the top of a
 * laptop viewport — off-screen, with no scrollbar, no edge, nothing to tell
 * anyone it is up there. An actionable decision hidden behind invisible
 * overflow is strictly worse than one that has not appeared yet. So we show the
 * oldest, say how many are behind it, and the next one arrives on its own the
 * moment this one resolves. Nothing is hidden behind an affordance a
 * first-timer has to discover.
 *
 * We also do NOT move focus here. Yanking the caret out of a half-typed message
 * because the agent got to a checkpoint is its own product decision, and not
 * one to make by accident inside a layout change.
 */
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ApprovalCard } from '@/components/workspace/ApprovalCard';
import {
  DECISION_READ_FAILED,
  DECISION_READ_FAILED_TITLE,
} from '@/components/workspace/decision-copy';
import { useConversationDecisions } from '@/lib/conversation-decisions';

export function InThreadApprovals() {
  const {
    open,
    settled,
    error,
    raised,
    busyIds,
    notices,
    approve,
    dismiss,
    undo,
    refresh,
  } = useConversationDecisions();

  /*
    A failed read is only worth putting ON SCREEN when we KNOW something is
    waiting. This fetch is ambient — it runs on every page load for every user
    on the default surface — so an error line keyed on the failure alone would,
    during an outage, put approval copy in front of thousands of people who have
    no approvals. A `decisionRaised` frame seen this page-load is the positive
    evidence, and without it the UI stays quiet.

    QUIET IN THE UI IS NOT SILENT. Every failed read is logged, evidence or no.
    Suppressing the banner is a product call about not alarming people;
    suppressing all signal would mean that on a default deployment — where
    `/workspace` and the Today queue are flag-gated off and this is the ONLY
    decision surface — a failed first read leaves the reader with prose saying
    the agent is waiting, nothing to act on, and no operator any the wiser.
    That is this card's own dead end, reborn on the error path.

    The hole this still leaves is narrower and known: with no live frame to
    corroborate it, the reader sees nothing until the next read succeeds. That
    wants a bounded retry inside `useDecisionQueue`, not a scarier line here.
  */
  const showReadFailure = error !== null && raised > 0;

  // Log each DISTINCT failure once, rather than on every re-render the clock
  // inside a card triggers.
  const loggedError = useRef<string | null>(null);
  useEffect(() => {
    if (error === null) {
      loggedError.current = null;
      return;
    }
    if (loggedError.current === error) return;
    loggedError.current = error;
    console.warn(
      '[decisions] could not read what is waiting for approval; ' +
        `the in-thread card cannot be shown (surfaced to the reader: ${
          raised > 0 ? 'yes' : 'no'
        })`,
      error,
    );
  }, [error, raised]);
  const next = open[0] ?? null;

  if (settled.length === 0 && next === null && !showReadFailure) return null;

  const cardProps = (id: string) => ({
    onApprove: () => approve(id),
    onDismiss: () => dismiss(id),
    onUndo: () => undo(id),
    busy: busyIds.has(id),
    notice: notices.get(id) ?? null,
  });

  /*
    The label has to match what the region actually holds. It renders for
    receipts alone too — a resolved row keeps its Undo for ten seconds — and
    announcing "waiting for your approval" over something already answered
    tells a screen-reader user the opposite of the truth.
  */
  const waiting = next !== null || showReadFailure;

  return (
    <div
      role="region"
      aria-label={waiting ? 'Waiting for your approval' : 'Recent approvals'}
      aria-live="polite"
      className="mb-3 flex flex-col gap-2"
    >
      {settled.map((d) => (
        <ApprovalCard key={d.id} decision={d} {...cardProps(d.id)} />
      ))}
      {open.length > 1 && (
        <div className="text-[12px] text-muted-foreground">
          {`1 of ${open.length} waiting on you`}
        </div>
      )}
      {next !== null && (
        <ApprovalCard key={next.id} decision={next} {...cardProps(next.id)} />
      )}
      {showReadFailure && (
        <Alert>
          <AlertTitle>{DECISION_READ_FAILED_TITLE}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{DECISION_READ_FAILED}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
