/**
 * channel-slack's own work in flight, for a clean shutdown: a copy of
 * @ax/routines' lifetime (`track`, `admit`, `stopAdmission`, `drain`), not an
 * import (invariant 2), without its `defer`.
 *
 *   - `admit` runs outside work (a request from Slack) only while admission
 *     is open. After `stopAdmission` it refuses, and the events route answers
 *     503 so Slack retries against the next pod.
 *   - `track` runs work an admitted request starts on its way out (an event
 *     dispatch after the 200). It keeps working after `stopAdmission`, so
 *     nothing already acknowledged is dropped.
 *   - `drain` stops admission and waits for everything tracked, including
 *     work tracked while it waits. After it, nothing runs.
 */

/** Work refused because admission has stopped (`admit`) or the lifetime has drained. */
export class LifetimeClosedError extends Error {
  readonly code = 'shutting-down';
  constructor() {
    super('channel-slack: shutting down');
    this.name = 'LifetimeClosedError';
  }
}

export function createLifetime() {
  let closing = false;
  let closed = false;
  const effects = new Set<Promise<unknown>>();

  function track<T>(effect: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new LifetimeClosedError());
    const pending = Promise.resolve().then(effect);
    effects.add(pending);
    void pending.then(
      () => effects.delete(pending),
      () => effects.delete(pending),
    );
    return pending;
  }

  function admit<T>(effect: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new LifetimeClosedError());
    return track(effect);
  }

  function stopAdmission(): void {
    closing = true;
  }

  async function drain(): Promise<void> {
    stopAdmission();
    // An effect may track more work while it settles.
    while (effects.size > 0) await Promise.allSettled([...effects]);
    closed = true;
  }

  return { track, admit, stopAdmission, drain };
}

export type Lifetime = ReturnType<typeof createLifetime>;
