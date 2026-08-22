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
import { workspaceApi, type Decision } from './workspace-api';
import {
  DECISION_ACTION_FAILED,
  DECISION_UNDO_TOO_LATE,
  undoSecondsLeft,
} from '@/components/workspace/decision-copy';

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

export interface DecisionQueue {
  decisions: Decision[];
  loading: boolean;
  /** Non-null means the READ failed. Never rendered as an empty queue. */
  error: string | null;
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

export function useDecisionQueue(): DecisionQueue {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [notices, setNotices] = useState<ReadonlyMap<string, string>>(new Map());

  /**
   * Bumped on every read. A response older than the newest request is dropped —
   * without this, a slow first fetch landing after a fast refresh would put the
   * pre-approval row back on screen, undoing a resolution in the UI only.
   */
  const readId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++readId.current;
    setLoading(true);
    try {
      const page = await workspaceApi.decisions();
      if (readId.current !== id) return;
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
      setDecisions(page.decisions);
      setError(null);
    } catch (e) {
      if (readId.current !== id) return;
      setError(e instanceof Error ? e.message : String(e));
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
    ) => {
      if (busyIds.has(id)) return; // Second click on an in-flight row: absorbed.
      setBusyIds((prev) => new Set(prev).add(id));
      setNotice(id, null);
      void (async () => {
        try {
          const { decision, notice } = read(await post());
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
      ),
    [act],
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
          decision: out.decision,
          // `undone: false` with a row attached is the server refusing, not
          // failing: the call had already gone out. Saying nothing here would
          // leave the button looking broken; saying "undone" would be a lie.
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
