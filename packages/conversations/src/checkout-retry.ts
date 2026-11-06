import type { Kysely } from 'kysely';

/**
 * TASK-1059: the waits between attempts. Two waits, so three attempts in all.
 * Under starvation the checkout timeout itself is the real backoff (each
 * attempt can wait the pool's full timeout, 5 s by default); these short waits
 * help when the refusal is fast, such as a database that is restarting.
 */
export const CHECKOUT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([250, 1_000]);

export interface CheckoutRetryOptions {
  /** Called before each wait: the failure, the attempt that failed (1-based), the wait. */
  onRetry(err: unknown, attempt: number, retryInMs: number): void;
  /** Default `CHECKOUT_RETRY_DELAYS_MS`. */
  delaysMs?: readonly number[];
  /** Default: a `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `op` on one pinned connection, retrying ONLY when the pool never handed
 * a connection over (TASK-1059).
 *
 * How it tells: `op` runs inside `db.connection().execute(cb)`, and Kysely
 * acquires the connection BEFORE it calls `cb` (kysely 0.28.17,
 * `DefaultConnectionProvider.provideConnection`: `await acquireConnection()`,
 * then the callback). So a failure that arrives before `cb` started means
 * nothing of `op` reached the database: a checkout timeout, a refused
 * connect, a driver already destroyed. The flag is set first thing in `cb`,
 * before `op` runs.
 *
 * Why never after hand-over: once `cb` has started, the failure may follow
 * work that landed. A COMMIT can succeed on the server and still reject here
 * (the connection drops before the reply arrives), so a retry would write the
 * row twice. And the display log's append takes a lock that makes a 23505 a
 * real bug (store.ts, `appendEvent`'s CONTRACT), not a race to retry away.
 *
 * Why not by error text or code: pg-pool's checkout errors are plain `Error`s
 * with no `code` (TASK-1049, measured), and TASK-1058 may tag them. Matching
 * their messages would be brittle and narrower; whether `cb` ran is exact,
 * whatever the error looks like.
 *
 * `op` must use only `pinned`. A second checkout from inside it waits behind
 * the connection it is already holding: on a one-connection pool it waits out
 * the checkout timeout, and because that failure comes after hand-over it is
 * not retried.
 */
export async function withCheckoutRetry<DB, T>(
  db: Pick<Kysely<DB>, 'connection'>,
  op: (pinned: Kysely<DB>) => Promise<T>,
  opts: CheckoutRetryOptions,
): Promise<T> {
  const delays = opts.delaysMs ?? CHECKOUT_RETRY_DELAYS_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    let handedOver = false;
    try {
      return await db.connection().execute((pinned) => {
        handedOver = true;
        return op(pinned);
      });
    } catch (err) {
      const retryInMs = delays[attempt - 1];
      if (handedOver || retryInMs === undefined) throw err;
      opts.onRetry(err, attempt, retryInMs);
      await sleep(retryInMs);
    }
  }
}
