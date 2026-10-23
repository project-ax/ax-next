/**
 * "Checking in now…" on a task page (TASK-931): after Check now or a reply
 * starts a check-in, the page reads the task again every 10 seconds until that
 * check-in's update is there, for up to five minutes.
 *
 * WHEN IT STOPS. A check-in counts as the one the press started when it
 * wasn't on the page at the press (`seen`) and started no earlier than a
 * minute before it. The first rule is clock-free: comparing the host's
 * `firedAt` with the browser's clock alone would never stop for a browser a
 * second fast, and stop on an older check-in for one a second slow. The
 * minute's slack only keeps a check-in that was already running at the press
 * (Check now beside a scheduled one) from ending it when it lands. It also
 * stops at five minutes (`timed-out`), when the page can't show the task
 * (`updates` turns null), on `stop()`, and on unmount.
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

interface PollState {
  phase: TaskPollPhase;
  startedBy: TaskPollStarter | null;
  arrived: TaskUpdate | null;
}

const IDLE: PollState = { phase: 'idle', startedBy: null, arrived: null };

export function useTaskPoll(
  updates: readonly TaskUpdate[] | null,
  reread: () => void,
): {
  phase: TaskPollPhase;
  /** Who started the current poll: the reply box speaks for its own check-in, so the page doesn't say it again. */
  startedBy: TaskPollStarter | null;
  /** The check-in that ended it, while `phase` is `arrived`. */
  arrived: TaskUpdate | null;
  start: (by: TaskPollStarter) => void;
  stop: () => void;
} {
  const [poll, setPoll] = useState<PollState>(IDLE);
  // The latest of each, for `start` and the timer, without restarting either.
  const latestUpdates = useRef(updates);
  const latestReread = useRef(reread);
  useEffect(() => {
    latestUpdates.current = updates;
    latestReread.current = reread;
  });
  const press = useRef<{ at: number; seen: ReadonlySet<string> } | null>(null);
  const timers = useRef<{ tick: ReturnType<typeof setInterval>; limit: ReturnType<typeof setTimeout> } | null>(null);

  const clear = useCallback(() => {
    if (timers.current === null) return;
    clearInterval(timers.current.tick);
    clearTimeout(timers.current.limit);
    timers.current = null;
  }, []);

  const start = useCallback(
    (by: TaskPollStarter) => {
      clear();
      press.current = {
        at: Date.now(),
        seen: new Set((latestUpdates.current ?? []).map(updateKey)),
      };
      setPoll({ phase: 'checking', startedBy: by, arrived: null });
      timers.current = {
        tick: setInterval(() => latestReread.current(), TASK_POLL_INTERVAL_MS),
        limit: setTimeout(() => {
          clear();
          setPoll((p) => (p.phase === 'checking' ? { ...p, phase: 'timed-out' } : p));
        }, TASK_POLL_LIMIT_MS),
      };
    },
    [clear],
  );

  const stop = useCallback(() => {
    clear();
    press.current = null;
    setPoll(IDLE);
  }, [clear]);

  // Unmount: no re-read outlives the page.
  useEffect(() => clear, [clear]);

  useEffect(() => {
    if (poll.phase !== 'checking' || press.current === null) return;
    if (updates === null) {
      clear();
      setPoll(IDLE);
      return;
    }
    const arrived = arrivedCheckIn(updates, press.current);
    if (arrived !== null) {
      clear();
      setPoll((p) => ({ ...p, phase: 'arrived', arrived }));
    }
  }, [updates, poll.phase, clear]);

  return { ...poll, start, stop };
}
