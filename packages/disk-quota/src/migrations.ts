import { sql, type ColumnType, type Kysely } from 'kysely';

/**
 * @ax/disk-quota owns tables under the `disk_quota_v1_` prefix (Invariant I4:
 * one source of truth per concept). Greenfield posture: additive ALTERs in
 * place. No foreign keys into other plugins' tables: `owner_id` is either the
 * auth provider's opaque user id or `team:<id>`, and a usage row must survive
 * whatever another plugin does to its own rows. Two things remove a usage row:
 *   - a `workspace:deleted` notice (the agent's repo is gone, so its bytes are
 *     free) drops that agent's `workspace:<agentId>` row for every owner;
 *   - the periodic sweep's BLOB PASS (design D6) drops an `(owner,
 *     blob:<sha>)` row once the row is older than the grace window AND every
 *     holder answering `blob:collect-refs` agrees that owner no longer holds
 *     that sha. Per owner, not per sha: someone else holding the same bytes
 *     keeps their own charge. Any doubt (a holder that failed, a holder that
 *     went missing) releases nothing.
 *
 * Tables:
 *   disk_quota_v1_usage — one row per (owner, source). `source` is
 *     `workspace:<agentId>` (the whole repo, re-measured) or `blob:<sha256>`
 *     (counted once per owner however often it is re-put; a re-put refreshes
 *     `updated_at`, which restarts the grace window). The primary key's
 *     `owner_id` prefix serves the per-owner sum; the all-owner admin view and
 *     the blob pass's stale-row scan are each over a small table, so no
 *     further index is added.
 *   disk_quota_v1_ref_holders — the blob pass's ROSTER: every holder name
 *     that has ever answered `blob:collect-refs`. A roster member that does
 *     not answer a later pass (it threw, or its plugin is no longer loaded)
 *     aborts that pass. Rows only leave through the admin "forget" route.
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

export interface DiskQuotaRefHoldersTable {
  holder: string;
  first_seen_at: ColumnType<Date, Date | undefined, Date>;
  last_seen_at: ColumnType<Date, Date | undefined, Date>;
}

export interface DiskQuotaDatabase {
  disk_quota_v1_usage: DiskQuotaUsageTable;
  disk_quota_v1_ref_holders: DiskQuotaRefHoldersTable;
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
  await sql`
    CREATE TABLE IF NOT EXISTS disk_quota_v1_ref_holders (
      holder         TEXT PRIMARY KEY,
      first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
}
