/**
 * "Checking in now…" on a task page (TASK-931): after Check now or a reply
 * starts a check-in, the page reads the task again every 10 seconds until that
 * check-in's update is there, for up to five minutes. Today shares the clock
 * but keeps its reply refresh alive for the full window (TASK-940).
 *
 * WHEN IT STOPS. A check-in counts as the one the press started when it
 * wasn't on the page at the press (`seen`) and started no earlier than a
 * minute before it. The first rule is clock-free: comparing the host's
 * `firedAt` with the browser's clock alone would never stop for a browser a
 * second fast, and stop on an older check-in for one a second slow. The
 * minute's slack only keeps a check-in that was already running at the press
 * (Check now beside a scheduled one) from ending it when it lands. It also
 * stops at five minutes (`timed-out`), when the page can't show the task
 * (`updates` turns null), on `stop()`, and on unmount; a `start()` after
 * unmount does nothing.
 *
 * The re-read it is given should be quiet (`useTask().refreshQuietly`): the
 * ordinary refresh disables the page's buttons while it runs and alarms on a
 * failed read, neither of which a background tick should do.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskUpdate } from './workspace-types.js';

export const TASK_POLL_INTERVAL_MS = 10_000;
export const TASK_POLL_LIMIT_MS = 300_000;
/** How far before the press a check-in may have started and still be the one the press started: browser and host clocks differ a little. */
export const TASK_POLL_CLOCK_SLACK_MS = 60_000;

export type TaskPollPhase = 'idle' | 'checking' | 'arrived' | 'timed-out';
export type TaskPollStarter = 'check-now' | 'reply';

/** One check-in's identity on the page: its start time and its conversation. */
function updateKey(u: TaskUpdate): string {
  return `${u.firedAt}|${u.conversationId ?? ''}`;
}

/** Pure: the newest check-in in `updates` that wasn't there at the press (`seen`, keyed `${firedAt}|${conversationId ?? ''}`) and started no earlier than `at - TASK_POLL_CLOCK_SLACK_MS`; else null. */
export function arrivedCheckIn(
  updates: readonly TaskUpdate[],
  press: { at: number; seen: ReadonlySet<string> },
): TaskUpdate | null {
  const floor = press.at - TASK_POLL_CLOCK_SLACK_MS;
  let found: TaskUpdate | null = null;
  let foundAt = -Infinity;
  for (const u of updates) {
    if (press.seen.has(updateKey(u))) continue;
    const at = Date.parse(u.firedAt);
    // An unreadable time can't be placed after the press, so it never counts.
    if (!Number.isFinite(at) || at < floor) continue;
    if (at > foundAt) {
      found = u;
      foundAt = at;
    }
  }
  return found;
}

interface PollState<T> {
  phase: TaskPollPhase;
  startedBy: TaskPollStarter | null;
  arrived: T | null;
}

/** Shared bounded clock for the detail page and Today's reply window (TASK-940). */
function useBoundedTaskPoll<T, A>(
  snapshot: T | null,
  reread: () => void,
  arrival: (current: T, before: T | null, at: number) => A | null,
) {
  const [poll, setPoll] = useState<PollState<A>>({ phase: 'idle', startedBy: null, arrived: null });
  const latest = useRef({ snapshot, reread, arrival });
  useEffect(() => {
    latest.current = { snapshot, reread, arrival };
  });
  const press = useRef<{ at: number; before: T | null } | null>(null);
  const timers = useRef<{ tick: ReturnType<typeof setInterval>; limit: ReturnType<typeof setTimeout> } | null>(null);
  const mounted = useRef(false);

  const clear = useCallback(() => {
    if (timers.current === null) return;
    clearInterval(timers.current.tick);
    clearTimeout(timers.current.limit);
    timers.current = null;
  }, []);

  const start = useCallback((by: TaskPollStarter) => {
    if (!mounted.current || latest.current.snapshot === null) return;
    clear();
    press.current = { at: Date.now(), before: latest.current.snapshot };
    setPoll({ phase: 'checking', startedBy: by, arrived: null });
    timers.current = {
      tick: setInterval(() => latest.current.reread(), TASK_POLL_INTERVAL_MS),
      limit: setTimeout(() => {
        clear();
        setPoll((p) => p.phase === 'checking' ? { ...p, phase: 'timed-out' } : p);
      }, TASK_POLL_LIMIT_MS),
    };
  }, [clear]);

  const stop = useCallback(() => {
    clear();
    press.current = null;
    setPoll({ phase: 'idle', startedBy: null, arrived: null });
  }, [clear]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clear();
    };
  }, [clear]);

  useEffect(() => {
    if (poll.phase !== 'checking' || press.current === null) return;
    if (snapshot === null) {
      stop();
      return;
    }
    const arrived = latest.current.arrival(snapshot, press.current.before, press.current.at);
    if (arrived !== null) {
      clear();
      setPoll((p) => ({ ...p, phase: 'arrived', arrived }));
    }
  }, [snapshot, poll.phase, clear, stop]);

  return { ...poll, start, stop };
}

/** Detail reads retain their fire identity and clock-slack arrival rule. */
export function useTaskPoll(updates: readonly TaskUpdate[] | null, reread: () => void) {
  return useBoundedTaskPoll(updates, reread, (current, before, at) =>
    arrivedCheckIn(current, { at, seen: new Set((before ?? []).map(updateKey)) }),
  );
}

/**
 * Today owns this clock above its disposable task rows. The list has no run
 * identity: an older overlapping check-in can report first and remove a row,
 * so no row result can prove the reply's check-in has finished. Keep reading
 * for the full bounded window; `active` turns false on the Working tab, and
 * leaving Today unmounts the owner. Ticks should join the shared list read.
 */
export function useTaskReplyPoll(active: boolean, reread: () => void) {
  return useBoundedTaskPoll(active ? true : null, reread, () => null);
}
