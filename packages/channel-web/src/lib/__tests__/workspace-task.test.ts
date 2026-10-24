/**
 * `useTask`: a task page's read, as a state machine (TASK-910).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError } from '../workspace-api';
import type { TaskDetail, TaskStep } from '../workspace-types';
import { useTask } from '../workspace-task';

vi.mock('../workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../workspace-api');
  return {
    ...actual,
    workspaceApi: { task: vi.fn() },
  };
});

const taskMock = vi.mocked(workspaceApi.task);

function detail(name: string, over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    agentName: 'Quill',
    name,
    kind: 'stay-on-top',
    enabled: true,
    revision: 'rev-1',
    permissions: { fire: true, stop: true, edit: true },
    schedule: 'every hour',
    nextCheckAt: null,
    brief: { promptBody: null, goodWhen: null },
    task: null,
    steps: [],
    noRecentUpdate: null,
    updates: [],
    replies: [],
    ...over,
  };
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

const PATH = '/tasks/a1/t1';

beforeEach(() => {
  taskMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('useTask (TASK-910)', () => {
  it('starts loading, then holds the task', async () => {
    const d = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(d.promise);
    const { result } = renderHook(() => useTask('a1', 't1'));
    expect(result.current.state).toEqual({ kind: 'loading' });
    const body = detail('Sweep');
    await act(async () => d.resolve(body));
    expect(result.current.state).toEqual({
      kind: 'ready',
      detail: body,
      refreshing: false,
      refreshFailed: false,
    });
    expect(taskMock).toHaveBeenCalledTimes(1);
    expect(taskMock).toHaveBeenCalledWith('a1', 't1');
  });

  it('calls a 401 expired, a 404 gone and anything else failed', async () => {
    for (const [failure, error] of [
      [new WorkspaceApiError(PATH, 401), 'expired'],
      [new WorkspaceApiError(PATH, 404), 'gone'],
      [new WorkspaceApiError(PATH, 500), 'failed'],
      [new WorkspaceApiError(PATH, 503), 'failed'],
      [new TypeError('Failed to fetch'), 'failed'],
    ] as const) {
      taskMock.mockRejectedValueOnce(failure);
      const { result, unmount } = renderHook(() => useTask('a1', 't1'));
      await waitFor(() => expect(result.current.state).toEqual({ kind: 'failed', error }));
      unmount();
    }
  });

  it('a Try again after a failed read goes back through loading', async () => {
    taskMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 500));
    const { result } = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));

    const d = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(d.promise);
    act(() => result.current.refresh());
    expect(result.current.state).toEqual({ kind: 'loading' });
    await act(async () => d.resolve(detail('Sweep')));
    expect(result.current.state.kind).toBe('ready');
  });

  it('refreshes in place, keeping the task on screen', async () => {
    const first = detail('Sweep');
    taskMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    const d = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(d.promise);
    act(() => result.current.refresh());
    expect(result.current.state).toEqual({
      kind: 'ready',
      detail: first,
      refreshing: true,
      refreshFailed: false,
    });

    const second = detail('Sweep', { enabled: false, revision: 'rev-2' });
    await act(async () => d.resolve(second));
    expect(result.current.state).toEqual({
      kind: 'ready',
      detail: second,
      refreshing: false,
      refreshFailed: false,
    });
    expect(taskMock).toHaveBeenCalledTimes(2);
    expect(taskMock).toHaveBeenLastCalledWith('a1', 't1');
  });

  it('a refresh that fails keeps the task, marked', async () => {
    const first = detail('Sweep');
    taskMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    taskMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 503));
    await act(async () => result.current.refresh());
    expect(result.current.state).toEqual({
      kind: 'ready',
      detail: first,
      refreshing: false,
      refreshFailed: true,
    });

    // The next good answer clears the mark.
    const second = detail('Sweep', { revision: 'rev-2' });
    taskMock.mockResolvedValueOnce(second);
    await act(async () => result.current.refresh());
    expect(result.current.state).toEqual({
      kind: 'ready',
      detail: second,
      refreshing: false,
      refreshFailed: false,
    });
  });

  it('a refresh that finds the task gone says gone', async () => {
    taskMock.mockResolvedValueOnce(detail('Sweep'));
    const { result } = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    taskMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 404));
    await act(async () => result.current.refresh());
    expect(result.current.state).toEqual({ kind: 'failed', error: 'gone' });
  });

  it('a refresh that finds the session ended stops showing the task', async () => {
    taskMock.mockResolvedValueOnce(detail('Sweep'));
    const { result } = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    taskMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 401));
    await act(async () => result.current.refresh());
    expect(result.current.state).toEqual({ kind: 'failed', error: 'expired' });
  });

  it('a quiet re-read keeps the task on screen without marking it refreshing, and a failed one leaves it as it was', async () => {
    const first = detail('Sweep');
    taskMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    const d = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(d.promise);
    act(() => result.current.refreshQuietly());
    expect(result.current.state).toEqual({
      kind: 'ready',
      detail: first,
      refreshing: false,
      refreshFailed: false,
    });
    const second = detail('Sweep', { revision: 'rev-2' });
    await act(async () => d.resolve(second));
    expect(result.current.state).toEqual({
      kind: 'ready',
      detail: second,
      refreshing: false,
      refreshFailed: false,
    });

    const before = result.current.state;
    taskMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 503));
    await act(async () => result.current.refreshQuietly());
    expect(result.current.state).toBe(before);
    expect(taskMock).toHaveBeenCalledTimes(3);
  });

  it('three failed quiet re-reads in a row say so; one or two don’t', async () => {
    const first = detail('Sweep');
    taskMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    const before = result.current.state;
    for (let i = 0; i < 2; i++) {
      taskMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 503));
      await act(async () => result.current.refreshQuietly());
      expect(result.current.state).toBe(before);
    }
    taskMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(async () => result.current.refreshQuietly());
    expect(result.current.state).toEqual({
      kind: 'ready',
      detail: first,
      refreshing: false,
      refreshFailed: true,
    });
  });

  it('a good read starts the count of failed quiet re-reads again', async () => {
    const first = detail('Sweep');
    taskMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    for (let i = 0; i < 2; i++) {
      taskMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 503));
      await act(async () => result.current.refreshQuietly());
    }
    const second = detail('Sweep', { revision: 'rev-2' });
    taskMock.mockResolvedValueOnce(second);
    await act(async () => result.current.refreshQuietly());

    const settled = result.current.state;
    for (let i = 0; i < 2; i++) {
      taskMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 503));
      await act(async () => result.current.refreshQuietly());
      expect(result.current.state).toBe(settled);
    }
    expect(settled).toEqual({ kind: 'ready', detail: second, refreshing: false, refreshFailed: false });
  });

  it.each([
    { status: 404, error: 'gone' },
    { status: 401, error: 'expired' },
  ] as const)(
    'a quiet re-read that finds the task gone or the session ended replaces it: $error',
    async ({ status, error }) => {
      taskMock.mockResolvedValueOnce(detail('Sweep'));
      const { result } = renderHook(() => useTask('a1', 't1'));
      await waitFor(() => expect(result.current.state.kind).toBe('ready'));

      taskMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, status));
      await act(async () => result.current.refreshQuietly());
      expect(result.current.state).toEqual({ kind: 'failed', error });
    },
  );

  it('a quiet re-read while a refresh is in flight reads nothing, and the refresh answers', async () => {
    // A quiet read that overtook the refresh (after Pause or Resume) would
    // drop the refresh's answer as the older one; if it then failed, the page
    // would keep the state from before the press.
    const first = detail('Sweep');
    taskMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    const loud = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(loud.promise);
    act(() => result.current.refresh());
    act(() => result.current.refreshQuietly());
    expect(taskMock).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({ kind: 'ready', refreshing: true });
    const second = detail('Sweep', { enabled: false, revision: 'rev-2' });
    await act(async () => loud.resolve(second));
    expect(result.current.state).toEqual({
      kind: 'ready',
      detail: second,
      refreshing: false,
      refreshFailed: false,
    });

    // Once the refresh has answered, quiet reads read again.
    taskMock.mockResolvedValueOnce(second);
    await act(async () => result.current.refreshQuietly());
    expect(taskMock).toHaveBeenCalledTimes(3);
  });

  it('a quiet re-read after a failed refresh reads again', async () => {
    taskMock.mockResolvedValueOnce(detail('Sweep'));
    const { result } = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    taskMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 503));
    await act(async () => result.current.refresh());
    taskMock.mockResolvedValueOnce(detail('Sweep', { revision: 'rev-2' }));
    await act(async () => result.current.refreshQuietly());
    expect(taskMock).toHaveBeenCalledTimes(3);
    expect(result.current.state).toMatchObject({ kind: 'ready', refreshFailed: false });
  });

  it('drops an older answer that lands after a newer one', async () => {
    const d1 = deferred<TaskDetail>();
    const d2 = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const { result } = renderHook(() => useTask('a1', 't1'));
    act(() => result.current.refresh());

    const newer = detail('Sweep', { revision: 'rev-2' });
    await act(async () => d2.resolve(newer));
    await act(async () => d1.resolve(detail('Sweep', { revision: 'rev-1' })));
    expect(result.current.state).toMatchObject({ kind: 'ready', detail: newer });
  });

  it('drops an older failure that lands after a newer answer', async () => {
    const d1 = deferred<TaskDetail>();
    const d2 = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const { result } = renderHook(() => useTask('a1', 't1'));
    act(() => result.current.refresh());

    await act(async () => d2.resolve(detail('Sweep')));
    await act(async () => d1.reject(new WorkspaceApiError(PATH, 404)));
    // A stale failure must not replace, or mark, the newer good answer.
    expect(result.current.state).toMatchObject({ kind: 'ready', refreshFailed: false });
  });
});

describe('useTask replaceSteps (TASK-949)', () => {
  const stepsOf = (...ids: string[]): TaskStep[] =>
    ids.map((id) => ({ id, text: `Step ${id}`, done: false, byAgent: false }));

  async function ready(first: TaskDetail) {
    taskMock.mockResolvedValueOnce(first);
    const hook = renderHook(() => useTask('a1', 't1'));
    await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
    return hook;
  }

  it('swaps a ready task’s steps and keeps the rest, updates included', async () => {
    const first = detail('Sweep', { steps: stepsOf('a') });
    const { result } = await ready(first);
    const next = stepsOf('b', 'c');
    act(() => result.current.replaceSteps(next));
    expect(result.current.state).toEqual({
      kind: 'ready',
      detail: { ...first, steps: next },
      refreshing: false,
      refreshFailed: false,
    });
    const s = result.current.state;
    expect(s.kind === 'ready' && s.detail.updates).toBe(first.updates);
    expect(taskMock).toHaveBeenCalledTimes(1);
  });

  it('a read that started before replaceSteps keeps the replaced steps, and shows the rest of its answer', async () => {
    const { result } = await ready(detail('Sweep', { steps: stepsOf('a') }));
    const read = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(read.promise);
    act(() => result.current.refreshQuietly());
    const mine = stepsOf('b');
    act(() => result.current.replaceSteps(mine));
    // The extra quiet read is still out, so what shows is the stale read's answer alone.
    taskMock.mockReturnValueOnce(deferred<TaskDetail>().promise);
    await act(async () => read.resolve(detail('Renamed', { steps: stepsOf('a') })));
    expect(result.current.state).toMatchObject({
      kind: 'ready',
      detail: { name: 'Renamed', steps: mine },
    });
  });

  it('a read whose steps it kept asks for one more quiet read, and that read’s steps show', async () => {
    const { result } = await ready(detail('Sweep', { steps: stepsOf('a') }));
    const read = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(read.promise);
    act(() => result.current.refreshQuietly());
    act(() => result.current.replaceSteps(stepsOf('b')));
    const again = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(again.promise);
    await act(async () => read.resolve(detail('Sweep', { steps: stepsOf('a') })));
    expect(taskMock).toHaveBeenCalledTimes(3);
    const newest = stepsOf('c');
    await act(async () => again.resolve(detail('Sweep', { steps: newest })));
    expect(result.current.state).toMatchObject({ kind: 'ready', detail: { steps: newest } });
    expect(taskMock).toHaveBeenCalledTimes(3);
  });

  it('a read that started after replaceSteps shows its own steps, and asks for no other', async () => {
    const { result } = await ready(detail('Sweep', { steps: stepsOf('a') }));
    act(() => result.current.replaceSteps(stepsOf('b')));
    const own = stepsOf('c');
    taskMock.mockResolvedValueOnce(detail('Sweep', { steps: own }));
    await act(async () => result.current.refreshQuietly());
    expect(result.current.state).toMatchObject({ kind: 'ready', detail: { steps: own } });
    expect(taskMock).toHaveBeenCalledTimes(2);
  });

  it('replaceSteps before the task loads does nothing', async () => {
    const d = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(d.promise);
    const { result } = renderHook(() => useTask('a1', 't1'));
    act(() => result.current.replaceSteps(stepsOf('b')));
    expect(result.current.state).toEqual({ kind: 'loading' });
    const own = stepsOf('a');
    await act(async () => d.resolve(detail('Sweep', { steps: own })));
    expect(result.current.state).toMatchObject({ kind: 'ready', detail: { steps: own } });
    expect(taskMock).toHaveBeenCalledTimes(1);
  });
});
