/**
 * Slack turns, one at a time per lane (TASK-1091's contract for a channel:
 * serialize turns per conversation). Without it, a second message sent
 * mid-reply would be folded into the running turn, and the two replies would
 * interleave in one Slack thread. The router keeps two of these: one lane per
 * conversation for DMs and members' channel turns, and one lane per channel
 * for outsiders' turns, which all run as one person (router.ts).
 *
 *   - Jobs with the same key run one after another; different keys run side
 *     by side.
 *   - `maxPerKey` counts the running job plus those waiting. One more is
 *     refused (`full`) and never runs: the sender is told to send it again.
 *   - `close()` drops every job that hasn't started and refuses new ones
 *     (`closed`). It returns how many it dropped for each job's `group` (the
 *     install), so the caller can say so: nothing is dropped silently. A
 *     running job is left to finish; nothing awaits it.
 *   - A job that throws or rejects is the job's own business (each one
 *     reports its failures itself); the next one still runs.
 *
 * A job that has waited may find the world changed (its install disconnected):
 * checking that is the job's own first step (router.ts), because only the job
 * knows what "still wanted" means.
 *
 * In memory: the chart pins one host replica (a stated residual).
 */

export type EnqueueResult = 'queued' | 'full' | 'closed';

/** Jobs `close()` dropped for one group. Groups with none dropped are left out. */
export interface DroppedJobs {
  group: string;
  count: number;
}

export interface KeyedQueue {
  /** `group` is who the job is for (channel-slack: the install), for `close()`'s count. */
  enqueue(key: string, group: string, job: () => Promise<void>): EnqueueResult;
  close(): DroppedJobs[];
  /** Keys with a job running or waiting. 0 once every job has ended: a finished lane is forgotten. */
  size(): number;
}

interface Waiting {
  group: string;
  job: () => Promise<void>;
}

interface Lane {
  running: boolean;
  waiting: Waiting[];
}

export function createKeyedQueue(o: { maxPerKey: number }): KeyedQueue {
  if (!Number.isSafeInteger(o.maxPerKey) || o.maxPerKey < 1) {
    throw new RangeError('createKeyedQueue: maxPerKey must be a positive integer');
  }
  const { maxPerKey } = o;
  const lanes = new Map<string, Lane>();
  let closed = false;

  /** Start the lane's next job, or forget the lane when there is none. */
  function next(key: string, lane: Lane): void {
    const waiting = closed ? undefined : lane.waiting.shift();
    if (waiting === undefined) {
      lane.running = false;
      lanes.delete(key);
      return;
    }
    lane.running = true;
    void (async () => {
      try {
        await waiting.job();
      } catch {
        // The job logs and answers its own failures.
      }
      next(key, lane);
    })();
  }

  return {
    enqueue(key, group, job) {
      if (closed) return 'closed';
      let lane = lanes.get(key);
      if (lane === undefined) {
        lane = { running: false, waiting: [] };
        lanes.set(key, lane);
      }
      if ((lane.running ? 1 : 0) + lane.waiting.length >= maxPerKey) return 'full';
      lane.waiting.push({ group, job });
      if (!lane.running) next(key, lane);
      return 'queued';
    },

    close() {
      closed = true;
      const dropped = new Map<string, number>();
      for (const lane of lanes.values()) {
        for (const { group } of lane.waiting) dropped.set(group, (dropped.get(group) ?? 0) + 1);
        lane.waiting.length = 0;
      }
      return [...dropped].map(([group, count]) => ({ group, count }));
    },

    size() {
      return lanes.size;
    },
  };
}
