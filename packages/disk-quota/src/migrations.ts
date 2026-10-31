import { sql, type ColumnType, type Kysely } from 'kysely';

/**
 * @ax/disk-quota owns tables under the `disk_quota_v1_` prefix (Invariant I4:
 * one source of truth per concept). Greenfield posture: additive ALTERs in
 * place. No foreign keys into other plugins' tables: `owner_id` is either the
 * auth provider's opaque user id or `team:<id>`, and a usage row must survive
 * whatever another plugin does to its own rows. Three things remove a usage row:
 *   - a `workspace:deleted` notice (the agent's repo is gone, so its bytes are
 *     free) drops that agent's `workspace:<agentId>` row for every owner;
 *   - an `agents:deleted` notice (the agent and its `/files` are gone) drops
 *     that agent's `agent-files:<agentId>` row for every owner (TASK-993);
 *   - the periodic sweep's BLOB PASS (design D6) drops an `(owner,
 *     blob:<sha>)` row once the row is older than the grace window AND every
 *     holder answering `blob:collect-refs` agrees that owner no longer holds
 *     that sha AND the bytes stay paid for: a sha others hold goes only while
 *     one of them still has a row for it; a sha nobody holds goes only once
 *     `blob:stat` says its bytes are gone. Per owner, not per sha: someone
 *     else holding the same bytes keeps their own charge. Bytes that still
 *     exist are never left charged to nobody. Any doubt (a holder that failed,
 *     a holder that went missing, a `blob:stat` that cannot answer) releases
 *     nothing.
 *
 * Tables:
 *   disk_quota_v1_usage — one row per (owner, source). `source` is
 *     `agent-files:<agentId>` (kind `agent-files`: everything in that agent's
 *     `/files`, re-measured whole, TASK-993), `workspace:<agentId>` (the whole
 *     git repo, re-measured; the git tier, until TASK-995) or `blob:<sha256>`
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

export type UsageKind = 'workspace' | 'blob' | 'agent-files';

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
      kind        TEXT NOT NULL CHECK (kind IN ('workspace', 'blob', 'agent-files')),
      bytes       BIGINT NOT NULL CHECK (bytes >= 0),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, source)
    )
  `.execute(db);
  // TASK-993: widen the kind CHECK on a table created before 'agent-files'
  // existed. CREATE TABLE IF NOT EXISTS above does nothing to an existing
  // table, so a database migrated by an earlier release still carries the
  // two-kind constraint and would refuse every agent-files row.
  //
  // The constraint was declared inline, so Postgres auto-named it
  // `disk_quota_v1_usage_kind_check` (pinned by a test). It is re-created
  // under that SAME name, so there is only ever one kind check, and a fresh
  // database (whose inline check is already wide) is a no-op.
  //
  // Two host replicas can run this at once. The DO block is one transaction:
  // it first takes a transaction-scoped advisory lock, so the second replica
  // waits for the first to commit, then re-reads pg_constraint (READ
  // COMMITTED: each statement sees what has committed) and finds the widened
  // definition already there. The drop + add is ONE ALTER TABLE, so there is
  // no instant where the table has no kind check at all. The ADD re-validates
  // existing rows; each already passed the narrower check, so it cannot fail.
  await sql`
    DO $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('disk_quota_v1_usage_kind_check'));
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'disk_quota_v1_usage'::regclass
           AND conname = 'disk_quota_v1_usage_kind_check'
           AND pg_get_constraintdef(oid) LIKE '%agent-files%'
      ) THEN
        ALTER TABLE disk_quota_v1_usage
          DROP CONSTRAINT IF EXISTS disk_quota_v1_usage_kind_check,
          ADD CONSTRAINT disk_quota_v1_usage_kind_check
            CHECK (kind IN ('workspace', 'blob', 'agent-files'));
      END IF;
    END $$
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS disk_quota_v1_ref_holders (
      holder         TEXT PRIMARY KEY,
      first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
}
