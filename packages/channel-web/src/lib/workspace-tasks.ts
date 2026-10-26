/**
 * The Tasks page's read (TASK-909): `GET /api/workspace/tasks` as a small state
 * machine.
 *
 * The shell owns it (TASK-933; TASK-909 decisions row 10 had it inside
 * `TasksPage`), so one read serves Today, the sidebar badge and the Tasks page.
 * The shell reads it at mount, again on entering Today or Tasks, after a
 * reply sent from Today, when a Duplicate answer lands after the person
 * left the source task (TASK-953), and when an approved routine change goes
 * through (TASK-939). It doesn't poll.
 *
 * Two ways to read again. `retry` (Try again, entering Today or Tasks) joins a
 * read already in flight instead of starting another: a read can take up to
 * 10 s when an agent's routines hang, and restarting it on every click or
 * route change would drop each answer before it lands. `reload` (after a
 * reply, on coming back from a task or check-in page, where a reply,
 * Pause or Resume may have happened, when a Duplicate answer lands after
 * the person left the source task, and when an approved routine change goes
 * through) always starts a fresh read, because the
 * one in flight may predate it; the newer answer wins.
 *
 * A read that never answers fails after `TASKS_READ_TIMEOUT_MS`, like any
 * other failure: without it, `retry` would join that read forever, so Try
 * again would stay disabled and entering Today or Tasks would read nothing.
 *
 * Two kinds of failure, because the page says two different things: a 401 is
 * "sign in again" (`expired`); everything else, a 404 from a host that predates
 * the route included, is "couldn't load" with Try again (`failed`). The list
 * route never answers 403 or 404 itself, so `gone` has nothing to mean here.
 *
 * A Try again that fails while rows are on screen keeps them, marked
 * `refreshFailed`, the way the activity feed keeps its rows: wiping a list the
 * person was reading to say "couldn't load" throws away the last good answer.
 * An expired session still clears them, because there is nothing to retry.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { logRequestFailure } from './http';
import { toReadOutcome } from './read-register';
import { workspaceApi } from './workspace-api';
import type { TaskRow, UnavailableAgent } from './workspace-types';

export type TasksReadError = 'expired' | 'failed';

/**
 * How long a tasks read may take before it counts as failed. A backstop, not a
 * guarantee: it is longer than the server's cap on each agent's own read
 * (`TASKS_AGENT_READ_DEADLINE_MS`), but that cap covers only the per-agent reads
 * (auth and the agent list run before it, uncapped), so a slow server can still
 * outlast this timer and the person gets the failure with Try again.
 */
export const TASKS_READ_TIMEOUT_MS = 15_000;

/** A tasks read that hasn't answered in `TASKS_READ_TIMEOUT_MS`. */
class TasksReadTimeoutError extends Error {
  constructor() {
    super(`The tasks read didn't answer within ${TASKS_READ_TIMEOUT_MS} ms.`);
    this.name = 'TasksReadTimeoutError';
  }
}

export type TasksState =
  | {
      kind: 'loading';
      /**
       * The failure this read is retrying after (TASK-933), null for the first
       * read. Today keeps saying it couldn't check until a read lands, as the
       * grants and decisions reads do; the Tasks page ignores it and shows its
       * spinner.
       */
      retryingAfter: TasksReadError | null;
    }
  | {
      kind: 'ready';
      tasks: TaskRow[];
      unavailableAgents: UnavailableAgent[];
      /** A Try again is in flight; the rows on screen are the last good answer. */
      refreshing: boolean;
      /** The last Try again failed; the rows on screen are the last good answer. */
      refreshFailed: boolean;
    }
  | { kind: 'failed'; error: TasksReadError };

export function useTasks(): {
  state: TasksState;
  /** Read again, unless a read is already in flight: then wait for that one. */
  retry: () => void;
  /** Read again now, even with a read in flight (its answer is dropped). */
  reload: () => void;
} {
  const [state, setState] = useState<TasksState>({
    kind: 'loading',
    retryingAfter: null,
  });
  // Each fetch takes the next number; an answer for any number but the newest
  // is dropped, so a slow first answer cannot overwrite a faster retry's.
  const latest = useRef(0);
  // Whether the newest fetch is still out. A ref, not state: two clicks in one
  // event loop turn must see the first one's read.
  const inFlight = useRef(false);
  // The newest read's clock (see TASKS_READ_TIMEOUT_MS).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const load = useCallback(() => {
    const mine = ++latest.current;
    inFlight.current = true;
    // A superseded read's answer is dropped by the counter, so its clock can go.
    stopTimer();
    const timedOut = new Promise<never>((_, reject) => {
      timer.current = setTimeout(() => reject(new TasksReadTimeoutError()), TASKS_READ_TIMEOUT_MS);
    });
    Promise.race([workspaceApi.tasks(), timedOut]).then(
      (page) => {
        if (latest.current !== mine) return;
        stopTimer();
        inFlight.current = false;
        setState({
          kind: 'ready',
          tasks: page.tasks,
          unavailableAgents: page.unavailableAgents,
          refreshing: false,
          refreshFailed: false,
        });
      },
      (e: unknown) => {
        if (latest.current !== mine) return;
        stopTimer();
        inFlight.current = false;
        logRequestFailure(e, 'workspace-tasks');
        const error: TasksReadError = toReadOutcome(e) === 'expired' ? 'expired' : 'failed';
        setState((s) =>
          s.kind === 'ready' && error === 'failed'
            ? { ...s, refreshing: false, refreshFailed: true }
            : { kind: 'failed', error },
        );
      },
    );
  }, [stopTimer]);

  useEffect(() => {
    load();
    return () => {
      latest.current++;
      inFlight.current = false;
      stopTimer();
    };
  }, [load, stopTimer]);

  const reload = useCallback(() => {
    setState((s) => {
      if (s.kind === 'ready') return { ...s, refreshing: true };
      // A retry keeps the failure it is retrying after, so Today never drops
      // to "nothing is waiting" while the read is in flight (TASK-933).
      return {
        kind: 'loading',
        retryingAfter: s.kind === 'failed' ? s.error : s.retryingAfter,
      };
    });
    load();
  }, [load]);

  const retry = useCallback(() => {
    if (inFlight.current) return;
    reload();
  }, [reload]);

  return { state, retry, reload };
}

/**
 * What Today and the badge read from the tasks state (TASK-933): the rows (the
 * last good answer), the agents it couldn't read, and whether the read failed.
 * The first load reads as no rows and no error; a retry after a failure keeps
 * that failure until a read lands. A failed refresh with rows on screen is
 * `failed` too, and keeps the rows: they may be out of date. `refreshing` says a
 * read is in flight, so Today holds its Try again until it lands. `checking` is
 * true until the first read lands (a reload during it included). Until then
 * Today doesn't know whether any task needs the person, so it says it is still
 * checking (TASK-939). A retry after a failure isn't checking: it keeps
 * reporting the failure.
 */
export function tasksForToday(state: TasksState): {
  tasks: TaskRow[];
  unavailableAgents: UnavailableAgent[];
  error: TasksReadError | null;
  refreshing: boolean;
  checking: boolean;
} {
  switch (state.kind) {
    case 'loading':
      return { tasks: [], unavailableAgents: [], error: state.retryingAfter, refreshing: true, checking: state.retryingAfter === null };
    case 'ready':
      return {
        tasks: state.tasks,
        unavailableAgents: state.unavailableAgents,
        error: state.refreshFailed ? 'failed' : null,
        refreshing: state.refreshing,
        checking: false,
      };
    case 'failed':
      return { tasks: [], unavailableAgents: [], error: state.error, refreshing: false, checking: false };
  }
}
