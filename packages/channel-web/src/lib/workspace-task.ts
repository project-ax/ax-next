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
 * A refresh (Try again, or the re-read after Check now, Pause, Resume or Clear
 * notes) keeps the task on screen while it runs. One that fails keeps it,
 * marked `refreshFailed`, the way the Tasks page keeps its rows. One that finds
 * the task gone or the session ended replaces it: there is nothing left to
 * show, and no retry fixes it.
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
): { state: TaskState; refresh: () => void } {
  const [state, setState] = useState<TaskState>({ kind: 'loading' });
  // Each fetch takes the next number; an answer for any number but the newest
  // is dropped, so a slow first answer cannot overwrite a faster refresh's.
  const latest = useRef(0);

  const load = useCallback(() => {
    const mine = ++latest.current;
    workspaceApi.task(agentId, routineId).then(
      (detail) => {
        if (latest.current !== mine) return;
        setState({ kind: 'ready', detail, refreshing: false, refreshFailed: false });
      },
      (e: unknown) => {
        if (latest.current !== mine) return;
        logRequestFailure(e, 'workspace-task');
        const error: TaskReadError = toReadOutcome(e);
        setState((s) =>
          s.kind === 'ready' && error === 'failed'
            ? { ...s, refreshing: false, refreshFailed: true }
            : { kind: 'failed', error },
        );
      },
    );
  }, [agentId, routineId]);

  useEffect(() => {
    load();
    return () => {
      latest.current++;
    };
  }, [load]);

  const refresh = useCallback(() => {
    setState((s) => (s.kind === 'ready' ? { ...s, refreshing: true } : { kind: 'loading' }));
    load();
  }, [load]);

  return { state, refresh };
}
