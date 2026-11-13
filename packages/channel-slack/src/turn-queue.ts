/**
 * DM turns, one at a time per conversation (TASK-1091's contract for a
 * channel: serialize turns per conversation). Without it, a second message
 * sent mid-reply would be folded into the running turn, and the two replies
 * would interleave in one Slack thread.
 *
 *   - Jobs with the same key run one after another; different keys run side
 *     by side.
 *   - `maxPerKey` counts the running job plus those waiting. One more is
 *     refused (`full`) and never runs: the sender is told to send it again.
 *   - `close()` drops every job that hasn't started and refuses new ones
 *     (`closed`). A running job is left to finish; nothing awaits it.
 *   - A job that throws or rejects is the job's own business (each one
 *     reports its failures itself); the next one still runs.
 *
 * In memory: the chart pins one host replica (a stated residual).
 */

export type EnqueueResult = 'queued' | 'full' | 'closed';

export interface KeyedQueue {
  enqueue(key: string, job: () => Promise<void>): EnqueueResult;
  close(): void;
}

interface Lane {
  running: boolean;
  waiting: Array<() => Promise<void>>;
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
    const job = closed ? undefined : lane.waiting.shift();
    if (job === undefined) {
      lane.running = false;
      lanes.delete(key);
      return;
    }
    lane.running = true;
    void (async () => {
      try {
        await job();
      } catch {
        // The job logs and answers its own failures.
      }
      next(key, lane);
    })();
  }

  return {
    enqueue(key, job) {
      if (closed) return 'closed';
      let lane = lanes.get(key);
      if (lane === undefined) {
        lane = { running: false, waiting: [] };
        lanes.set(key, lane);
      }
      if ((lane.running ? 1 : 0) + lane.waiting.length >= maxPerKey) return 'full';
      lane.waiting.push(job);
      if (!lane.running) next(key, lane);
      return 'queued';
    },

    close() {
      closed = true;
      for (const lane of lanes.values()) lane.waiting.length = 0;
    },
  };
}
