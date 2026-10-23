/**
 * A check-in page's read (TASK-911): `GET /api/workspace/tasks/:agentId/
 * :routineId/checkins/:conversationId` as a small state machine, `useTask`
 * (`workspace-task.ts`) for one check-in.
 *
 * The same three failures, for the same reasons (`toReadOutcome`): a 401 is
 * "sign in again" (`expired`); a 404 is "we couldn't find this check-in", with
 * no Try again (`gone`), since the route answers 404 alike for a check-in that
 * isn't there and one that isn't yours; everything else is "couldn't load"
 * with Try again (`failed`).
 *
 * A refresh keeps the transcript on screen while it runs. One that fails keeps
 * it, marked `refreshFailed`. One that finds the check-in gone or the session
 * ended replaces it: there is nothing left to show, and no retry fixes it.
 *
 * The ready state's field is `page`, not `checkin`, so it can't be mistyped as
 * the wire's `checkIn` (`state.page.checkIn`).
 *
 * It holds one check-in. Mount it once per check-in (key the page by its ids):
 * since a refresh keeps what's on screen, state carried over from another
 * check-in would show that transcript while this one loads.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { logRequestFailure } from './http';
import { toReadOutcome } from './read-register';
import { workspaceApi } from './workspace-api';
import type { TaskReadError } from './workspace-task';
import type { TaskCheckin } from './workspace-types';

export type TaskCheckinState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      page: TaskCheckin;
      /** A refresh is in flight; the transcript on screen is the last good answer. */
      refreshing: boolean;
      /** The last refresh failed; the transcript on screen is the last good answer. */
      refreshFailed: boolean;
    }
  | { kind: 'failed'; error: TaskReadError };

export function useTaskCheckin(
  agentId: string,
  routineId: string,
  conversationId: string,
): { state: TaskCheckinState; refresh: () => void } {
  const [state, setState] = useState<TaskCheckinState>({ kind: 'loading' });
  // Each fetch takes the next number; an answer for any number but the newest
  // is dropped, so a slow first answer cannot overwrite a faster refresh's.
  const latest = useRef(0);

  const load = useCallback(() => {
    const mine = ++latest.current;
    workspaceApi.taskCheckin(agentId, routineId, conversationId).then(
      (page) => {
        if (latest.current !== mine) return;
        setState({ kind: 'ready', page, refreshing: false, refreshFailed: false });
      },
      (e: unknown) => {
        if (latest.current !== mine) return;
        logRequestFailure(e, 'workspace-task-checkin');
        const error: TaskReadError = toReadOutcome(e);
        setState((s) =>
          s.kind === 'ready' && error === 'failed'
            ? { ...s, refreshing: false, refreshFailed: true }
            : { kind: 'failed', error },
        );
      },
    );
  }, [agentId, routineId, conversationId]);

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
