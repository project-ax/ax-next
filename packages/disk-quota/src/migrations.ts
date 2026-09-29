import { sql, type ColumnType, type Kysely } from 'kysely';

/**
 * @ax/disk-quota owns tables under the `disk_quota_v1_` prefix (Invariant I4:
 * one source of truth per concept). Greenfield posture: additive ALTERs in
 * place. No foreign keys into other plugins' tables: `owner_id` is either the
 * auth provider's opaque user id or `team:<id>`, and a usage row must survive
 * whatever another plugin does to its own rows (nothing frees these bytes
 * anyway).
 *
 * Table:
 *   disk_quota_v1_usage — one row per (owner, source). `source` is
 *     `workspace:<agentId>` (the whole repo, re-measured) or `blob:<sha256>`
 *     (counted once per owner however often it is re-put). The primary key's
 *     `owner_id` prefix serves the per-owner sum; the all-owner admin view is
 *     one GROUP BY over a small table, so no further index is added.
 *
 * BIGINT columns come back from `pg` as strings; the store converts with
 * Number() (safe: a single owner's total stays far below 2^53).
 */
type BigIntColumn = ColumnType<string, number | string, number | string>;

export type UsageKind = 'workspace' | 'blob';

export interface DiskQuotaUsageTable {
  owner_id: string;
  source: string;
  kind: UsageKind;
  bytes: BigIntColumn;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface DiskQuotaDatabase {
  disk_quota_v1_usage: DiskQuotaUsageTable;
}

export async function runDiskQuotaMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS disk_quota_v1_usage (
      owner_id    TEXT NOT NULL,
      source      TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('workspace', 'blob')),
      bytes       BIGINT NOT NULL CHECK (bytes >= 0),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, source)
    )
  `.execute(db);
}
