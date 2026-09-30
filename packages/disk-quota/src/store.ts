import { sql, type Kysely } from 'kysely';
import type { DiskQuotaDatabase, UsageKind } from './migrations.js';

// ---------------------------------------------------------------------------
// Every query against `disk_quota_v1_*` lives in this file (the
// `local/no-bare-tenant-tables` lint rule keeps it that way).
// ---------------------------------------------------------------------------

export interface OwnerUsage {
  /** Bytes held by the owner's agent workspaces (git repos, whole history). */
  workspaceBytes: number;
  /** Bytes of the owner's uploaded and published files (blobs). */
  fileBytes: number;
}

export interface OwnerUsageRow extends OwnerUsage {
  ownerId: string;
}

export interface UsageTotals {
  /** How many owners have any row at all. */
  owners: number;
  /** Bytes across every owner. */
  bytes: number;
}

export interface DiskQuotaStore {
  /**
   * Record that `source` holds `bytes` for `ownerId`. Idempotent: the same
   * (owner, source) is ONE row whose bytes are replaced, never added to, so
   * re-putting the same blob or re-measuring a workspace cannot double count.
   */
  upsertUsage(ownerId: string, source: string, kind: UsageKind, bytes: number): Promise<void>;
  /**
   * Drop the workspace row for `agentId`, whichever owner it is charged to (a
   * team agent's row sits under `team:<id>`, a fallback-charged one under the
   * acting user), and resolve how many rows went. Keyed on the AGENT alone on
   * purpose: the agent is already deleted, so nobody can ask who owned it.
   * Blob rows are never touched. Idempotent: a second call returns 0.
   */
  deleteWorkspaceUsage(agentId: string): Promise<number>;
  usageFor(ownerId: string): Promise<OwnerUsage>;
  /** The biggest owners first (by workspace + file bytes, ties by id). */
  topOwners(limit: number): Promise<OwnerUsageRow[]>;
  totals(): Promise<UsageTotals>;
}

/** pg returns SUM(bigint) as a numeric string (or null over zero rows). */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A clamp for values written to the ledger: whole, non-negative, finite. */
function whole(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : 0;
}

export function createDiskQuotaStore(db: Kysely<DiskQuotaDatabase>): DiskQuotaStore {
  return {
    async upsertUsage(ownerId, source, kind, bytes) {
      const value = whole(bytes);
      await db
        .insertInto('disk_quota_v1_usage')
        .values({ owner_id: ownerId, source, kind, bytes: value })
        .onConflict((oc) =>
          oc.columns(['owner_id', 'source']).doUpdateSet({
            bytes: value,
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
    },

    async deleteWorkspaceUsage(agentId) {
      // Plain equality on the whole source, not LIKE: the agent id is data, so a
      // `%` or `_` in it must not reach a neighbour's row. The primary key leads
      // with `owner_id`, so this is a scan of a small table; an agent delete is
      // rare and nobody waits on it, so it does not earn an index of its own.
      const res = await db
        .deleteFrom('disk_quota_v1_usage')
        .where('source', '=', `workspace:${agentId}`)
        .where('kind', '=', 'workspace')
        .executeTakeFirst();
      return Number(res.numDeletedRows);
    },

    async usageFor(ownerId) {
      const res = await sql<{ workspace_bytes: string | null; file_bytes: string | null }>`
        SELECT
          SUM(bytes) FILTER (WHERE kind = 'workspace') AS workspace_bytes,
          SUM(bytes) FILTER (WHERE kind = 'blob') AS file_bytes
        FROM disk_quota_v1_usage
        WHERE owner_id = ${ownerId}
      `.execute(db);
      const row = res.rows[0];
      return { workspaceBytes: num(row?.workspace_bytes), fileBytes: num(row?.file_bytes) };
    },

    async topOwners(limit) {
      const cap = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 200));
      const res = await sql<{
        owner_id: string;
        workspace_bytes: string | null;
        file_bytes: string | null;
      }>`
        SELECT
          owner_id,
          SUM(bytes) FILTER (WHERE kind = 'workspace') AS workspace_bytes,
          SUM(bytes) FILTER (WHERE kind = 'blob') AS file_bytes
        FROM disk_quota_v1_usage
        GROUP BY owner_id
        ORDER BY SUM(bytes) DESC, owner_id ASC
        LIMIT ${cap}
      `.execute(db);
      return res.rows.map((r) => ({
        ownerId: r.owner_id,
        workspaceBytes: num(r.workspace_bytes),
        fileBytes: num(r.file_bytes),
      }));
    },

    async totals() {
      const res = await sql<{ owners: string; bytes: string | null }>`
        SELECT COUNT(DISTINCT owner_id) AS owners, SUM(bytes) AS bytes
        FROM disk_quota_v1_usage
      `.execute(db);
      const row = res.rows[0];
      return { owners: num(row?.owners), bytes: num(row?.bytes) };
    },
  };
}
