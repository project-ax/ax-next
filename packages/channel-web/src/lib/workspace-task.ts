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
 * replaces it. A quiet read that overtakes a refresh answers for both, so it
 * ends that refresh, failure included.
 *
 * It holds one task. Mount it once per task (key the page by its ids): since a
 * refresh keeps what's on screen, state carried over from another task would
 * show that task's page while this one loads.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { logRequestFailure } from './http';
import { toReadOutcome } from './read-register';
import { workspaceApi } from './workspace-api';
import type { TaskDetail } from './workspace-types';

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
   * in a row, which marks it `refreshFailed`. One that finds the
   * task gone or the session ended still replaces it, like any read.
   */
  refreshQuietly: () => void;
} {
  const [state, setState] = useState<TaskState>({ kind: 'loading' });
  // Each fetch takes the next number; an answer for any number but the newest
  // is dropped, so a slow first answer cannot overwrite a faster refresh's.
  const latest = useRef(0);
  // Failed quiet reads since the last good read: the third says so.
  const quietFailures = useRef(0);

  const load = useCallback(
    (quiet: boolean) => {
      const mine = ++latest.current;
      workspaceApi.task(agentId, routineId).then(
        (detail) => {
          if (latest.current !== mine) return;
          quietFailures.current = 0;
          setState({ kind: 'ready', detail, refreshing: false, refreshFailed: false });
        },
        (e: unknown) => {
          if (latest.current !== mine) return;
          logRequestFailure(e, 'workspace-task');
          const error: TaskReadError = toReadOutcome(e);
          const quietFailuresNow = quiet ? ++quietFailures.current : quietFailures.current;
          setState((s) => {
            if (s.kind !== 'ready' || error !== 'failed') return { kind: 'failed', error };
            // Quiet, unless it overtook a refresh whose own answer is now dropped,
            // or it is the third quiet failure in a row.
            if (quiet && !s.refreshing && quietFailuresNow < QUIET_FAILURES_TO_SAY_SO) return s;
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

  const refreshQuietly = useCallback(() => load(true), [load]);

  return { state, refresh, refreshQuietly };
}
