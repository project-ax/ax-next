/**
 * Race `promise` against a timer of `ms` milliseconds. If the timer wins,
 * reject with the error produced by `makeTimeoutError()` (a factory so callers
 * can mint a typed error, e.g. a `PluginError`). A non-finite `ms`
 * (e.g. `Infinity`) disables the timer and returns the promise unchanged.
 *
 * The timer is `.unref()`'d so it never keeps the event loop alive, and the
 * losing promise's eventual settlement is consumed (its `.then` handlers run
 * after the outer promise has already settled — a harmless no-op — which
 * prevents an `unhandledRejection` if the loser rejects late).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  makeTimeoutError: () => Error,
): Promise<T> {
  if (!Number.isFinite(ms)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeTimeoutError()), ms);
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
