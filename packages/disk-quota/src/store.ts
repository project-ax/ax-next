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

  // ---- the blob pass (design D6) ------------------------------------------
  /**
   * Distinct shas of `blob:<sha>` rows last written before `cutoff`, in sha
   * order, strictly after `afterSha` (a cursor), at most `limit`. Only rows
   * whose source is `blob:` + 64 lowercase hex are ever candidates: a holder
   * rejects a candidate list WHOLE if any entry is not a sha256, so one odd
   * row must not stall every pass. Other blob rows are never released.
   */
  staleBlobShas(cutoff: Date, afterSha: string | undefined, limit: number): Promise<string[]>;
  /** Every (owner, sha) blob row for these shas last written before `cutoff`. */
  staleBlobRows(shas: readonly string[], cutoff: Date): Promise<BlobRow[]>;
  /**
   * Delete these `(owner, blob:<sha>)` rows, but only those STILL older than
   * `cutoff`: the age is re-checked inside the DELETE, so a re-put that
   * landed between the select and now (it refreshes `updated_at`) keeps its
   * row. Resolves how many rows went.
   */
  releaseBlobRows(rows: readonly BlobRow[], cutoff: Date): Promise<number>;
  /** The roster: every holder that has ever answered `blob:collect-refs`. */
  listRefHolders(): Promise<string[]>;
  /** Add these holders to the roster, or bump their `last_seen_at`. */
  touchRefHolders(names: readonly string[]): Promise<void>;
  /** Drop one holder from the roster. Resolves whether it was there. */
  forgetRefHolder(name: string): Promise<boolean>;
}

export interface BlobRow {
  ownerId: string;
  sha256: string;
}

const BLOB_SOURCE_RE = '^blob:[0-9a-f]{64}$';

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

    async staleBlobShas(cutoff, afterSha, limit) {
      const cap = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
      const after = afterSha === undefined ? null : `blob:${afterSha}`;
      // COLLATE "C": the cursor comparison and the ORDER BY must agree byte for
      // byte, whatever the database's default collation is.
      const res = await sql<{ source: string }>`
        SELECT DISTINCT source COLLATE "C" AS source
        FROM disk_quota_v1_usage
        WHERE kind = 'blob'
          AND updated_at < ${cutoff}
          AND source ~ ${BLOB_SOURCE_RE}
          AND (${after}::text IS NULL OR source COLLATE "C" > ${after}::text COLLATE "C")
        ORDER BY 1
        LIMIT ${cap}
      `.execute(db);
      return res.rows.map((r) => r.source.slice('blob:'.length));
    },

    async staleBlobRows(shas, cutoff) {
      if (shas.length === 0) return [];
      const sources = shas.map((s) => `blob:${s}`);
      const res = await sql<{ owner_id: string; source: string }>`
        SELECT owner_id, source
        FROM disk_quota_v1_usage
        WHERE kind = 'blob'
          AND updated_at < ${cutoff}
          AND source = ANY(${sources}::text[])
        ORDER BY source, owner_id
      `.execute(db);
      return res.rows.map((r) => ({ ownerId: r.owner_id, sha256: r.source.slice('blob:'.length) }));
    },

    async releaseBlobRows(rows, cutoff) {
      if (rows.length === 0) return 0;
      const owners = rows.map((r) => r.ownerId);
      const sources = rows.map((r) => `blob:${r.sha256}`);
      const res = await sql`
        DELETE FROM disk_quota_v1_usage u
        USING unnest(${owners}::text[], ${sources}::text[]) AS t(owner_id, source)
        WHERE u.owner_id = t.owner_id
          AND u.source = t.source
          AND u.kind = 'blob'
          AND u.updated_at < ${cutoff}
      `.execute(db);
      return Number(res.numAffectedRows ?? 0);
    },

    async listRefHolders() {
      const rows = await db
        .selectFrom('disk_quota_v1_ref_holders')
        .select('holder')
        .orderBy('holder')
        .execute();
      return rows.map((r) => r.holder);
    },

    async touchRefHolders(names) {
      const unique = [...new Set(names)];
      if (unique.length === 0) return;
      await db
        .insertInto('disk_quota_v1_ref_holders')
        .values(unique.map((holder) => ({ holder })))
        .onConflict((oc) => oc.column('holder').doUpdateSet({ last_seen_at: sql<Date>`now()` }))
        .execute();
    },

    async forgetRefHolder(name) {
      const res = await db
        .deleteFrom('disk_quota_v1_ref_holders')
        .where('holder', '=', name)
        .executeTakeFirst();
      return Number(res.numDeletedRows) > 0;
    },
  };
}
