import pg from 'pg';

/**
 * Makes the first `times` statements whose SQL matches `match` reject with
 * `error` before they reach Postgres, for every pg client in this test
 * process. Every other statement goes out as usual. Returns the function that
 * puts `query` back; call it in a `finally`.
 *
 * Why it exists: TASK-1041's acceptance needs the real election statement
 * (`pg_try_advisory_lock`) to fail once, with the real pool and Kysely's
 * release-on-throw (`provideConnection`'s `finally`) running for real. A fake
 * `db` can only pretend the checkout failed; this fails the query itself, on a
 * pooled connection that then has to go back to the pool.
 *
 * Only the promise form, `client.query(sql, params)`, is matched: that is the
 * only form Kysely calls.
 */
export function failQueries(match: RegExp, error: unknown, times = 1): () => void {
  const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = proto.query;
  let remaining = times;
  proto.query = function failingQuery(this: unknown, ...args: unknown[]): unknown {
    if (remaining > 0 && typeof args[0] === 'string' && match.test(args[0])) {
      remaining -= 1;
      return Promise.reject(error);
    }
    return original.apply(this, args);
  };
  return () => { proto.query = original; };
}
