/**
 * `useTasks` — the Tasks page's read, as a state machine (TASK-909).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError } from '../workspace-api';
import type { TaskRow, TasksResponse } from '../workspace-types';
import { tasksForToday, useTasks, type TasksState } from '../workspace-tasks';

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
    act(() => result.current.retry());

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
    act(() => result.current.retry());

    await act(async () => d2.resolve(page('B')));
    await act(async () => d1.reject(new WorkspaceApiError('/tasks', 500)));
    // A stale failure must not mark the newer, good answer as out of date.
    expect(result.current.state).toMatchObject({ kind: 'ready', refreshFailed: false });
  });
});

describe('tasksForToday (TASK-933)', () => {
  const ADA = { agentId: 'a-ada', agentName: 'Ada' };
  const rows = [row('r-1', 'Sweep')];

  it('reads the first load as no rows and no error', () => {
    const state: TasksState = { kind: 'loading', retryingAfter: null };
    expect(tasksForToday(state)).toEqual({ tasks: [], unavailableAgents: [], error: null });
  });

  it('keeps reporting the failure a retry is retrying after, until a read lands', () => {
    const state: TasksState = { kind: 'loading', retryingAfter: 'failed' };
    expect(tasksForToday(state)).toEqual({ tasks: [], unavailableAgents: [], error: 'failed' });
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
    expect(tasksForToday(state)).toEqual({ tasks: rows, unavailableAgents: [ADA], error: null });
  });

  it('keeps the rows of a failed refresh, and says it failed', () => {
    const state: TasksState = {
      kind: 'ready',
      tasks: rows,
      unavailableAgents: [ADA],
      refreshing: false,
      refreshFailed: true,
    };
    expect(tasksForToday(state)).toEqual({ tasks: rows, unavailableAgents: [ADA], error: 'failed' });
  });

  it('gives a failed read no rows and its error', () => {
    for (const error of ['expired', 'failed'] as const) {
      expect(tasksForToday({ kind: 'failed', error })).toEqual({
        tasks: [],
        unavailableAgents: [],
        error,
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
