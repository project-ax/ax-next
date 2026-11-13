/**
 * A promise-chain lock. `run` calls take turns in the order they arrive, and
 * only one runs at a time. A call that fails, even by throwing before its
 * first await, doesn't hold up the next.
 *
 * In-process only. That is enough: the chart pins the host to one replica
 * (`strategy: Recreate`), and the install store's single-use UPDATEs back it
 * up where it matters most.
 */
export interface Mutex {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(() => fn());
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
