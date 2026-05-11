// Debouncer tests — covers I10: Consolidator is async + bounded.
//
// WHY debouncing: a user who sends 5 messages in quick succession triggers
// 5 chat:end events and would launch 5 overlapping consolidation passes. The
// debouncer coalesces those into a single pass so the inbox is never walked
// concurrently for the same agent.
//
// Invariant I10: the Consolidator is async + bounded — rapid chat:end bursts
// for the same agent coalesce within DEBOUNCE_MS; a new window starts a
// fresh pass after the prior window fires.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { createDebouncer } from '../debounce.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDebouncer', () => {
  it('coalesces 3 rapid calls into 1 execution, firing the LATEST runner', async () => {
    const WINDOW = 200;
    const d = createDebouncer(WINDOW);

    const firstRun = vi.fn().mockResolvedValue(undefined);
    const secondRun = vi.fn().mockResolvedValue(undefined);
    const latestRun = vi.fn().mockResolvedValue(undefined);

    d.schedule('agent-a', firstRun);
    d.schedule('agent-a', secondRun);
    d.schedule('agent-a', latestRun);

    // No execution yet — still within the window.
    expect(firstRun).not.toHaveBeenCalled();
    expect(secondRun).not.toHaveBeenCalled();
    expect(latestRun).not.toHaveBeenCalled();

    // Advance past the window; the latest runner fires.
    await vi.advanceTimersByTimeAsync(WINDOW + 1);

    expect(firstRun).not.toHaveBeenCalled();
    expect(secondRun).not.toHaveBeenCalled();
    expect(latestRun).toHaveBeenCalledTimes(1);
  });

  it('isolates agents — both A and B fire independently', async () => {
    const WINDOW = 200;
    const d = createDebouncer(WINDOW);

    const runA = vi.fn().mockResolvedValue(undefined);
    const runB = vi.fn().mockResolvedValue(undefined);

    d.schedule('agent-a', runA);
    d.schedule('agent-b', runB);

    await vi.advanceTimersByTimeAsync(WINDOW + 1);

    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh window after the first fires — second schedule fires separately', async () => {
    const WINDOW = 200;
    const d = createDebouncer(WINDOW);

    const firstRun = vi.fn().mockResolvedValue(undefined);
    const secondRun = vi.fn().mockResolvedValue(undefined);

    d.schedule('agent-a', firstRun);
    await vi.advanceTimersByTimeAsync(WINDOW + 1);
    expect(firstRun).toHaveBeenCalledTimes(1);

    d.schedule('agent-a', secondRun);
    await vi.advanceTimersByTimeAsync(WINDOW + 1);
    expect(secondRun).toHaveBeenCalledTimes(1);

    // Total: one execution per window.
    expect(firstRun).toHaveBeenCalledTimes(1);
  });

  it('flush forces immediate execution without advancing time', async () => {
    const WINDOW = 5000;
    const d = createDebouncer(WINDOW);

    const run = vi.fn().mockResolvedValue(undefined);
    d.schedule('agent-a', run);

    // No time has passed — runner would not fire naturally yet.
    expect(run).not.toHaveBeenCalled();

    await d.flush();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('subscriber posture — flush resolves cleanly even if runner throws', async () => {
    const WINDOW = 5000;
    const d = createDebouncer(WINDOW);

    const throwingRun = vi.fn().mockRejectedValue(new Error('consolidation failed'));
    d.schedule('agent-a', throwingRun);

    // flush must not reject even when the runner throws.
    await expect(d.flush()).resolves.toBeUndefined();
    expect(throwingRun).toHaveBeenCalledTimes(1);
  });
});
