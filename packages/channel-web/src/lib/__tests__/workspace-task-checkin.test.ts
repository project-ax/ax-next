/**
 * `useTaskCheckin`: a check-in page's read, as a state machine (TASK-911).
 * `useTask`'s tests (`workspace-task.test.ts`), with the task renamed to a check-in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError } from '../workspace-api';
import type { TaskCheckin } from '../workspace-types';
import { useTaskCheckin } from '../workspace-task-checkin';

vi.mock('../workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../workspace-api');
  return {
    ...actual,
    workspaceApi: { taskCheckin: vi.fn() },
  };
});

const checkinMock = vi.mocked(workspaceApi.taskCheckin);

function page(taskName: string, over: Partial<TaskCheckin> = {}): TaskCheckin {
  return {
    taskName,
    agentName: 'Quill',
    checkIn: {
      firedAt: '2026-10-22T12:00:00.000Z',
      status: 'ok',
      error: null,
      report: null,
      conversationId: 'c1',
    },
    triggerSource: 'tick',
    thread: [],
    decisions: { status: 'ok' },
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

const PATH = '/tasks/a1/t1/checkins/c1';

beforeEach(() => {
  checkinMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('useTaskCheckin (TASK-911)', () => {
  it('starts loading, then holds the check-in', async () => {
    const d = deferred<TaskCheckin>();
    checkinMock.mockReturnValueOnce(d.promise);
    const { result } = renderHook(() => useTaskCheckin('a1', 't1', 'c1'));
    expect(result.current.state).toEqual({ kind: 'loading' });
    const body = page('Sweep');
    await act(async () => d.resolve(body));
    expect(result.current.state).toEqual({
      kind: 'ready',
      page: body,
      refreshing: false,
      refreshFailed: false,
    });
    expect(checkinMock).toHaveBeenCalledTimes(1);
    expect(checkinMock).toHaveBeenCalledWith('a1', 't1', 'c1');
  });

  it('calls a 401 expired, a 404 gone and anything else failed', async () => {
    for (const [failure, error] of [
      [new WorkspaceApiError(PATH, 401), 'expired'],
      [new WorkspaceApiError(PATH, 404), 'gone'],
      [new WorkspaceApiError(PATH, 500), 'failed'],
      [new WorkspaceApiError(PATH, 503), 'failed'],
      [new TypeError('Failed to fetch'), 'failed'],
    ] as const) {
      checkinMock.mockRejectedValueOnce(failure);
      const { result, unmount } = renderHook(() => useTaskCheckin('a1', 't1', 'c1'));
      await waitFor(() => expect(result.current.state).toEqual({ kind: 'failed', error }));
      unmount();
    }
  });

  it('a Try again after a failed read goes back through loading', async () => {
    checkinMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 500));
    const { result } = renderHook(() => useTaskCheckin('a1', 't1', 'c1'));
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));

    const d = deferred<TaskCheckin>();
    checkinMock.mockReturnValueOnce(d.promise);
    act(() => result.current.refresh());
    expect(result.current.state).toEqual({ kind: 'loading' });
    await act(async () => d.resolve(page('Sweep')));
    expect(result.current.state.kind).toBe('ready');
  });

  it('refreshes in place, keeping the transcript on screen', async () => {
    const first = page('Sweep');
    checkinMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTaskCheckin('a1', 't1', 'c1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    const d = deferred<TaskCheckin>();
    checkinMock.mockReturnValueOnce(d.promise);
    act(() => result.current.refresh());
    expect(result.current.state).toEqual({
      kind: 'ready',
      page: first,
      refreshing: true,
      refreshFailed: false,
    });

    const second = page('Sweep', { decisions: { status: 'unavailable' } });
    await act(async () => d.resolve(second));
    expect(result.current.state).toEqual({
      kind: 'ready',
      page: second,
      refreshing: false,
      refreshFailed: false,
    });
    expect(checkinMock).toHaveBeenCalledTimes(2);
    expect(checkinMock).toHaveBeenLastCalledWith('a1', 't1', 'c1');
  });

  it('a refresh that fails keeps the transcript, marked', async () => {
    const first = page('Sweep');
    checkinMock.mockResolvedValueOnce(first);
    const { result } = renderHook(() => useTaskCheckin('a1', 't1', 'c1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    checkinMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 503));
    await act(async () => result.current.refresh());
    expect(result.current.state).toEqual({
      kind: 'ready',
      page: first,
      refreshing: false,
      refreshFailed: true,
    });

    // The next good answer clears the mark.
    const second = page('Sweep', { decisions: { status: 'failed' } });
    checkinMock.mockResolvedValueOnce(second);
    await act(async () => result.current.refresh());
    expect(result.current.state).toEqual({
      kind: 'ready',
      page: second,
      refreshing: false,
      refreshFailed: false,
    });
  });

  it('a refresh that finds the check-in gone says gone', async () => {
    checkinMock.mockResolvedValueOnce(page('Sweep'));
    const { result } = renderHook(() => useTaskCheckin('a1', 't1', 'c1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    checkinMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 404));
    await act(async () => result.current.refresh());
    expect(result.current.state).toEqual({ kind: 'failed', error: 'gone' });
  });

  it('a refresh that finds the session ended stops showing the transcript', async () => {
    checkinMock.mockResolvedValueOnce(page('Sweep'));
    const { result } = renderHook(() => useTaskCheckin('a1', 't1', 'c1'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    checkinMock.mockRejectedValueOnce(new WorkspaceApiError(PATH, 401));
    await act(async () => result.current.refresh());
    expect(result.current.state).toEqual({ kind: 'failed', error: 'expired' });
  });

  it('drops an older answer that lands after a newer one', async () => {
    const d1 = deferred<TaskCheckin>();
    const d2 = deferred<TaskCheckin>();
    checkinMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const { result } = renderHook(() => useTaskCheckin('a1', 't1', 'c1'));
    act(() => result.current.refresh());

    const newer = page('Sweep', { decisions: { status: 'unavailable' } });
    await act(async () => d2.resolve(newer));
    await act(async () => d1.resolve(page('Sweep', { decisions: { status: 'failed' } })));
    expect(result.current.state).toMatchObject({ kind: 'ready', page: newer });
  });

  it('drops an older failure that lands after a newer answer', async () => {
    const d1 = deferred<TaskCheckin>();
    const d2 = deferred<TaskCheckin>();
    checkinMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const { result } = renderHook(() => useTaskCheckin('a1', 't1', 'c1'));
    act(() => result.current.refresh());

    await act(async () => d2.resolve(page('Sweep')));
    await act(async () => d1.reject(new WorkspaceApiError(PATH, 404)));
    // A stale failure must not replace, or mark, the newer good answer.
    expect(result.current.state).toMatchObject({ kind: 'ready', refreshFailed: false });
  });
});
