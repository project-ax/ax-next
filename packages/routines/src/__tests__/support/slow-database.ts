import pg from 'pg';

/**
 * Holds every statement any pg client in this test process sends for `ms`
 * before it goes out, the way a loaded CI runner does: there, four Postgres
 * containers and the vitest workers share a few cores, and a single statement
 * can take tens of milliseconds. Returns the function that puts `query` back;
 * call it in a `finally`.
 *
 * Why it exists: a routine's fire row is written after `routines:fire-now`
 * answers, by the detached turn's `chat:turn-end` subscriber, about ten
 * statements later. A wait on that row under vitest's default one-second
 * `expect.poll` passes locally in ~10 ms and failed on main's CI right after
 * TASK-948, which didn't touch the fire path (same 31 statements, same order).
 * At 150 ms a statement it fails here every run, so a test can prove a wait's
 * budget covers a slow database instead of a fast laptop.
 */
export function slowDatabase(ms: number): () => void {
  const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = proto.query;
  proto.query = function slowQuery(this: unknown, ...args: unknown[]): unknown {
    if (typeof args[args.length - 1] === 'function') {
      setTimeout(() => original.apply(this, args), ms);
      return undefined;
    }
    return new Promise(resolve => setTimeout(resolve, ms)).then(() => original.apply(this, args));
  };
  return () => { proto.query = original; };
}
