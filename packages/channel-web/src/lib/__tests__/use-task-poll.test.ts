/**
 * `useTaskPoll`: "Checking in now…" on a task page (TASK-931). After Check
 * now or a reply starts a check-in, the page re-reads the task every 10 s
 * until a check-in that wasn't there at the press shows up, for up to five
 * minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { TaskUpdate } from '../workspace-types';
import {
  arrivedCheckIn,
  TASK_POLL_CLOCK_SLACK_MS,
  TASK_POLL_INTERVAL_MS,
  TASK_POLL_LIMIT_MS,
  useTaskPoll,
} from '../use-task-poll';

const NOW = new Date(2026, 9, 23, 12, 0);
const EARLIER = new Date(2026, 9, 23, 11, 0).toISOString();

function update(firedAt: string, over: Partial<TaskUpdate> = {}): TaskUpdate {
  return {
    firedAt,
    status: 'ok',
    error: null,
    report: { status: 'on-track', update: 'All quiet.', reading: null },
    conversationId: null,
    ...over,
  };
}

const BEFORE = [update(EARLIER, { conversationId: 'c-old' })];

function setup(initial: readonly TaskUpdate[] | null = BEFORE) {
  const reread = vi.fn<() => void>();
  const view = renderHook(
    ({ updates }: { updates: readonly TaskUpdate[] | null }) => useTaskPoll(updates, reread),
    { initialProps: { updates: initial } },
  );
  return { ...view, reread };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('arrivedCheckIn (TASK-931)', () => {
  const at = NOW.getTime();

  it('finds the newest check-in that wasn’t there at the press', () => {
    const newer = update(new Date(at + 20_000).toISOString());
    const newest = update(new Date(at + 40_000).toISOString());
    const seen = new Set([`${EARLIER}|c-old`]);
    expect(arrivedCheckIn([newer, newest, ...BEFORE], { at, seen })).toBe(newest);
    expect(arrivedCheckIn(BEFORE, { at, seen })).toBeNull();
  });

  it('a check-in seen at the press is the same one, conversation and all', () => {
    const same = update(EARLIER, { conversationId: 'c-old' });
    const other = update(EARLIER, { conversationId: 'c-new' });
    const seen = new Set([`${EARLIER}|c-old`]);
    expect(arrivedCheckIn([same], { at: Date.parse(EARLIER), seen })).toBeNull();
    expect(arrivedCheckIn([other], { at: Date.parse(EARLIER), seen })).toBe(other);
  });

  it('a check-in whose time can’t be read never counts', () => {
    expect(arrivedCheckIn([update('not a time')], { at, seen: new Set() })).toBeNull();
  });
});

describe('useTaskPoll (TASK-931)', () => {
  it('starts idle and reads nothing', async () => {
    const { result, reread } = setup();
    expect(result.current).toMatchObject({ phase: 'idle', startedBy: null, arrived: null });
    await advance(60_000);
    expect(reread).not.toHaveBeenCalled();
  });

  it('re-reads every 10 seconds while checking', async () => {
    const { result, reread } = setup();
    act(() => result.current.start('check-now'));
    expect(result.current).toMatchObject({ phase: 'checking', startedBy: 'check-now' });
    expect(reread).not.toHaveBeenCalled();
    await advance(TASK_POLL_INTERVAL_MS - 1);
    expect(reread).not.toHaveBeenCalled();
    await advance(1);
    expect(reread).toHaveBeenCalledTimes(1);
    await advance(TASK_POLL_INTERVAL_MS);
    expect(reread).toHaveBeenCalledTimes(2);
  });

  it('stops when a check-in that wasn’t there at the press arrives, and keeps it', async () => {
    const { result, reread, rerender } = setup();
    act(() => result.current.start('check-now'));
    await advance(TASK_POLL_INTERVAL_MS);
    const arrived = update(new Date(Date.now()).toISOString(), { conversationId: 'c-new' });
    rerender({ updates: [arrived, ...BEFORE] });
    expect(result.current.phase).toBe('arrived');
    expect(result.current.arrived).toBe(arrived);
    expect(result.current.startedBy).toBe('check-now');
    reread.mockClear();
    await advance(30_000);
    expect(reread).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('arrived');
  });

  it('a check-in already there at the press doesn’t stop it', async () => {
    // Running when Check now was pressed, so it is on the page already.
    const running = update(new Date(NOW.getTime() - 5_000).toISOString(), { conversationId: 'c-r' });
    const { result, rerender } = setup([running, ...BEFORE]);
    act(() => result.current.start('check-now'));
    rerender({ updates: [running, ...BEFORE] });
    expect(result.current.phase).toBe('checking');
  });

  it('a check-in that started up to a minute before the press stops it, one that started earlier doesn’t', async () => {
    const at = NOW.getTime();
    const near = update(new Date(at - (TASK_POLL_CLOCK_SLACK_MS - 1_000)).toISOString());
    const far = update(new Date(at - (TASK_POLL_CLOCK_SLACK_MS + 1_000)).toISOString());

    const one = setup();
    act(() => one.result.current.start('check-now'));
    one.rerender({ updates: [near, ...BEFORE] });
    expect(one.result.current.phase).toBe('arrived');
    one.unmount();

    const two = setup();
    act(() => two.result.current.start('check-now'));
    two.rerender({ updates: [far, ...BEFORE] });
    expect(two.result.current.phase).toBe('checking');
  });

  it('stops at five minutes, not before', async () => {
    const { result, reread } = setup();
    act(() => result.current.start('check-now'));
    await advance(TASK_POLL_LIMIT_MS - 1);
    expect(result.current.phase).toBe('checking');
    await advance(1);
    expect(result.current.phase).toBe('timed-out');
    expect(result.current.arrived).toBeNull();
    reread.mockClear();
    await advance(60_000);
    expect(reread).not.toHaveBeenCalled();
  });

  it('a second start resets the five minutes and says who started it', async () => {
    const { result, reread } = setup();
    act(() => result.current.start('check-now'));
    await advance(TASK_POLL_LIMIT_MS - 5_000);
    act(() => result.current.start('reply'));
    expect(result.current).toMatchObject({ phase: 'checking', startedBy: 'reply' });
    reread.mockClear();
    await advance(TASK_POLL_LIMIT_MS - 1);
    expect(result.current.phase).toBe('checking');
    // One interval, not two: the first start's timer went with it.
    expect(reread).toHaveBeenCalledTimes(Math.floor((TASK_POLL_LIMIT_MS - 1) / TASK_POLL_INTERVAL_MS));
    await advance(1);
    expect(result.current.phase).toBe('timed-out');
  });

  it('stop clears it', async () => {
    const { result, reread } = setup();
    act(() => result.current.start('reply'));
    act(() => result.current.stop());
    expect(result.current).toMatchObject({ phase: 'idle', startedBy: null, arrived: null });
    await advance(TASK_POLL_LIMIT_MS);
    expect(reread).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });

  it('stops when the page can’t show the task', async () => {
    const { result, reread, rerender } = setup();
    act(() => result.current.start('check-now'));
    rerender({ updates: null });
    expect(result.current.phase).toBe('idle');
    await advance(30_000);
    expect(reread).not.toHaveBeenCalled();
  });

  it('unmount stops re-reading', async () => {
    const { result, reread, unmount } = setup();
    act(() => result.current.start('check-now'));
    unmount();
    await advance(TASK_POLL_LIMIT_MS);
    expect(reread).not.toHaveBeenCalled();
  });

  it('a start after unmount reads nothing (Check now or a reply answering after the page left)', async () => {
    const { result, reread, unmount } = setup();
    const start = result.current.start;
    unmount();
    start('check-now');
    await advance(TASK_POLL_LIMIT_MS + 60_000);
    expect(reread).not.toHaveBeenCalled();
  });
});
