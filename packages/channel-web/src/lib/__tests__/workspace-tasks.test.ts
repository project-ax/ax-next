/**
 * `useTasks` — the Tasks page's read, as a state machine (TASK-909).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError } from '../workspace-api';
import type { TaskRow, TasksResponse } from '../workspace-types';
import { TASKS_AGENT_READ_DEADLINE_MS } from '../../server/routes-workspace';
import { TASKS_READ_TIMEOUT_MS, tasksForToday, useTasks, type TasksState } from '../workspace-tasks';

vi.mock('../workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../workspace-api');
  return {
    ...actual,
    workspaceApi: { tasks: vi.fn() },
  };
});

const tasksMock = vi.mocked(workspaceApi.tasks);

function row(routineId: string, name: string): TaskRow {
  return { agentId: 'a-quill', agentName: 'Quill', routineId, name, enabled: true, task: null, noRecentUpdate: null };
}

function page(...names: string[]): TasksResponse {
  return { tasks: names.map((n, i) => row(`r-${n}-${i}`, n)), unavailableAgents: [] };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  tasksMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('useTasks (TASK-909)', () => {
  it('starts loading, then holds the page', async () => {
    const d = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(d.promise);
    const { result } = renderHook(() => useTasks());
    expect(result.current.state).toEqual({ kind: 'loading', retryingAfter: null });
    const body: TasksResponse = {
      tasks: [row('r-1', 'Sweep')],
      unavailableAgents: [{ agentId: 'a-ada', agentName: 'Ada' }],
    };
    await act(async () => d.resolve(body));
    expect(result.current.state).toEqual({
      kind: 'ready',
      tasks: body.tasks,
      unavailableAgents: body.unavailableAgents,
      refreshing: false,
      refreshFailed: false,
    });
    expect(tasksMock).toHaveBeenCalledTimes(1);
  });

  it('calls a 401 expired and anything else failed', async () => {
    for (const [status, error] of [
      [401, 'expired'],
      [500, 'failed'],
      [404, 'failed'],
    ] as const) {
      tasksMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks', status));
      const { result, unmount } = renderHook(() => useTasks());
      await waitFor(() => expect(result.current.state).toEqual({ kind: 'failed', error }));
      unmount();
    }
  });

  it('calls a non-HTTP failure failed', async () => {
    tasksMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'failed', error: 'failed' }));
  });

  it('retries from a failure through loading', async () => {
    tasksMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks', 500));
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));

    const d = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(d.promise);
    act(() => result.current.retry());
    expect(result.current.state).toEqual({ kind: 'loading', retryingAfter: 'failed' });
    await act(async () => d.resolve(page('Sweep')));
    expect(result.current.state.kind).toBe('ready');
  });

  it('refreshes in place, keeping the rows on screen', async () => {
    const first = page('Sweep');
    tasksMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    const d = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(d.promise);
    act(() => result.current.retry());
    expect(result.current.state).toEqual({
      kind: 'ready',
      tasks: first.tasks,
      unavailableAgents: [],
      refreshing: true,
      refreshFailed: false,
    });

    const second = page('Sweep', 'Digest');
    await act(async () => d.resolve(second));
    expect(result.current.state).toEqual({
      kind: 'ready',
      tasks: second.tasks,
      unavailableAgents: [],
      refreshing: false,
      refreshFailed: false,
    });
  });

  it('keeps the rows on screen when a refresh fails, and says so', async () => {
    const first: TasksResponse = {
      tasks: [row('r-1', 'Sweep')],
      unavailableAgents: [{ agentId: 'a-ada', agentName: 'Ada' }],
    };
    tasksMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    tasksMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks', 503));
    await act(async () => result.current.retry());
    expect(result.current.state).toEqual({
      kind: 'ready',
      tasks: first.tasks,
      unavailableAgents: first.unavailableAgents,
      refreshing: false,
      refreshFailed: true,
    });

    // The next good answer clears the note.
    const second = page('Sweep');
    tasksMock.mockResolvedValueOnce(second);
    await act(async () => result.current.retry());
    expect(result.current.state).toEqual({
      kind: 'ready',
      tasks: second.tasks,
      unavailableAgents: [],
      refreshing: false,
      refreshFailed: false,
    });
  });

  it('stops showing the rows when a refresh finds the session ended', async () => {
    tasksMock.mockResolvedValueOnce(page('Sweep'));
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    tasksMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks', 401));
    await act(async () => result.current.retry());
    expect(result.current.state).toEqual({ kind: 'failed', error: 'expired' });
  });

  it('drops an older answer that lands after a newer one', async () => {
    const d1 = deferred<TasksResponse>();
    const d2 = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const { result } = renderHook(() => useTasks());
    act(() => result.current.reload());

    const b = page('B');
    await act(async () => d2.resolve(b));
    await act(async () => d1.resolve(page('A')));
    expect(result.current.state).toMatchObject({ kind: 'ready', tasks: b.tasks });
  });

  it('drops an older failure that lands after a newer answer', async () => {
    const d1 = deferred<TasksResponse>();
    const d2 = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const { result } = renderHook(() => useTasks());
    act(() => result.current.reload());

    await act(async () => d2.resolve(page('B')));
    await act(async () => d1.reject(new WorkspaceApiError('/tasks', 500)));
    // A stale failure must not mark the newer, good answer as out of date.
    expect(result.current.state).toMatchObject({ kind: 'ready', refreshFailed: false });
  });
});

describe('a re-read while a read is in flight (TASK-933 review)', () => {
  it('a Try again during the first read joins it: one request, and its answer lands', async () => {
    const d = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(d.promise).mockResolvedValue(page('Later'));
    const { result } = renderHook(() => useTasks());
    act(() => result.current.retry());
    act(() => result.current.retry());
    expect(tasksMock).toHaveBeenCalledTimes(1);
    const first = page('Sweep');
    await act(async () => d.resolve(first));
    expect(result.current.state).toMatchObject({ kind: 'ready', tasks: first.tasks });
  });

  it('two Try agains after a failure send one request, and its answer lands', async () => {
    tasksMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks', 500));
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));

    const d = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(d.promise).mockResolvedValue(page('Later'));
    act(() => result.current.retry());
    act(() => result.current.retry());
    expect(tasksMock).toHaveBeenCalledTimes(2);
    // Still saying it couldn't check while the one read runs.
    expect(result.current.state).toEqual({ kind: 'loading', retryingAfter: 'failed' });
    const answer = page('Sweep');
    await act(async () => d.resolve(answer));
    expect(result.current.state).toMatchObject({ kind: 'ready', tasks: answer.tasks });
  });

  it('a Try again during a refresh joins it too', async () => {
    tasksMock.mockResolvedValueOnce(page('Sweep'));
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    const d = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(d.promise).mockResolvedValue(page('Later'));
    act(() => result.current.retry());
    act(() => result.current.retry());
    expect(tasksMock).toHaveBeenCalledTimes(2);
    const answer = page('Sweep', 'Digest');
    await act(async () => d.resolve(answer));
    expect(result.current.state).toMatchObject({ kind: 'ready', tasks: answer.tasks, refreshing: false });
  });

  it('a reload during a read starts a fresh one, and its answer wins', async () => {
    tasksMock.mockResolvedValueOnce(page('Sweep'));
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    const before = deferred<TasksResponse>();
    const after = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
    act(() => result.current.retry());
    // A reply was sent: the read in flight may predate it.
    act(() => result.current.reload());
    expect(tasksMock).toHaveBeenCalledTimes(3);
    expect(result.current.state).toMatchObject({ kind: 'ready', refreshing: true });

    const fresh = page('Sweep', 'Replied');
    await act(async () => after.resolve(fresh));
    await act(async () => before.resolve(page('Stale')));
    expect(result.current.state).toMatchObject({
      kind: 'ready',
      tasks: fresh.tasks,
      refreshing: false,
    });
    // Nothing is in flight now, so the next Try again reads.
    tasksMock.mockResolvedValueOnce(page('Next'));
    await act(async () => result.current.retry());
    expect(tasksMock).toHaveBeenCalledTimes(4);
  });
});

describe('a superseded answer (TASK-933 review round 2)', () => {
  // The reload's read is still out when the older read's answer lands, so a
  // Try again then must join the reload, not start a third read: the older
  // answer says nothing about whether the newest read is done.
  it('landing late doesn’t end the newer read, so a Try again still joins it', async () => {
    const mount = deferred<TasksResponse>();
    const fresh = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(mount.promise).mockReturnValueOnce(fresh.promise).mockResolvedValue(page('Third'));
    const { result } = renderHook(() => useTasks());
    act(() => result.current.retry()); // joins the mount read
    act(() => result.current.reload()); // a fresh read: the mount read is superseded
    expect(tasksMock).toHaveBeenCalledTimes(2);

    await act(async () => mount.resolve(page('Stale')));
    act(() => result.current.retry());
    // Mount read + reload. A third call would mean the stale answer marked the
    // reload's read as done.
    expect(tasksMock).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual({ kind: 'loading', retryingAfter: null });

    const answer = page('Fresh');
    await act(async () => fresh.resolve(answer));
    expect(result.current.state).toMatchObject({ kind: 'ready', tasks: answer.tasks, refreshing: false });
  });
});

describe('a read that never settles (TASK-933 review)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // The server gives up on a slow agent at TASKS_AGENT_READ_DEADLINE_MS, so
  // the client waits longer than that before calling the read failed.
  it('waits longer than the server’s own per-agent deadline', () => {
    expect(TASKS_READ_TIMEOUT_MS).toBeGreaterThan(TASKS_AGENT_READ_DEADLINE_MS);
  });

  it('fails the read when it hasn’t answered in time, so Try again reads again', async () => {
    tasksMock.mockReturnValueOnce(new Promise<TasksResponse>(() => {}));
    const { result } = renderHook(() => useTasks());
    await act(async () => vi.advanceTimersByTimeAsync(TASKS_READ_TIMEOUT_MS - 1));
    expect(result.current.state).toEqual({ kind: 'loading', retryingAfter: null });

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(result.current.state).toEqual({ kind: 'failed', error: 'failed' });

    tasksMock.mockResolvedValueOnce(page('Sweep'));
    await act(async () => result.current.retry());
    expect(tasksMock).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({ kind: 'ready', tasks: page('Sweep').tasks });
  });

  it('keeps the rows on screen when a refresh times out, and says so', async () => {
    const first = page('Sweep');
    tasksMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTasks());
    await act(async () => {});
    expect(result.current.state.kind).toBe('ready');

    tasksMock.mockReturnValueOnce(new Promise<TasksResponse>(() => {}));
    act(() => result.current.retry());
    await act(async () => vi.advanceTimersByTimeAsync(TASKS_READ_TIMEOUT_MS));
    expect(result.current.state).toEqual({
      kind: 'ready',
      tasks: first.tasks,
      unavailableAgents: [],
      refreshing: false,
      refreshFailed: true,
    });
  });

  it('drops a timed-out read’s late answer, and a superseded read’s', async () => {
    const timedOut = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(timedOut.promise);
    const { result } = renderHook(() => useTasks());
    await act(async () => vi.advanceTimersByTimeAsync(TASKS_READ_TIMEOUT_MS));
    expect(result.current.state).toEqual({ kind: 'failed', error: 'failed' });

    // The race already settled as failed: the read's own late answer is dropped.
    await act(async () => timedOut.resolve(page('Too late')));
    expect(result.current.state).toEqual({ kind: 'failed', error: 'failed' });

    const superseded = deferred<TasksResponse>();
    const newest = deferred<TasksResponse>();
    tasksMock.mockReturnValueOnce(superseded.promise).mockReturnValueOnce(newest.promise);
    act(() => result.current.retry());
    act(() => result.current.reload());
    await act(async () => superseded.resolve(page('Superseded')));
    expect(result.current.state).toEqual({ kind: 'loading', retryingAfter: 'failed' });

    const answer = page('Newest');
    await act(async () => newest.resolve(answer));
    expect(result.current.state).toMatchObject({ kind: 'ready', tasks: answer.tasks });
  });

  it('stops the clock once the read answers, and on unmount', async () => {
    tasksMock.mockResolvedValueOnce(page('Sweep'));
    const { result, unmount } = renderHook(() => useTasks());
    await act(async () => {});
    expect(result.current.state.kind).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);

    tasksMock.mockReturnValueOnce(new Promise<TasksResponse>(() => {}));
    act(() => result.current.retry());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('tasksForToday (TASK-933)', () => {
  const ADA = { agentId: 'a-ada', agentName: 'Ada' };
  const rows = [row('r-1', 'Sweep')];

  it('reads the first load as no rows and no error, with a read running', () => {
    const state: TasksState = { kind: 'loading', retryingAfter: null };
    expect(tasksForToday(state)).toEqual({
      tasks: [],
      unavailableAgents: [],
      error: null,
      refreshing: true,
    });
  });

  it('keeps reporting the failure a retry is retrying after, until a read lands', () => {
    const state: TasksState = { kind: 'loading', retryingAfter: 'failed' };
    expect(tasksForToday(state)).toEqual({
      tasks: [],
      unavailableAgents: [],
      error: 'failed',
      refreshing: true,
    });
    const expired: TasksState = { kind: 'loading', retryingAfter: 'expired' };
    expect(tasksForToday(expired).error).toBe('expired');
  });

  it('gives a ready read its rows and agents, with no error', () => {
    const state: TasksState = {
      kind: 'ready',
      tasks: rows,
      unavailableAgents: [ADA],
      refreshing: true,
      refreshFailed: false,
    };
    expect(tasksForToday(state)).toEqual({
      tasks: rows,
      unavailableAgents: [ADA],
      error: null,
      refreshing: true,
    });
  });

  it('keeps the rows of a failed refresh, and says it failed', () => {
    const state: TasksState = {
      kind: 'ready',
      tasks: rows,
      unavailableAgents: [ADA],
      refreshing: false,
      refreshFailed: true,
    };
    expect(tasksForToday(state)).toEqual({
      tasks: rows,
      unavailableAgents: [ADA],
      error: 'failed',
      refreshing: false,
    });
  });

  it('gives a failed read no rows and its error', () => {
    for (const error of ['expired', 'failed'] as const) {
      expect(tasksForToday({ kind: 'failed', error })).toEqual({
        tasks: [],
        unavailableAgents: [],
        error,
        refreshing: false,
      });
    }
  });

  it('keeps the failure through a Try again that has not landed (the hook, end to end)', async () => {
    tasksMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks', 500));
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));

    tasksMock.mockReturnValueOnce(new Promise<TasksResponse>(() => {}));
    act(() => result.current.retry());
    expect(tasksForToday(result.current.state).error).toBe('failed');
    // A second retry while that read is still in flight keeps it too.
    tasksMock.mockReturnValueOnce(new Promise<TasksResponse>(() => {}));
    act(() => result.current.retry());
    expect(tasksForToday(result.current.state).error).toBe('failed');
  });
});
