// Bounded-concurrency worker pool.
//
// Extracted so it can be tested without a network: the e2e sample loop is the
// only caller, and the properties that matter there (never exceed the limit,
// stop dispatching once something sets the abort flag, surface the first
// failure without stranding in-flight work) are exactly the ones that are
// tedious to verify against live LLM calls.

export interface PoolOptions {
  /** Max tasks in flight. Values < 1 are treated as 1. */
  concurrency: number;
  /**
   * Checked before each dispatch. Returning true stops NEW work; tasks already
   * in flight are still awaited — killing them would strand partial state (a
   * half-ingested workspace, an unrecorded spend) for no benefit.
   */
  shouldStop?: () => boolean;
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight, in order of
 * dispatch. Resolves once every dispatched task has settled.
 *
 * Task failures are NOT rethrown — `fn` owns its error handling. The e2e loop
 * records a skip per question and keeps going, and a pool that aborted the
 * whole run on one bad question would throw away every completed sibling.
 */
export async function runPool<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<void>,
  opts: PoolOptions,
): Promise<void> {
  const limit = Math.max(1, Math.floor(opts.concurrency));
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (opts.shouldStop?.() === true) return;
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}
