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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDecisionQueue, type DecisionReadError } from './workspace-decisions';
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

/**
 * How long to wait before each automatic re-read after a failed one, in order.
 * Three attempts, then we stop and the reader gets a button.
 *
 * A failed read used to be TERMINAL. Nothing on this surface polls: the queue
 * is fetched once and afterwards only a `decisionRaised` frame, a thread
 * switch, or a click reads it again. So a single blip while a hold was actually
 * open left the card off the screen until the reader happened to do something
 * else — and the one thing they are least likely to do is act, because as far
 * as they can tell nothing is waiting on them. That is the hole this closes.
 *
 * Bounded, and deliberately not a poll. This read is ambient — every page load,
 * every user, on the default surface — so an interval would multiply an outage
 * by every open tab, for a queue that is otherwise event-driven. Three attempts
 * over fifteen seconds covers the blip this exists for (a boot race, a dropped
 * connection, a host restarting) and stops well short of hammering a route that
 * is genuinely down.
 *
 * Spaced rather than uniform for the same reason: the first attempt is quick
 * because most failures are momentary and a person may be looking at the screen
 * right now, and the later ones back off because a failure that survives four
 * seconds is not a blip any more.
 *
 * The budget is per OUTAGE, not per trigger — it refills on the first read that
 * succeeds, and nothing else refills it. A person clicking `Try again`, or a
 * new `decisionRaised` frame, still fires a read (they always did); they just
 * do not hand the automatic retry three more attempts each time.
 */
export const READ_RETRY_DELAYS_MS = [1000, 4000, 10_000] as const;

export interface ConversationDecisions {
  /** Still questions (`pending` | `stale`), oldest first. */
  open: Decision[];
  /** Receipts — resolved rows, some still inside their undo window. Capped. */
  settled: Decision[];
  /** The thread these belong to. `null` on the welcome state. */
  conversationId: string | null;
  /**
   * Non-null means we do not have the queue. Passed straight through from
   * `useDecisionQueue` — `kind` is what decides which sentence the card shows.
   */
  error: DecisionReadError | null;
  /**
   * Another read is coming on its own. True from the moment a failed read is
   * scheduled for retry until the attempt that resolves it — so a surface can
   * say "trying again" only while that is true of the code.
   */
  retrying: boolean;
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

  /*
    A failed read tries itself again, up to `READ_RETRY_DELAYS_MS.length` times.

    GATED ON A KNOWN CONVERSATION, which is the whole point of it living here
    rather than in `useDecisionQueue`. While `conversationId` is null this hook
    returns `open: []` no matter what the queue holds, so there is nothing a
    retry could put on screen — and the id IS null on every reload until the
    first sidebar click or sent message. Retrying there would spend attempts on
    a window with nothing in it and leave none for the window that matters: a
    read that failed while a card genuinely should be up.

    NOT FOR AN EXPIRED SESSION. A bounded retry against a 401 is three more
    guaranteed 401s — the session is gone until the reader signs in, which is
    why `DecisionReadError` carries `kind` at all (TASK-276).

    Re-arming is what makes this bounded rather than recursive: `error` holds a
    fresh object per failed read, so a retry that fails runs this effect again
    and schedules the next delay, while a retry that succeeds clears `error` and
    resets the budget. `refresh` is stable for the life of the hook
    (`useCallback(…, [])` in `useDecisionQueue`), so nothing else re-runs it.

    NOTHING NEW APPEARS ON SCREEN BECAUSE OF THIS. A retry can only fill the
    queue in, or fail again; the decision about what a failed read is allowed to
    SAY is `InThreadApprovals`', and it is unchanged — still gated on a live
    frame vouching that a hold exists.
  */
  const retriesSpent = useRef(0);
  const [retrying, setRetrying] = useState(false);
  const { error } = queue;
  useEffect(() => {
    if (conversationId === null || error === null || error.kind !== 'failed') {
      retriesSpent.current = 0;
      setRetrying(false);
      return;
    }
    const delay = READ_RETRY_DELAYS_MS[retriesSpent.current];
    if (delay === undefined) {
      // Budget spent. The surface stops saying "trying again" — because we are
      // not — and offers the manual retry instead.
      setRetrying(false);
      return;
    }
    setRetrying(true);
    /*
      The tally moves when an attempt is actually MADE, not when one is
      scheduled, and both halves of that matter.

      Scheduling is not idempotent — React re-runs this effect whenever `error`
      changes identity, and would double-invoke it outright under StrictMode
      (the double-mount `FirstRunAutoCreate` guards against). Counting at
      schedule time would let a `Try again` click, or a frame landing mid-wait,
      spend an automatic attempt that never happened; three clicks and the
      retry is "exhausted" without a single one having fired. Counting at fire
      time makes a cancelled timer cost nothing, which is what a cancelled timer
      did.
    */
    const timer = setTimeout(() => {
      retriesSpent.current += 1;
      void refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [conversationId, error, refresh]);

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
    error,
    retrying,
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
