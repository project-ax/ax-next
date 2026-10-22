/**
 * The Tasks page's read (TASK-909): `GET /api/workspace/tasks` as a small state
 * machine.
 *
 * It lives inside `TasksPage`, not the shell, so it only fetches while the
 * Tasks route is mounted (decisions row 12).
 *
 * Two kinds of failure, because the page says two different things: a 401 is
 * "sign in again" (`expired`); everything else, a 404 from a host that predates
 * the route included, is "couldn't load" with Try again (`failed`). The list
 * route never answers 403 or 404 itself, so `gone` has nothing to mean here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { logRequestFailure } from './http';
import { toReadOutcome } from './read-register';
import { workspaceApi } from './workspace-api';
import type { TaskRow, UnavailableAgent } from './workspace-types';

export type TasksReadError = 'expired' | 'failed';

export type TasksState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      tasks: TaskRow[];
      unavailableAgents: UnavailableAgent[];
      /** A Try again is in flight; the rows on screen are the last good answer. */
      refreshing: boolean;
    }
  | { kind: 'failed'; error: TasksReadError };

export function useTasks(): { state: TasksState; retry: () => void } {
  const [state, setState] = useState<TasksState>({ kind: 'loading' });
  // Each fetch takes the next number; an answer for any number but the newest
  // is dropped, so a slow first answer cannot overwrite a faster retry's.
  const latest = useRef(0);

  const load = useCallback(() => {
    const mine = ++latest.current;
    workspaceApi.tasks().then(
      (page) => {
        if (latest.current !== mine) return;
        setState({
          kind: 'ready',
          tasks: page.tasks,
          unavailableAgents: page.unavailableAgents,
          refreshing: false,
        });
      },
      (e: unknown) => {
        if (latest.current !== mine) return;
        logRequestFailure(e, 'workspace-tasks');
        setState({ kind: 'failed', error: toReadOutcome(e) === 'expired' ? 'expired' : 'failed' });
      },
    );
  }, []);

  useEffect(() => {
    load();
    return () => {
      latest.current++;
    };
  }, [load]);

  const retry = useCallback(() => {
    setState((s) => (s.kind === 'ready' ? { ...s, refreshing: true } : { kind: 'loading' }));
    load();
  }, [load]);

  return { state, retry };
}
