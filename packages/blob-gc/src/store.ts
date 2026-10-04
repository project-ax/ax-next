import { sql, type Kysely } from 'kysely';
import type { BlobGcDatabase } from './migrations.js';

export interface BlobRowSummary {
  sha256: string;
  size: number;
}

export interface BlobGcStore {
  /**
   * A put landed (`blob:stored`). Inserts the row, or refreshes it: the size,
   * `state = 'live'`, `retired_at = NULL`, and `last_put_at` moved forward to
   * `at` (never backward, so a host whose clock lags cannot shorten anyone's
   * grace window).
   */
  recordPut(sha256: string, size: number, at: Date): Promise<void>;
  /**
   * Blobs found by listing the backend. Each one the table has never seen is
   * inserted as live with `last_put_at = at`; rows that already exist are left
   * exactly as they are. Resolves how many were new.
   */
  discover(items: readonly BlobRowSummary[], at: Date): Promise<number>;
  /**
   * Up to `limit` live blobs last put before `cutoff`, ordered by sha, after
   * `after` (keyset paging).
   */
  candidates(cutoff: Date, after: string | undefined, limit: number): Promise<BlobRowSummary[]>;
  /** The roster: every holder that has ever answered `blob:collect-refs`. */
  listRoster(): Promise<string[]>;
  /** Add these holders to the roster, or bump their `last_seen_at`. */
  touchRoster(names: readonly string[]): Promise<void>;
  /**
   * Run `fn` only while holding the sweep's Postgres advisory lock, taken
   * with `pg_try_advisory_lock` on one pinned connection. Resolves
   * `{ locked: false }` without running `fn` when another sweep (another
   * replica) holds it. For efficiency, not for safety: report mode changes
   * nothing a second sweep could trip over.
   */
  withSweepLock<T>(fn: () => Promise<T>): Promise<{ locked: true; value: T } | { locked: false }>;
}

/** One fixed key for the whole sweep, in Postgres' shared advisory-lock space. */
const SWEEP_LOCK_KEY = 'ax:blob-gc:sweep';

export function createBlobGcStore(db: Kysely<BlobGcDatabase>): BlobGcStore {
  return {
    async recordPut(sha256, size, at) {
      await db
        .insertInto('blob_gc_v1_blobs')
        .values({ sha256, size, last_put_at: at, state: 'live', retired_at: null })
        .onConflict((oc) =>
          oc.column('sha256').doUpdateSet({
            size: (eb) => eb.ref('excluded.size'),
            last_put_at: sql<Date>`GREATEST(blob_gc_v1_blobs.last_put_at, excluded.last_put_at)`,
            state: 'live',
            retired_at: null,
          }),
        )
        .execute();
    },

    async discover(items, at) {
      if (items.length === 0) return 0;
      const rows = await db
        .insertInto('blob_gc_v1_blobs')
        .values(
          items.map((i) => ({
            sha256: i.sha256,
            size: i.size,
            last_put_at: at,
            state: 'live' as const,
            retired_at: null,
          })),
        )
        .onConflict((oc) => oc.column('sha256').doNothing())
        .returning('sha256')
        .execute();
      return rows.length;
    },

    async candidates(cutoff, after, limit) {
      let q = db
        .selectFrom('blob_gc_v1_blobs')
        .select(['sha256', 'size'])
        .where('state', '=', 'live')
        .where('last_put_at', '<', cutoff);
      if (after !== undefined) q = q.where('sha256', '>', after);
      const rows = await q.orderBy('sha256').limit(limit).execute();
      return rows.map((r) => ({ sha256: r.sha256, size: Number(r.size) }));
    },

    async listRoster() {
      const rows = await db
        .selectFrom('blob_gc_v1_roster')
        .select('holder')
        .orderBy('holder')
        .execute();
      return rows.map((r) => r.holder);
    },

    async touchRoster(names) {
      const unique = [...new Set(names)];
      if (unique.length === 0) return;
      await db
        .insertInto('blob_gc_v1_roster')
        .values(unique.map((holder) => ({ holder })))
        .onConflict((oc) => oc.column('holder').doUpdateSet({ last_seen_at: sql<Date>`now()` }))
        .execute();
    },

    async withSweepLock(fn) {
      // A session-level lock lives on ONE connection, so take it, and release
      // it, on the same pinned one. Everything `fn` does goes through the pool
      // as usual.
      return db.connection().execute(async (conn) => {
        const got = await sql<{ locked: boolean }>`
          SELECT pg_try_advisory_lock(hashtext(${SWEEP_LOCK_KEY})) AS locked
        `.execute(conn);
        if (got.rows[0]?.locked !== true) return { locked: false as const };
        try {
          return { locked: true as const, value: await fn() };
        } finally {
          await sql`SELECT pg_advisory_unlock(hashtext(${SWEEP_LOCK_KEY}))`.execute(conn);
        }
      });
    },
  };
}
