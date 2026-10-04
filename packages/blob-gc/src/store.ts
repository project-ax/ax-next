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
  /**
   * Blobs found in the backend's RETIRED namespace. Each one the table has
   * never seen is inserted as retired with `retired_at = at` (and
   * `last_put_at = at`), so its retention clock starts when the GC first sees
   * it, never earlier. Rows that already exist are left exactly as they are.
   * Resolves how many were new.
   */
  discoverRetired(items: readonly BlobRowSummary[], at: Date): Promise<number>;
  /**
   * Enforce retire, step one: flip ONE row live -> retired (`retired_at =
   * at`), but only while it is still live AND last put before `cutoff`.
   * Resolves false when it did not flip (a re-put refreshed it after the
   * holders were asked, or it is already retired): the caller must then NOT
   * move the blob.
   */
  markRetired(sha256: string, cutoff: Date, at: Date): Promise<boolean>;
  /**
   * Undo `markRetired(sha256, _, at)` after the backend's retire failed:
   * back to live, `retired_at = NULL`. Only touches a row still retired at
   * exactly `at`, so a put that landed in between is not disturbed.
   */
  unmarkRetired(sha256: string, at: Date): Promise<void>;
  /** Up to `limit` rows retired before `cutoff`, ordered by sha, after `after`. */
  purgeDue(cutoff: Date, after: string | undefined, limit: number): Promise<BlobRowSummary[]>;
  /**
   * A retired blob some holder references again (its bytes were just
   * restored): back to live, `retired_at = NULL`, `last_put_at` moved forward
   * to `at` (never backward), so it gets a full grace window.
   */
  markRestored(sha256: string, at: Date): Promise<void>;
  /**
   * The backend purged a retired blob: drop its row, but only if it is still
   * retired before `cutoff`. A put or restore that landed in between made it
   * live again (with a live copy purge cannot touch), and that row stays.
   */
  deletePurged(sha256: string, cutoff: Date): Promise<boolean>;
  /** The roster: every holder that has ever answered `blob:collect-refs`. */
  listRoster(): Promise<string[]>;
  /** Add these holders to the roster, or bump their `last_seen_at`. */
  touchRoster(names: readonly string[]): Promise<void>;
  /**
   * Drop one holder from the roster (an operator retired that plugin on
   * purpose). Resolves whether it was there. The only way the roster shrinks.
   */
  forgetHolder(holder: string): Promise<boolean>;
  /**
   * Run `fn` only while holding the sweep's Postgres advisory lock, taken
   * with `pg_try_advisory_lock` on one pinned connection. Resolves
   * `{ locked: false }` without running `fn` when another sweep (another
   * replica) holds it. For efficiency, not for safety: every step a sweep
   * takes (discover, retire, restore, purge) is idempotent and conditional on
   * the row's current state, so two sweeps at once (the lock's connection
   * dropped mid-sweep) repeat work but cannot undo each other's checks.
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

    async discoverRetired(items, at) {
      if (items.length === 0) return 0;
      const rows = await db
        .insertInto('blob_gc_v1_blobs')
        .values(
          items.map((i) => ({
            sha256: i.sha256,
            size: i.size,
            last_put_at: at,
            state: 'retired' as const,
            retired_at: at,
          })),
        )
        .onConflict((oc) => oc.column('sha256').doNothing())
        .returning('sha256')
        .execute();
      return rows.length;
    },

    async markRetired(sha256, cutoff, at) {
      const res = await db
        .updateTable('blob_gc_v1_blobs')
        .set({ state: 'retired', retired_at: at })
        .where('sha256', '=', sha256)
        .where('state', '=', 'live')
        .where('last_put_at', '<', cutoff)
        .executeTakeFirst();
      return Number(res.numUpdatedRows) === 1;
    },

    async unmarkRetired(sha256, at) {
      await db
        .updateTable('blob_gc_v1_blobs')
        .set({ state: 'live', retired_at: null })
        .where('sha256', '=', sha256)
        .where('state', '=', 'retired')
        .where('retired_at', '=', at)
        .execute();
    },

    async purgeDue(cutoff, after, limit) {
      let q = db
        .selectFrom('blob_gc_v1_blobs')
        .select(['sha256', 'size'])
        .where('state', '=', 'retired')
        .where('retired_at', '<', cutoff);
      if (after !== undefined) q = q.where('sha256', '>', after);
      const rows = await q.orderBy('sha256').limit(limit).execute();
      return rows.map((r) => ({ sha256: r.sha256, size: Number(r.size) }));
    },

    async markRestored(sha256, at) {
      await db
        .updateTable('blob_gc_v1_blobs')
        .set({
          state: 'live',
          retired_at: null,
          last_put_at: sql<Date>`GREATEST(last_put_at, ${at}::timestamptz)`,
        })
        .where('sha256', '=', sha256)
        .where('state', '=', 'retired')
        .execute();
    },

    async deletePurged(sha256, cutoff) {
      const res = await db
        .deleteFrom('blob_gc_v1_blobs')
        .where('sha256', '=', sha256)
        .where('state', '=', 'retired')
        .where('retired_at', '<', cutoff)
        .executeTakeFirst();
      return Number(res.numDeletedRows) === 1;
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

    async forgetHolder(holder) {
      const res = await db.deleteFrom('blob_gc_v1_roster').where('holder', '=', holder).executeTakeFirst();
      return Number(res.numDeletedRows) === 1;
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
