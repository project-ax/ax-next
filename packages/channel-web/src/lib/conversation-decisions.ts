/**
 * The decisions for THIS conversation — and deliberately nothing else.
 *
 * This file owns no decision logic, and that is the point. The machine lives in
 * `@ax/decisions` on the server: what an approval does, whether it executes now
 * or on the agent's next run, whether the undo window is still open. Its one
 * client mirror is `useDecisionQueue` — the rules about never guessing an
 * outcome, and about a failed POST changing nothing and saying so, are written
 * down there exactly once (invariant 4).
 *
 * So all this hook does is narrow that queue to the thread the reader is
 * looking at, and wire the `decisionRaised` SSE counter to a re-read. If you
 * find yourself about to add a status branch here, it belongs in
 * `decision-copy.ts` or in the machine — a second opinion about what a row
 * MEANS is how two surfaces end up describing one event differently.
 *
 * The open/settled split asks `isOpenDecision()` — the predicate that already
 * exists precisely so the surfaces agree on which rows are still questions.
 * `decisionOutcome()` would answer the same thing today, but it is the COPY
 * function; using it as a status test would make this the fourth consumer of
 * "is this open" and the only one asking a different way. Reserve it for prose.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useDecisionQueue } from './workspace-decisions';
import { useConversationId } from './use-conversation-id';
import { decisionRaisedActions, useDecisionRaised } from './decision-raised-store';
import { isOpenDecision } from './workspace-types';
import { undoSecondsLeft } from '@/components/workspace/decision-copy';
import type { Decision } from './workspace-api';

/**
 * How many SETTLED receipts stay on screen.
 *
 * The cluster this feeds is `position: fixed` above the composer and grows
 * upward, so an uncapped list of past decisions would eventually push the live
 * one off the top of the viewport — where there is no scrollbar to find it
 * again. Three is enough to see what just happened without the wall of history.
 *
 * A row whose Undo is still LIVE is exempt (see below). The cap trims history;
 * a control the reader can still press is not history. Capping one away would
 * quietly shorten the grace period on the fourth approval inside ten seconds —
 * and on the deployments this file exists to serve there is nowhere else to go,
 * because `/workspace` and the activity feed are both behind
 * `AX_AGENT_WORKSPACE_PREVIEW`.
 *
 * "Live" is `undoSecondsLeft() > 0`, which is the SAME test `ApprovalCard` uses
 * to draw the button — deliberately not the raw `undoable` flag. `undoable` is
 * the server's "could this still be taken back at all" and carries no clock, so
 * an `approved-pending-agent` row can sit `undoable` for as long as its agent
 * takes to re-run. Exempting on that would let buttonless receipts stack up and
 * defeat the cap outright, which is the overflow this exists to stop.
 */
export const SETTLED_CAP = 3;

export interface ConversationDecisions {
  /** Still questions (`pending` | `stale`), oldest first. */
  open: Decision[];
  /** Receipts — resolved rows, some still inside their undo window. Capped. */
  settled: Decision[];
  /** The thread these belong to. `null` on the welcome state. */
  conversationId: string | null;
  /** Non-null means the READ failed. Never rendered as an empty queue. */
  error: string | null;
  /** `decisionRaised` frames seen this page-load. Evidence, not a row. */
  raised: number;
  busyIds: ReadonlySet<string>;
  notices: ReadonlyMap<string, string>;
  approve: (id: string) => void;
  dismiss: (id: string) => void;
  undo: (id: string) => void;
  clearNotice: (id: string) => void;
  refresh: () => Promise<void>;
}

/** `resolvedAt` as a number, or 0 for a row the server never dated. */
function resolvedTime(d: Decision): number {
  if (d.resolvedAt === null) return 0;
  const at = Date.parse(d.resolvedAt);
  return Number.isNaN(at) ? 0 : at;
}

export function useConversationDecisions(): ConversationDecisions {
  const queue = useDecisionQueue();
  const conversationId = useConversationId();
  const { raised } = useDecisionRaised();

  const { decisions, refresh } = queue;

  /*
    A new `decisionRaised` frame means "read the list again now". The frame
    itself carries only {decisionId, summary} — not enough to render a card —
    so it is a trigger and never a source.

    Seeded at 0 so the first render does NOT refresh: `useDecisionQueue`
    already fetches on mount, and a second identical GET on every page load is
    a cost with no reader-visible benefit.
  */
  const seenRaised = useRef(0);
  useEffect(() => {
    if (raised === seenRaised.current) return;
    seenRaised.current = raised;
    // A drop to 0 is our own reset below, not a new frame.
    if (raised === 0) return;
    void refresh();
  }, [raised, refresh]);

  /*
    Switching threads: the counter is evidence about a conversation, so it must
    not survive the conversation. Otherwise a hold raised in thread A would go
    on vouching for thread B, and B's failed read would show an approval
    warning for an approval that is somewhere else entirely.

    We re-read on the way in too — a decision raised while this tab was looking
    at another thread (or raised in a different tab) is otherwise invisible
    until a reload. The first run is skipped for the same reason as above:
    mounting already fetched.
  */
  const prevConversationId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevConversationId.current;
    prevConversationId.current = conversationId;
    if (prev === undefined) return; // mount: useDecisionQueue already fetched.
    /*
      Only a switch AWAY from a real conversation invalidates the evidence.

      The `null -> c1` step is the first turn minting its conversation, and a
      `decisionRaised` frame for c1 can land fractionally BEFORE
      `useConversationId` flips — they come from the same round trip. Resetting
      there would throw away evidence that belongs to the thread we are moving
      into, and a failed read would then show nothing on the one surface that
      could have shown it.
    */
    if (prev !== null) decisionRaisedActions.reset();
    void refresh();
  }, [conversationId, refresh]);

  const { open, settled } = useMemo(() => {
    // No conversation, no rows. On the welcome state there is nothing an
    // approval could be attached to, and "waiting on you" is a claim we have
    // no business making before the first message.
    if (conversationId === null) return { open: [], settled: [] };
    const mine = decisions.filter((d) => d.conversationId === conversationId);
    return {
      // Oldest first — the same order `/workspace` puts its approvals in, so
      // the two surfaces ask the same question first.
      open: mine
        .filter((d) => isOpenDecision(d))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
      // Newest first, keep the newest few PLUS any row whose Undo is still on
      // screen, then flip into thread order so the most recent receipt sits
      // closest to the composer where the reader's eyes already are. The
      // exemption is genuinely bounded: `undoSecondsLeft` goes to 0 ten seconds
      // after `resolvedAt`, so it can only ever hold rows resolved in the last
      // ten seconds — never a backlog.
      settled: mine
        .filter((d) => !isOpenDecision(d))
        .sort((a, b) => resolvedTime(b) - resolvedTime(a))
        .filter((d, i) => i < SETTLED_CAP || undoSecondsLeft(d) > 0)
        .reverse(),
    };
  }, [conversationId, decisions]);

  return {
    open,
    settled,
    conversationId,
    error: queue.error,
    raised,
    busyIds: queue.busyIds,
    notices: queue.notices,
    approve: queue.approve,
    dismiss: queue.dismiss,
    undo: queue.undo,
    clearNotice: queue.clearNotice,
    refresh,
  };
}
