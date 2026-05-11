// Shared timeout primitive. Factored out of observer.ts so both the
// Observer and the Consolidator can race promises against a hard deadline
// without duplicating the implementation.
//
// WHY a shared module rather than inline copies: observer.ts and plugin.ts
// both need race-timeout semantics but they should never import from each
// other (observer.ts is deliberately bus-agnostic; plugin.ts owns wiring).
// A tiny shared module avoids duplication without creating a circular dep.

export class TimeoutError extends Error {
  constructor(label: string) {
    super(`timeout: ${label}`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race `promise` against a hard deadline. Rejects with `TimeoutError` if
 * the deadline fires first. The underlying promise is not cancelled — it
 * continues in the background, but its resolution is ignored.
 *
 * The internal timer is `unref()`'d so it does not keep the Node process
 * alive once the main event loop is otherwise idle.
 */
export function raceTimeout<T>(promise: Promise<T>, ms: number, label = 'raceTimeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
