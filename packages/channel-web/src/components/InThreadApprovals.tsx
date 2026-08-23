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
  DECISION_READ_RETRYING,
  DECISION_SESSION_EXPIRED,
  DECISION_SESSION_EXPIRED_TITLE,
} from '@/components/workspace/decision-copy';
import { useConversationDecisions } from '@/lib/conversation-decisions';
import { SignInAgainButton } from '@/components/SignInAgainButton';

export function InThreadApprovals() {
  const {
    open,
    settled,
    error,
    retrying,
    raised,
    busyIds,
    notices,
    approve,
    dismiss,
    undo,
    refresh,
  } = useConversationDecisions();

  /*
    A FAILED read is only worth putting ON SCREEN when we KNOW something is
    waiting. This fetch is ambient — it runs on every page load for every user
    on the default surface — so an error line keyed on the failure alone would,
    during an outage, put approval copy in front of thousands of people who have
    no approvals. A `decisionRaised` frame seen this page-load is the positive
    evidence, and without it the UI stays quiet.

    QUIET IN THE UI IS NOT SILENT. Every unreadable queue is logged, evidence or
    no. Suppressing the banner is a product call about not alarming people;
    suppressing all signal would mean that on a default deployment — where
    `/workspace` and the Today queue are flag-gated off and this is the ONLY
    decision surface — a failed first read leaves the reader with prose saying
    the agent is waiting, nothing to act on, and no operator any the wiser.
    That is this card's own dead end, reborn on the error path.

    THE NEXT READ NOW COMES ON ITS OWN (TASK-274). A failed read used to be
    terminal — nothing here polls, so the list was re-read only when a frame
    landed, the thread changed, or somebody clicked — which meant a blip while a
    hold was open hid the card until the reader happened to act, and they had no
    reason to. `useConversationDecisions` now retries it a bounded number of
    times (`READ_RETRY_DELAYS_MS`), and `retrying` is how this box knows whether
    another attempt is genuinely coming before it says one is.

    That belongs there, not in `useDecisionQueue`: it is gated on a
    known conversation, because until there is one this surface has nothing to
    show whatever the queue says.

    None of which changes the gate above. The retry can only fill the queue in
    or fail again; it never makes an approval claim, so it is not evidence, and
    a person with no approvals still sees nothing during an outage.

    AN EXPIRED SESSION IS NOT GATED, and that is deliberate. The gate above
    exists to stop us making an APPROVAL claim we have no evidence for. The
    expired line makes no such claim — it reports the reader's own session, and
    the 401 is direct evidence of exactly that (the route answers 401 from
    `authOr401` alone, i.e. `auth:require-user` rejected). Withholding a true,
    actionable, per-person fact because it arrived down the same pipe as an
    outage is the conflation this card exists to undo.

    IT IS NO LONGER THE WHOLE STORY, THOUGH. TASK-288 added the app-wide rule
    this comment used to say did not exist: `lib/http.ts` latches any post-boot
    401 and `App.tsx` renders `<LoginPage />`. So in practice the same 401 that
    fills in the line below is also, within a render or two, replacing this
    entire screen. The line is kept anyway — it is correct on its own terms, it
    is what a reader sees if the decisions read is the only thing 401-ing, and
    a surface that speaks accurately for the read it made does not become wrong
    because something above it also acted.
  */
  const showExpired = error?.kind === 'expired';
  const showReadFailure = error?.kind === 'failed' && raised > 0;

  // Log each DISTINCT failure once, rather than on every re-render the clock
  // inside a card triggers. Keyed on kind AND detail, because the state holds a
  // fresh object per read: comparing the objects would log every failed poll.
  const loggedError = useRef<string | null>(null);
  useEffect(() => {
    if (error === null) {
      loggedError.current = null;
      return;
    }
    const key = `${error.kind}:${error.detail}`;
    if (loggedError.current === key) return;
    loggedError.current = key;
    // Two facts, two sentences. An operator reading "could not read" for a 401
    // goes looking for a broken route; there isn't one — the caller is signed
    // out, and that is a different morning entirely.
    //
    // No note about whether the banner is up: the dedup key is the failure, so
    // an annotation captured on the first observation would still say "no"
    // after a later frame raised the banner.
    if (error.kind === 'expired') {
      console.warn(
        '[decisions] the session has expired; what is waiting for approval ' +
          'cannot be read until the reader signs in again',
        error.detail,
      );
      return;
    }
    console.warn(
      '[decisions] could not read what is waiting for approval; ' +
        'the in-thread approval card cannot be shown',
      error.detail,
    );
  }, [error]);
  const next = open[0] ?? null;

  if (settled.length === 0 && next === null && !showReadFailure && !showExpired) {
    return null;
  }

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

    The expired line gets neither of those two: it is not a decision waiting,
    and on its own it is not a receipt either. "Approvals" is the plain name for
    what the region is about when the only thing in it is a reason we cannot
    show any.
  */
  const label =
    next !== null || showReadFailure
      ? 'Waiting for your approval'
      : settled.length > 0
        ? 'Recent approvals'
        : 'Approvals';

  return (
    <div
      role="region"
      aria-label={label}
      className="mb-3 flex flex-col gap-2"
    >
      {/*
        The announcer is a SEPARATE node, and deliberately not the cluster.

        `aria-live` on the wrapper announced arrival, which is what we wanted —
        but it also announced every mutation inside it, and a settled receipt
        inside its undo window re-renders `Undo | Ns` once a SECOND off
        `useDecisionClock`. That is up to ten spurious announcements per
        resolved decision, which is worse than none: it buries the one that
        mattered. A live region and a ticking countdown must not share a node.

        So this holds one stable sentence that changes only when the answer to
        "is something waiting" changes, and the cards below are announced by
        nothing.
      */}
      <span className="sr-only" role="status" aria-live="polite">
        {next !== null ? 'Your agent is waiting for your approval.' : ''}
      </span>
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
      {showExpired && (
        <Alert>
          <AlertTitle>{DECISION_SESSION_EXPIRED_TITLE}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{DECISION_SESSION_EXPIRED}</span>
            {/* Shared with `TodayView`; it owns the failed-sign-in line. */}
            <SignInAgainButton />
          </AlertDescription>
        </Alert>
      )}
      {showReadFailure && (
        <Alert>
          <AlertTitle>{DECISION_READ_FAILED_TITLE}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            {/*
              The sentence follows what the code is actually doing. While an
              automatic attempt is still coming it says so; once the budget is
              spent it stops saying so, because it would no longer be true.

              THE BUTTON STAYS IN BOTH STATES, and that is not an oversight. It
              is the same action either way — read the list again — and it is
              never a lie: a person who is watching for an approval can have the
              answer now instead of waiting out a back-off, which is the whole
              reason they are looking at this box. Hiding it while we retry
              would take the only control away at the exact moment somebody
              wants it, then pop it back a few seconds later.
            */}
            <span>{retrying ? DECISION_READ_RETRYING : DECISION_READ_FAILED}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
