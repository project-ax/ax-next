import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/connectors owns tables under the `connectors_v1_`
 * prefix — never reach into them from another plugin (Invariant I4 — one
 * source of truth per concept). ax-next is greenfield (no production data ever),
 * so the `_v1` suffix is a stable identifier, NOT a version pointer: every
 * schema change is an idempotent in-place `IF NOT EXISTS` / `ADD COLUMN IF NOT
 * EXISTS`, never a v1→v2 side-table split.
 *
 * Tables:
 *   connectors_v1_connectors — the connector entity, owned by `owner_user_id`.
 *
 * `default_attached` (TASK-97) flags a connector as a workspace DEFAULT — it
 * flows into every agent's effective connector set the same way a
 * `default_attached` skill does (mirrors `skills_v1_skills.default_attached`).
 * The orchestrator reads it via `connectors:list-defaults`. Added as an
 * idempotent in-place `ADD COLUMN IF NOT EXISTS` (greenfield — no v1→v2 split).
 *
 * No FK to auth/agents/skills tables — a cross-plugin FK would require a shared
 * schema migration, which violates I4. Ownership is enforced at hook time by
 * the `owner_user_id` predicate (the tenant-scope helper in `scope.ts`), not by
 * a DB-level relationship.
 *
 * Soft delete: `deleted_at` is nullable; the owner index excludes tombstones
 * via a partial WHERE so list-by-owner stays fast.
 */
// Schema-agnostic: the executor only needs to issue raw DDL.
export async function runConnectorsMigration<DB>(
  db: Kysely<DB>,
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS connectors_v1_connectors (
      owner_user_id TEXT NOT NULL,
      connector_id  TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      usage_note    TEXT NOT NULL DEFAULT '',
      key_mode      TEXT NOT NULL
        CHECK (key_mode IN ('personal', 'workspace')),
      visibility    TEXT NOT NULL
        CHECK (visibility IN ('private', 'shared')),
      capabilities  JSONB NOT NULL,
      deleted_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, connector_id)
    )
  `.execute(db);

  // Owner list index excludes tombstones so list-by-owner stays fast even with
  // many soft-deleted rows. Idempotent (IF NOT EXISTS).
  await sql`
    CREATE INDEX IF NOT EXISTS connectors_v1_connectors_owner
      ON connectors_v1_connectors (owner_user_id)
      WHERE deleted_at IS NULL
  `.execute(db);

  // TASK-97 — workspace-default flag. A default-attached connector flows into
  // every agent's effective connector set (the orchestrator reads these via
  // `connectors:list-defaults`). Idempotent ADD COLUMN; NOT NULL DEFAULT false
  // so every pre-existing row is "not a default" until explicitly flagged.
  await sql`
    ALTER TABLE connectors_v1_connectors
      ADD COLUMN IF NOT EXISTS default_attached BOOLEAN NOT NULL DEFAULT false
  `.execute(db);
}

/**
 * Row shape — `capabilities` is JSONB and deserializes to `unknown` until
 * validated. Store helpers parse/validate against `CapabilitiesSchema` before
 * returning to plugin code (the same don't-trust-the-DB posture as the
 * conversations ContentBlock column).
 */
export interface ConnectorsRow {
  owner_user_id: string;
  connector_id: string;
  name: string;
  description: string;
  usage_note: string;
  key_mode: string;
  visibility: string;
  capabilities: unknown;
  /** TASK-97 — workspace-default flag (see migration). */
  default_attached: boolean;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ConnectorDatabase {
  connectors_v1_connectors: ConnectorsRow;
}
