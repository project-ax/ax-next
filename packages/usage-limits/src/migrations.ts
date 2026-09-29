import { sql, type ColumnType, type Kysely } from 'kysely';

/**
 * @ax/usage-limits owns tables under the `usage_limits_v1_` prefix (Invariant
 * I4 — one source of truth per concept). Greenfield posture: additive ALTERs
 * in place, no v1 -> v2 split. No foreign keys into other plugins' tables:
 * `user_id` is the auth provider's opaque id, and a usage row must survive
 * whatever another plugin does to its own rows.
 *
 * Tables:
 *   usage_limits_v1_buckets     — one row per user per minute; rolling-window
 *                                 sums are one indexed range query.
 *   usage_limits_v1_suspensions — the admin kill switch, one row per user.
 *
 * BIGINT columns come back from `pg` as strings; the store converts with
 * Number() (safe: per-bucket values stay far below 2^53).
 */
type BigIntColumn = ColumnType<string, number | string | undefined, number | string>;

export interface UsageBucketsTable {
  user_id: string;
  bucket_start: Date;
  turns: ColumnType<number, number | undefined, number>;
  input_tokens: BigIntColumn;
  output_tokens: BigIntColumn;
  cache_read_tokens: BigIntColumn;
  cache_write_tokens: BigIntColumn;
  cost_micros: BigIntColumn;
}

export interface UsageSuspensionsTable {
  user_id: string;
  suspended_at: Date;
  suspended_by: string;
  note: string | null;
}

export interface UsageLimitsDatabase {
  usage_limits_v1_buckets: UsageBucketsTable;
  usage_limits_v1_suspensions: UsageSuspensionsTable;
}

export async function runUsageLimitsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS usage_limits_v1_buckets (
      user_id             TEXT NOT NULL,
      bucket_start        TIMESTAMPTZ NOT NULL,
      turns               INTEGER NOT NULL DEFAULT 0,
      input_tokens        BIGINT NOT NULL DEFAULT 0,
      output_tokens       BIGINT NOT NULL DEFAULT 0,
      cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
      cache_write_tokens  BIGINT NOT NULL DEFAULT 0,
      cost_micros         BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, bucket_start)
    )
  `.execute(db);

  // The primary key already serves per-user range scans; this one serves the
  // all-users admin summary and the prune sweep.
  await sql`
    CREATE INDEX IF NOT EXISTS usage_limits_v1_buckets_bucket_start_idx
      ON usage_limits_v1_buckets (bucket_start)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS usage_limits_v1_suspensions (
      user_id       TEXT PRIMARY KEY,
      suspended_at  TIMESTAMPTZ NOT NULL,
      suspended_by  TEXT NOT NULL,
      note          TEXT NULL
    )
  `.execute(db);
}
