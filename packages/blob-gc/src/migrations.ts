import { sql, type ColumnType, type Kysely } from 'kysely';

/**
 * @ax/blob-gc owns tables under the `blob_gc_v1_` prefix (Invariant I4: one
 * source of truth per concept). Exactly the two tables of design D4
 * (docs/plans/2026-10-03-blob-gc-design.md). No foreign keys into other
 * plugins' tables.
 *
 *   blob_gc_v1_blobs — "when was each blob last written, and is it retired".
 *     One row per sha. `last_put_at` is refreshed by EVERY put (the
 *     `blob:stored` notice fires on the backends' fast path too), so a blob put
 *     a moment before its holder's row lands is never old enough to be a
 *     candidate. A blob the table has never seen (stored before this plugin
 *     shipped, or whose notice was lost) is inserted by the sweep's listing
 *     step with `last_put_at = now()`: its grace starts when the GC first sees
 *     it, never earlier. This is NOT the disk-quota ledger ("what is each
 *     person charged"): different key, different lifetime.
 *     `state` / `retired_at` exist for the retire/purge card (TASK-778); in
 *     report mode every row stays 'live'.
 *   blob_gc_v1_roster — the sweep's ROSTER: every holder name that has ever
 *     answered `blob:collect-refs`. A roster member that does not answer a
 *     later sweep (it threw, or its plugin is no longer loaded) aborts that
 *     sweep. Deliberately NOT shared with @ax/disk-quota's roster: two plugins
 *     must not share rows.
 *
 * BIGINT comes back from `pg` as a string; the store converts with Number()
 * (a single blob is far below 2^53 bytes).
 */
type BigIntColumn = ColumnType<string, number | string, number | string>;

export type BlobState = 'live' | 'retired';

export interface BlobGcBlobsTable {
  sha256: string;
  size: BigIntColumn;
  last_put_at: ColumnType<Date, Date, Date>;
  state: BlobState;
  retired_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface BlobGcRosterTable {
  holder: string;
  first_seen_at: ColumnType<Date, Date | undefined, Date>;
  last_seen_at: ColumnType<Date, Date | undefined, Date>;
}

export interface BlobGcDatabase {
  blob_gc_v1_blobs: BlobGcBlobsTable;
  blob_gc_v1_roster: BlobGcRosterTable;
}

export async function runBlobGcMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS blob_gc_v1_blobs (
      sha256        TEXT PRIMARY KEY,
      size          BIGINT NOT NULL CHECK (size >= 0),
      last_put_at   TIMESTAMPTZ NOT NULL,
      state         TEXT NOT NULL CHECK (state IN ('live', 'retired')),
      retired_at    TIMESTAMPTZ NULL
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS blob_gc_v1_roster (
      holder        TEXT PRIMARY KEY,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
}
