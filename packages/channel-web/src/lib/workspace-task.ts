/**
 * A task page's read (TASK-910): `GET /api/workspace/tasks/:agentId/:routineId`
 * as a small state machine, the Tasks page's `useTasks` (`workspace-tasks.ts`)
 * for one task.
 *
 * Three kinds of failure, because the page says three different things
 * (`toReadOutcome`): a 401 is "sign in again" (`expired`); a 404 is "we
 * couldn't find this task", with no Try again (`gone`), since the route answers
 * 404 alike for a task that isn't there and one that isn't yours; everything
 * else is "couldn't load" with Try again (`failed`).
 *
 * A refresh (Try again, or the re-read after Check now, Pause, Resume, Clear
 * notes or a reply) keeps the task on screen while it runs. One that fails
 * keeps it, marked `refreshFailed`, the way the Tasks page keeps its rows. One
 * that finds the task gone or the session ended replaces it: there is nothing
 * left to show, and no retry fixes it.
 *
 * A QUIET RE-READ (`refreshQuietly`, TASK-931) is the "Checking in now…"
 * poll's, every 10 seconds (`use-task-poll.ts`). It doesn't mark the task
 * refreshing, since the page disables its buttons while one runs and a
 * keyboard user would lose their place every 10 seconds; and one that fails
 * leaves the page as it was (logged), since a background blip is no reason to
 * raise an alarm. Three in a row that fail are no blip: the third marks the
 * task `refreshFailed`, as a failed refresh does, so a page whose reads keep
 * failing says so instead of polling in silence (any good read starts the
 * count again). One that finds the task gone or the session ended still
 * replaces it. While an ordinary refresh is in flight a quiet re-read reads
 * nothing: it would overtake the refresh (whose answer would then be dropped
 * as the older one) and, failing, leave the page as it was before the press.
 *
 * A CHANGE'S ANSWER (`replaceSteps`, TASK-949) swaps the task's steps with no
 * re-read, since the answer is the steps as they now are. A read that started
 * before that swap may carry older steps (the poll's last read, say, which began
 * before the press), so when it lands it keeps the page's steps and shows the
 * rest of its answer; and since what it dropped may also have held something
 * newer (an agent's tick from the check-in it delivered, after which the poll
 * stops), it asks for one more quiet read. A read that started after the swap
 * reads the change too, and shows its own steps.
 *
 * A WRITE'S ANSWER (`applyAnswer`, TASK-951) goes on screen at once and then
 * triggers an ordinary re-read; the numbering above keeps an older read from
 * overwriting it.
 *
 * It holds one task. Mount it once per task (key the page by its ids): since a
 * refresh keeps what's on screen, state carried over from another task would
 * show that task's page while this one loads.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { logRequestFailure } from './http';
import { toReadOutcome } from './read-register';
import { workspaceApi } from './workspace-api';
import type { TaskDetail, TaskStep } from './workspace-types';

/** Failed quiet re-reads in a row before the page says it couldn't refresh. */
export const QUIET_FAILURES_TO_SAY_SO = 3;

export type TaskReadError = 'expired' | 'gone' | 'failed';

export type TaskState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      detail: TaskDetail;
      /** A refresh is in flight; the task on screen is the last good answer. */
      refreshing: boolean;
      /** The last refresh failed; the task on screen is the last good answer. */
      refreshFailed: boolean;
    }
  | { kind: 'failed'; error: TaskReadError };

export function useTask(
  agentId: string,
  routineId: string,
): {
  state: TaskState;
  refresh: () => void;
  /**
   * A background re-read (the poll's): it doesn't mark the task refreshing,
   * and a failed one leaves the page as it is (logged), unless it is the third
   * in a row, which marks it `refreshFailed`. It reads nothing while an
   * ordinary refresh is in flight. One that finds the
   * task gone or the session ended still replaces it, like any read.
   */
  refreshQuietly: () => void;
  /**
   * Swap a ready task's steps for a change's answer (TASK-949), keeping the
   * rest of the task. Before the task has loaded there is nothing to swap into,
   * so it does nothing. Reads already in flight keep these steps (see above).
   */
  replaceSteps: (steps: TaskStep[]) => void;
  /**
   * Shows a write's answer on the task at once (a saved finish date, TASK-951),
   * then reads the task again, as `refresh` does. That read takes the next
   * number, so a read already on its way, which was asked before the write,
   * is dropped when it lands and can't put the old value back: only the
   * newest read's answer is kept.
   */
  applyAnswer: (update: (detail: TaskDetail) => TaskDetail) => void;
} {
  const [state, setState] = useState<TaskState>({ kind: 'loading' });
  // What is on screen, for the callbacks that must know whether a task is there.
  const shown = useRef(state);
  useEffect(() => {
    shown.current = state;
  }, [state]);
  // Each fetch takes the next number; an answer for any number but the newest
  // is dropped, so a slow first answer cannot overwrite a faster refresh's.
  const latest = useRef(0);
  // Failed quiet reads since the last good read: the third says so.
  const quietFailures = useRef(0);
  // The ordinary read in flight, if any (its number): a quiet read waits it out.
  const loudInFlight = useRef<number | null>(null);
  // The newest read's number when the page last swapped in a change's steps. A
  // read numbered at or below it started before the change's answer, so its
  // steps may be older than the page's: it keeps the page's steps and shows the
  // rest of its answer. A read started after it reads the change too.
  const stepsReplacedAt = useRef<number | null>(null);
  // `refreshQuietly`, for `load` to call (it is defined after `load`).
  const quietly = useRef<() => void>(() => {});

  const load = useCallback(
    (quiet: boolean) => {
      const mine = ++latest.current;
      if (!quiet) loudInFlight.current = mine;
      const settled = () => {
        if (loudInFlight.current === mine) loudInFlight.current = null;
      };
      workspaceApi.task(agentId, routineId).then(
        (detail) => {
          settled();
          if (latest.current !== mine) return;
          quietFailures.current = 0;
          const stale = stepsReplacedAt.current !== null && mine <= stepsReplacedAt.current;
          setState((s) => ({
            kind: 'ready',
            refreshing: false,
            refreshFailed: false,
            detail: stale && s.kind === 'ready' ? { ...detail, steps: s.detail.steps } : detail,
          }));
          // The steps it dropped may hold something newer than the page's. One
          // more quiet read, started now, shows the list as it is. Through
          // `refreshQuietly`, so it keeps its rule: none overtakes an ordinary
          // refresh in flight (which, if it began before the swap, asks for its
          // own when it lands). This one began after the swap, so it is not stale.
          if (stale) quietly.current();
        },
        (e: unknown) => {
          settled();
          if (latest.current !== mine) return;
          logRequestFailure(e, 'workspace-task');
          const error: TaskReadError = toReadOutcome(e);
          const quietFailuresNow = quiet ? ++quietFailures.current : quietFailures.current;
          setState((s) => {
            if (s.kind !== 'ready' || error !== 'failed') return { kind: 'failed', error };
            // Quiet, unless it is the third quiet failure in a row. (No quiet
            // read starts while a refresh is in flight, so none answers for one.)
            if (quiet && quietFailuresNow < QUIET_FAILURES_TO_SAY_SO) return s;
            return { ...s, refreshing: false, refreshFailed: true };
          });
        },
      );
    },
    [agentId, routineId],
  );

  useEffect(() => {
    load(false);
    return () => {
      latest.current++;
    };
  }, [load]);

  const refresh = useCallback(() => {
    setState((s) => (s.kind === 'ready' ? { ...s, refreshing: true } : { kind: 'loading' }));
    load(false);
  }, [load]);

  const refreshQuietly = useCallback(() => {
    if (loudInFlight.current !== null) return;
    load(true);
  }, [load]);
  useEffect(() => {
    quietly.current = refreshQuietly;
  }, [refreshQuietly]);

  const replaceSteps = useCallback((steps: TaskStep[]) => {
    if (shown.current.kind !== 'ready') return;
    stepsReplacedAt.current = latest.current;
    setState((s) => (s.kind === 'ready' ? { ...s, detail: { ...s.detail, steps } } : s));
  }, []);

  const applyAnswer = useCallback(
    (update: (detail: TaskDetail) => TaskDetail) => {
      setState((s) => (s.kind === 'ready' ? { ...s, detail: update(s.detail), refreshing: true } : s));
      load(false);
    },
    [load],
  );

  return { state, refresh, refreshQuietly, replaceSteps, applyAnswer };
}
