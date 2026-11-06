import { describe, it, expect } from 'vitest';
import type { Kysely } from 'kysely';
import { CHECKOUT_RETRY_DELAYS_MS, withCheckoutRetry } from '../checkout-retry.js';

// ---------------------------------------------------------------------------
// TASK-1059: withCheckoutRetry retries a checkout that never handed over a
// connection, and nothing after one was handed over.
//
// The fake stands in for Kysely's `db.connection().execute(cb)`. For its first
// `refusals` checkouts it rejects WITHOUT calling `cb`, as a pool that never
// hands over a connection does; after that it calls `cb` with a sentinel
// pinned handle. No Docker: the real pool is exercised in
// append-event-checkout-retry.test.ts.
// ---------------------------------------------------------------------------

const PINNED = { pinned: 'sentinel' } as unknown as Kysely<unknown>;

function fakeDb(refusals: number): {
  db: Pick<Kysely<unknown>, 'connection'>;
  failures: Error[];
  checkouts: () => number;
} {
  const failures: Error[] = [];
  let checkouts = 0;
  const db = {
    connection: () => ({
      execute: async <T>(cb: (pinned: Kysely<unknown>) => Promise<T>): Promise<T> => {
        checkouts++;
        if (checkouts <= refusals) {
          const err = new Error(`no connection ${checkouts}`);
          failures.push(err);
          throw err;
        }
        return cb(PINNED);
      },
    }),
  };
  return {
    db: db as unknown as Pick<Kysely<unknown>, 'connection'>,
    failures,
    checkouts: () => checkouts,
  };
}

/** Records every onRetry call and every wait; the waits resolve at once. */
function recorder(): {
  retries: Array<[unknown, number, number]>;
  waits: number[];
  opts: {
    onRetry(err: unknown, attempt: number, retryInMs: number): void;
    sleep(ms: number): Promise<void>;
  };
} {
  const retries: Array<[unknown, number, number]> = [];
  const waits: number[] = [];
  return {
    retries,
    waits,
    opts: {
      onRetry(err, attempt, retryInMs) {
        retries.push([err, attempt, retryInMs]);
      },
      async sleep(ms) {
        waits.push(ms);
      },
    },
  };
}

describe('withCheckoutRetry (TASK-1059)', () => {
  it('retries a checkout that never handed over a connection, then returns what op returned', async () => {
    const fake = fakeDb(1);
    const rec = recorder();
    const seen: unknown[] = [];

    const result = await withCheckoutRetry(
      fake.db,
      async (pinned) => {
        seen.push(pinned);
        return 'ok';
      },
      rec.opts,
    );

    expect(result).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(PINNED);
    expect(fake.failures).toHaveLength(1);
    expect(rec.retries).toEqual([[fake.failures[0], 1, 250]]);
    expect(rec.retries[0]![0]).toBe(fake.failures[0]);
    expect(rec.waits).toEqual([250]);
    expect(fake.checkouts()).toBe(2);
  });

  it('gives up after three checkouts and rethrows the last failure', async () => {
    const fake = fakeDb(Number.POSITIVE_INFINITY);
    const rec = recorder();
    let opCalls = 0;

    const thrown = await withCheckoutRetry(
      fake.db,
      async () => {
        opCalls++;
        return 'never';
      },
      rec.opts,
    ).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(fake.checkouts()).toBe(3);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toBe(fake.failures[2]);
    expect(rec.retries.map(([, attempt, retryInMs]) => [attempt, retryInMs])).toEqual([
      [1, 250],
      [2, 1_000],
    ]);
    expect(rec.retries[0]![0]).toBe(fake.failures[0]);
    expect(rec.retries[1]![0]).toBe(fake.failures[1]);
    expect(rec.waits).toEqual([250, 1_000]);
    expect(opCalls).toBe(0);
  });

  it('never retries once the connection was handed over', async () => {
    const fake = fakeDb(0);
    const rec = recorder();
    const boom = new Error('boom');
    let opCalls = 0;

    await expect(
      withCheckoutRetry(
        fake.db,
        async () => {
          opCalls++;
          throw boom;
        },
        rec.opts,
      ),
    ).rejects.toBe(boom);

    expect(opCalls).toBe(1);
    expect(fake.checkouts()).toBe(1);
    expect(rec.retries).toEqual([]);
    expect(rec.waits).toEqual([]);
  });

  it('waits 250 ms, then 1 s', () => {
    expect(CHECKOUT_RETRY_DELAYS_MS).toEqual([250, 1_000]);
  });
});
