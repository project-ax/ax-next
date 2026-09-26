/**
 * The Today queue's state — one fetch, three actions, and NO decision machine.
 *
 * `@ax/decisions` owns the machine. It decides whether an approval executes, is
 * parked for the agent's next run, is deferred behind the undo window, trips the
 * freshness guard, or lands on an already-expired row. There is exactly one copy
 * of those rules (invariant 4) and it is not in this file.
 *
 * SO WE DO NOT GUESS AN OUTCOME. A click marks its row BUSY — the buttons go
 * quiet, the row says we are working on it — and when the POST returns we swap
 * in the row the server handed back, whatever it says. The tempting "optimistic"
 * version, flipping the row to `executed` on click, is not a shortcut here: to
 * pick a status to flip TO, this file would have to know which of five outcomes
 * the approval will take, which is the machine, rebuilt on the client, from
 * memory, and wrong for three of them. A row that briefly says "Sent" and then
 * corrects itself to "it will do this the next time it runs" has already told
 * someone something untrue (design H1).
 *
 * A FAILED POST CHANGES NOTHING AND SAYS SO. The row is left exactly as it was
 * and a notice appears on it. The one outcome this surface must never produce is
 * a button that swallows a click.
 *
 * `error` is separate from an empty `decisions` on purpose. An empty queue means
 * "nothing is waiting on you", which is a CLAIM — and it is the single most
 * reassuring claim this product makes. It may only be rendered when we actually
 * read the list.
 *
 * ONE MORE THING ON THIS SCREEN GOES STALE ON ITS OWN: the undo affordance. A
 * row can read "Undo · 6s" while the thing it promises to undo has already
 * happened — the agent consumed the standing authorisation, or the host
 * replayed the call, in the seconds since the approve response was applied.
 * `Decision.undoable` is the SERVER's answer to whether that has happened, and
 * `undoSecondsLeft` (decision-copy.ts) already gates on it before it gates on
 * the clock. The countdown alone is not a safety property — it just measures
 * time, and time is not the thing that closes the window. So this file's job
 * is not to invent an outcome, it is to keep HEARING the server's: while a row
 * is inside its own undo window we poll that one row and apply whatever it
 * says, so the affordance can go away the moment it is no longer true rather
 * than sitting there until the ten seconds run out on the clock alone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  workspaceApi,
  WorkspaceApiError,
  type Decision,
  type ThreadMessage,
} from './workspace-api';
import {
  DECISION_ACTION_FAILED,
  DECISION_UNDO_TOO_LATE,
  undoSecondsLeft,
} from '@/components/workspace/decision-copy';
import { isJustResolved, isOpenDecision } from './workspace-types';

/**
 * How often we re-read a row while its undo window is open. The window itself
 * is `UNDO_WINDOW_MS` (10s), so this is at most ten reads of one row — and it
 * only ever runs while that row is actually undoable, never for the rest of
 * the queue's life.
 */
const UNDO_POLL_MS = 1000;

/**
 * How many failures in a row on ONE row before the re-read leaves a trace.
 *
 * Three, so a single blip stays quiet — the poll is deliberately silent to a
 * person and this does not change that — but a genuinely broken route says so
 * to a developer instead of looking exactly like the bug it was added to fix.
 */
const POLL_FAILURES_BEFORE_NOTE = 3;

/**
 * Why the queue could not be read — in the two shapes that call for different
 * sentences.
 *
 * `expired` is a 401. The read did not fail, it was REFUSED: the session this
 * tab is holding is no longer valid, and it will go on being refused until the
 * reader signs in again. "Try again" is the wrong offer there — it points at a
 * button that cannot work — and "something went wrong" is the wrong sentence,
 * because nothing did. The person is signed out, which is both knowable and
 * fixable, and only the status can tell us.
 *
 * `failed` is everything else: an unreachable host, a 500, a body we could not
 * parse. Those are blips, and trying again is exactly right for them.
 *
 * Modelled on `FilesError` in `workspace-files.ts`, which draws the same line
 * at 503 for the same reason. The route answers 401 from `authOr401` alone —
 * i.e. `auth:require-user` rejected — so a 401 is evidence about the SESSION
 * and never about this route's own authority.
 *
 * `detail` is for LOGS. No surface renders it. It used to read
 * `workspace /decisions → 401` — a request path, not a sentence anybody can
 * act on — and since TASK-288 gave `WorkspaceApiError` authored copy it is a
 * plain sentence instead. Still logs-only: the surfaces here choose their own
 * words from `kind`, which is the whole point of splitting the two.
 */
export interface DecisionReadError {
  kind: 'expired' | 'failed';
  detail: string;
}

function toDecisionReadError(e: unknown): DecisionReadError {
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof WorkspaceApiError && e.status === 401) {
    return { kind: 'expired', detail };
  }
  return { kind: 'failed', detail };
}

/**
 * A fresh queue read, plus the receipts it does not know about (TASK-509).
 *
 * `GET /api/workspace/decisions` lists OPEN rows only — `decisions:list`'s
 * default status set — so a row resolved a moment ago is, correctly, not in
 * it. But that row is still on screen as its own receipt, carrying the
 * ten-second Undo, and a re-read is exactly what follows an in-thread answer:
 * the turn resumes, finishes, and the thread asks the shell to refresh. Taking
 * the read verbatim removed the row the person had just answered, the thread's
 * `ApprovalCard` (which looks its decision up by id) rendered nothing, and
 * focus fell from the receipt to `<body>` about 0.6s after the click —
 * measured on the TASK-358 walk. Today only looked immune because nothing on
 * Today triggers that refresh.
 *
 * So a row survives a read that omits it iff it is RESOLVED and still inside
 * `JUST_RESOLVED_MS` — the same predicate Today uses to draw it, so the two
 * surfaces cannot disagree about the same receipt.
 *
 * Which direction it fails in: CLOSED for anything still asking a question. An
 * OPEN row the server stopped listing is dropped as before — it was answered
 * or expired somewhere else, and keeping it would offer buttons for a question
 * that is already closed. A row the server DOES list is always the server's
 * copy. Retained rows go after the fresh ones, in the order they already had.
 *
 * ONE EXCEPTION TO "THE SERVER'S COPY WINS" (TASK-530): `newer`, the rows a
 * click changed AFTER this read was issued. The read's snapshot of those rows
 * predates the person's own action, so it knows less than we do. The case that
 * found it is Undo: a refresh issued while the row was still resolved (the
 * resumed turn's `onDone`) lands after the undo reopened it. The row is open
 * locally, so the receipt rule above does not keep it, and the read's list
 * omits it — so the reopened card unmounted and focus fell to `<body>`, the
 * TASK-509 symptom in the other direction. The approve direction is the same
 * race: a read issued before the click still lists the row OPEN, and applying
 * it would put the buttons back over a question just answered.
 *
 * Which direction THIS fails in: it keeps our copy for exactly one read — the
 * ones already in flight when the click landed. Every read issued after it
 * applies normally, so an open row answered elsewhere is still dropped by the
 * next read, never kept indefinitely.
 */
function mergeReadWithReceipts(
  prev: readonly Decision[],
  fresh: readonly Decision[],
  now: number,
  newer: ReadonlySet<string>,
): Decision[] {
  const ours = new Map(prev.filter((d) => newer.has(d.id)).map((d) => [d.id, d]));
  const listed = new Set(fresh.map((d) => d.id));
  const merged = fresh.map((d) => ours.get(d.id) ?? d);
  const kept = prev.filter(
    (d) => !listed.has(d.id) && (ours.has(d.id) || isJustResolved(d, now)),
  );
  return [...merged, ...kept];
}

/**
 * A fresh THREAD read, plus the approval pointers it no longer carries for a
 * row the queue is still drawing (TASK-536).
 *
 * `mergeReadWithReceipts` above is half of this. An in-thread answer is
 * followed by two reads, and the queue's is only one of them: the thread
 * re-reads `GET /api/workspace/agents/:id` too, and the server builds its
 * approval pointers from OPEN decisions only. The card is drawn only where a
 * pointer is, so the thread's read took the receipt away even while the queue
 * was keeping it — the card unmounted and focus fell to `<body>` ~1.2s after
 * the click (measured on the TASK-358 walk). The server is right not to invent
 * a receipt: on a fresh page load there is none to show.
 *
 * ONE RULE, NOT TWO (invariant 4). A dropped pointer survives iff the queue
 * still holds its row AND that row is either open or `isJustResolved` — the
 * predicate the queue and Today already use. So the thread cannot keep a
 * receipt the queue has let go of, and cannot let go of one Today still shows.
 * The open case is the queue's own TASK-530 rule arriving here: a thread read
 * issued while the row was resolved can land after an Undo reopened it, and the
 * reopened question must not vanish either. Whatever the queue decides about an
 * open row the server stopped listing, the card follows on its next read — it
 * draws from the queue, never from this pointer.
 *
 * WHERE IT GOES. Right after the nearest message before it that the fresh read
 * still has — where it was, with the continuation of the turn below it. That is
 * where the reader saw it while the turn streamed, and it is also what keeps it
 * MOUNTED: the transcript keys each message by position (`findFieldKey`), so a
 * receipt that moved would remount, and a remount drops focus exactly as an
 * unmount does.
 *
 * Which direction it fails in: CLOSED. Only a pointer the previous read had,
 * for a row the queue is still drawing, can come back; the caller applies this
 * only within one conversation; and every later read re-asks, so a pointer
 * lasts no longer than its row's receipt.
 */
export function keepAnsweredApprovals(
  prev: readonly ThreadMessage[],
  fresh: readonly ThreadMessage[],
  decisions: readonly Decision[],
  now: number,
): ThreadMessage[] {
  const freshIds = new Set(fresh.map((m) => m.id));
  const still = (decisionId: string): boolean => {
    const d = decisions.find((x) => x.id === decisionId);
    return d !== undefined && (isOpenDecision(d) || isJustResolved(d, now));
  };
  /** Anchor message id (or `null` for "before everything") → pointers after it. */
  const after = new Map<string | null, ThreadMessage[]>();
  let anchor: string | null = null;
  let kept = 0;
  for (const m of prev) {
    if (freshIds.has(m.id)) {
      anchor = m.id;
      continue;
    }
    if (m.kind !== 'approval' || !still(m.decisionId)) continue;
    after.set(anchor, [...(after.get(anchor) ?? []), m]);
    kept += 1;
  }
  if (kept === 0) return [...fresh];
  const out: ThreadMessage[] = [...(after.get(null) ?? [])];
  for (const m of fresh) out.push(m, ...(after.get(m.id) ?? []));
  return out;
}

export interface DecisionQueue {
  decisions: Decision[];
  loading: boolean;
  /**
   * Non-null means we do not have the queue. Never rendered as an empty queue,
   * and `kind` decides which of two sentences the reader gets.
   */
  error: DecisionReadError | null;
  /** Rows with a POST in flight. Their controls are disabled, not hidden. */
  busyIds: ReadonlySet<string>;
  /** Per-row line from the last action that failed or was refused. */
  notices: ReadonlyMap<string, string>;
  approve: (id: string) => void;
  dismiss: (id: string) => void;
  undo: (id: string) => void;
  clearNotice: (id: string) => void;
  refresh: () => Promise<void>;
}

/** A value we are willing to treat as a decision row. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export interface DecisionQueueHooks {
  /**
   * TASK-278 — fires after an approve POST resolves with a row applied.
   * Carries the row and the approve response's `streamReqId` (null when no
   * turn runs to watch). A surface with an open thread uses it to attach a
   * stream consumer for the continuation; a surface with no thread (Today)
   * ignores it.
   */
  onDecisionApproved?: (decision: Decision, streamReqId: string | null) => void;
}

export function useDecisionQueue(hooks?: DecisionQueueHooks): DecisionQueue {
  const { onDecisionApproved } = hooks ?? {};
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DecisionReadError | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [notices, setNotices] = useState<ReadonlyMap<string, string>>(new Map());

  /**
   * Bumped on every read. A response older than the newest request is dropped —
   * without this, a slow first fetch landing after a fast refresh would put the
   * pre-approval row back on screen, undoing a resolution in the UI only.
   */
  const readId = useRef(0);

  /**
   * Row id → the newest read id that was already issued when a click's server
   * row was applied to it (TASK-530). A read whose id is at or below that
   * number started before the click, so it may not overwrite or drop the row —
   * see `mergeReadWithReceipts`. Only the newest read ever applies, so once one
   * lands every entry is moot and the map is cleared.
   */
  const appliedAtRead = useRef(new Map<string, number>());

  const refresh = useCallback(async () => {
    const id = ++readId.current;
    setLoading(true);
    try {
      const page = await workspaceApi.decisions();
      if (readId.current !== id) return;
      // Snapshot before the updater: React may run it later, or twice.
      const newer = new Set<string>();
      for (const [rowId, at] of appliedAtRead.current) if (at >= id) newer.add(rowId);
      appliedAtRead.current.clear();
      /*
        A body that is not a decisions page never reaches here — `workspaceApi`
        throws `WorkspaceShapeError` at the boundary, and the `catch` below
        turns it into a FAILED READ. That distinction is the whole point of the
        header on this file: an empty queue says "nothing is waiting on you",
        which is the most reassuring claim this product makes, and it may only
        be rendered when we actually read the list. A malformed body is not
        that — and `decisions` feeds `watchedKey` below, which calls `.filter`
        on it during render, so an `undefined` here would not degrade, it would
        throw out of the hook and unmount the surface.
      */
      setDecisions((prev) =>
        mergeReadWithReceipts(prev, page.decisions, Date.now(), newer),
      );
      setError(null);
    } catch (e) {
      if (readId.current !== id) return;
      setError(toDecisionReadError(e));
    } finally {
      if (readId.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setNotice = useCallback((id: string, line: string | null) => {
    setNotices((prev) => {
      const next = new Map(prev);
      if (line === null) next.delete(id);
      else next.set(id, line);
      return next;
    });
  }, []);

  const clearNotice = useCallback(
    (id: string) => setNotice(id, null),
    [setNotice],
  );

  /**
   * Swap one row for the version the server just handed back.
   *
   * Keyed on id and positional — a resolved decision stays exactly where it was
   * in the list until the next read, so the row a person just acted on turns
   * into its own receipt under their cursor instead of vanishing and reflowing
   * everything below it.
   */
  const applyServerRow = useCallback((row: Decision) => {
    appliedAtRead.current.set(row.id, readId.current);
    setDecisions((prev) => {
      const at = prev.findIndex((d) => d.id === row.id);
      if (at === -1) return [...prev, row];
      const next = [...prev];
      next[at] = row;
      return next;
    });
  }, []);

  /**
   * Swap in a row a POLL just read back — never one a click produced.
   *
   * This is the race guard. A poll already in flight when the person clicks
   * Undo can land AFTER the undo's own response, and without this check it
   * would put the just-approved row back on screen: the click would visibly
   * un-happen. So a polled row is only ever applied while it is STILL being
   * watched — still in the list, and still inside its own undo window at the
   * moment we are about to apply it. Once a row stops being watchable (undone,
   * or the window simply closed), no poll response may touch it again.
   */
  const applyPolledRow = useCallback((row: Decision) => {
    setDecisions((prev) => {
      const at = prev.findIndex((d) => d.id === row.id);
      if (at === -1) return prev;
      if (undoSecondsLeft(prev[at]!) <= 0) return prev;
      const next = [...prev];
      next[at] = row;
      return next;
    });
  }, []);

  /**
   * One shape for all three actions: mark busy, POST, apply what came back.
   *
   * `read` turns the response into either the server's row plus an optional
   * notice, or `null` — which means the server answered but told us nothing we
   * can render, and that is a failure, not a quiet success.
   */
  const act = useCallback(
    <T>(
      id: string,
      post: () => Promise<T>,
      read: (out: T) => { decision: Decision | null; notice: string | null },
      /**
       * TASK-278 — sees the RAW post output on success (with the applied
       * row), so the approve path can hand the continuation id to whoever
       * renders the thread. Never called on failure or on a response with
       * nothing to apply: there is no continuation to attach to then.
       */
      report?: (raw: T, decision: Decision) => void,
    ) => {
      if (busyIds.has(id)) return; // Second click on an in-flight row: absorbed.
      setBusyIds((prev) => new Set(prev).add(id));
      setNotice(id, null);
      void (async () => {
        try {
          const raw = await post();
          const { decision, notice } = read(raw);
          /*
            The routes 404 rather than answering 200 with a null row, so a
            missing `decision` here means the response was not the shape we
            asked for. Either way there is nothing to apply, and "nothing to
            apply" must never be rendered as a quiet success.

            Checked as an OBJECT, not just non-null, for parity with the two
            READ paths that `checkedRead` guards in `workspace-api.ts`. A
            truthy non-record (`42`, `"gone"`) passes a `!= null` test and
            lands in state as a row nothing can render: `decisionOutcome`
            switches on `d.status`, has no `default`, and returns `undefined`
            for a status it does not know — while its declared type says
            `DecisionOutcome | null`, so a caller that trusts "non-null means
            safe to dereference" crashes. Cheaper to reject it here than to
            harden every reader.
          */
          if (!isRecord(decision)) {
            setNotice(id, DECISION_ACTION_FAILED);
            return;
          }
          applyServerRow(decision);
          setNotice(id, notice);
          report?.(raw, decision);
        } catch (err) {
          // Quiet in the UI is not silent anywhere else. Both READ paths log
          // their failure (`checkedRead`, and `InThreadApprovals`), and this is
          // the one decision path that still discarded its cause entirely —
          // now the busier of the two, since the card ships on `/`. The user
          // gets the authored notice below; an operator gets the reason.
          console.warn(`[decisions] the ${id} action did not reach the server`, err);
          // The row is untouched — we never changed it — so there is nothing to
          // roll back. What there IS, is a person who clicked a button and is
          // owed an answer.
          setNotice(id, DECISION_ACTION_FAILED);
        } finally {
          setBusyIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      })();
    },
    [applyServerRow, busyIds, setNotice],
  );

  const approve = useCallback(
    (id: string) =>
      act(
        id,
        () => workspaceApi.approveDecision(id),
        (out) => ({ decision: out.decision, notice: null }),
        // TASK-278 — hand the continuation id to the thread surface. `??`
        // null: a host predating TASK-278 answers no `streamReqId` at all,
        // which is absence, never a stream.
        (out, decision) =>
          onDecisionApproved?.(decision, out.streamReqId ?? null),
      ),
    [act, onDecisionApproved],
  );

  const dismiss = useCallback(
    (id: string) =>
      act(
        id,
        () => workspaceApi.dismissDecision(id),
        (out) => ({ decision: out.decision, notice: null }),
      ),
    [act],
  );

  const undo = useCallback(
    (id: string) =>
      act(
        id,
        () => workspaceApi.undoDecision(id),
        (out) => ({
          /*
            A REFUSAL RETIRES THE AFFORDANCE (TASK-441).

            `undone: false` with a row attached is the server refusing, not
            failing: there was nothing left to take back. The row it hands back
            on that path is the stored row UNCHANGED — a refusal writes
            nothing, which is right — so when the refusal is the ten seconds
            running out server-side, `undoable` is still whatever it was before
            the click: true. Applying that row verbatim is what left the button
            on screen, counting down the rest of the window and pressable
            again, against a decision that can no longer be undone (measured on
            the TASK-358 walk).

            So we record the server's own verdict on the row we keep. This is
            not the decision machine rebuilt on the client — nothing is
            re-derived, and no clock is consulted. It is the one fact this
            response carries, written where `undoSecondsLeft` will read it, so
            the Undo control unmounts in every renderer at once.

            The server narrows the same field on the same condition
            (`undoDecision` in `server/routes-workspace.ts`). Two enforcement
            points on purpose, in the shape `@ax/decisions` already uses for
            the consumed/replayed guard: this one also holds against a host
            that predates that fix, which is exactly the host the walk ran on.

            Which direction it fails in: CLOSED. It only ever turns `undoable`
            from true to false, only on `undone: false`, and it cannot turn it
            back on — `applyPolledRow` then refuses every later poll for this
            row, because a row with no undo left is no longer watched.

            `isRecord` first so the narrowing cannot manufacture a row: the
            guard in `act` rejects a non-record body, and spreading `42` into
            an object would sneak `{ undoable: false }` past it.
          */
          decision:
            !out.undone && isRecord(out.decision)
              ? { ...out.decision, undoable: false }
              : out.decision,
          // Saying nothing here would leave the button looking broken; saying
          // "undone" would be a lie.
          notice: out.undone ? null : DECISION_UNDO_TOO_LATE,
        }),
      ),
    [act],
  );

  /*
   * The interval reads these two through refs rather than through the state
   * values directly, so applying a polled row (or a click starting a busy
   * POST) never has to re-subscribe the effect below — it just changes what
   * the next tick sees.
   */
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;
  const busyIdsRef = useRef(busyIds);
  busyIdsRef.current = busyIds;

  /**
   * Consecutive re-read failures per row. A ref and not state: nothing on
   * screen is allowed to change because a poll failed, so re-rendering over it
   * would be the opposite of the point.
   */
  const pollFailures = useRef(new Map<string, number>());

  /**
   * The set of rows currently inside their own undo window, as a STABLE
   * string key — sorted ids, joined. Using the ids (not the `Decision`
   * objects, which are replaced wholesale on every apply) means the effect
   * below only re-runs when a row starts or stops being watchable, not on
   * every clock tick or every poll response.
   */
  const watchedKey = decisions
    .filter((d) => undoSecondsLeft(d) > 0)
    .map((d) => d.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (watchedKey === '') return;
    const id = setInterval(() => {
      const watched = decisionsRef.current.filter((d) => undoSecondsLeft(d) > 0);
      if (watched.length === 0) {
        clearInterval(id);
        pollFailures.current.clear();
        return;
      }
      // A row that has left its window will never be polled again, so its
      // failure tally is dead weight. Dropped here rather than left to grow
      // for as long as the tab stays open.
      for (const key of pollFailures.current.keys()) {
        if (!watched.some((d) => d.id === key)) pollFailures.current.delete(key);
      }
      for (const d of watched) {
        // A POST is already in flight for this row (e.g. the person just hit
        // Undo) — a poll racing that response is exactly what `applyPolledRow`
        // guards against, but there is no reason to fire the extra request.
        if (busyIdsRef.current.has(d.id)) continue;
        void workspaceApi
          .decision(d.id)
          .then((out) => {
            pollFailures.current.delete(d.id);
            applyPolledRow(out.decision);
          })
          // A FAILED poll changes nothing and sets no notice. The row keeps
          // saying what the server last told us: a transient network blip
          // must never blank or alter a receipt, and nobody clicked anything
          // here, so nobody is owed an answer for it. Undo also stays honest
          // whatever happens here — the server refuses a late one and the row
          // says so — so a blip costs punctuality, never correctness.
          //
          // But SILENT and INVISIBLE are different things. If this route were
          // actually broken, every symptom above is by design: no notice, no
          // changed row, just Undo lingering the full ten seconds again. So a
          // run of failures on one row leaves a trace for whoever is looking.
          // Dev-only and once per run, because this is a developer's signal,
          // not a user's: a person watching a countdown is owed nothing, and a
          // console line per second would bury the one that matters.
          .catch(() => {
            const runs = (pollFailures.current.get(d.id) ?? 0) + 1;
            pollFailures.current.set(d.id, runs);
            if (runs === POLL_FAILURES_BEFORE_NOTE && import.meta.env.DEV) {
              console.debug(
                `[decisions] the undo re-read has failed ${runs}x for ${d.id}; ` +
                  'the Undo control may be showing a window the server has already closed',
              );
            }
          });
      }
    }, UNDO_POLL_MS);
    return () => clearInterval(id);
  }, [watchedKey, applyPolledRow]);

  return {
    decisions,
    loading,
    error,
    busyIds,
    notices,
    approve,
    dismiss,
    undo,
    clearNotice,
    refresh,
  };
}
