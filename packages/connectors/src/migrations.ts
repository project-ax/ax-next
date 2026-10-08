import { sql, type Generated, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/connectors owns tables under the `connectors_v1_`
 * prefix — never reach into them from another plugin (Invariant I4 — one
 * source of truth per concept). ax-next is greenfield (no production data ever),
 * so the `_v1` suffix is a stable identifier, NOT a version pointer: every
 * schema change is an idempotent in-place `IF NOT EXISTS` / `ADD COLUMN IF NOT
 * EXISTS`, never a v1→v2 side-table split.
 *
 * Tables:
 *   connectors_v1_connectors — the LIVE connector entity, owned by
 *     `owner_user_id`. The activated/registry form.
 *   connectors_v1_authored   — agent-authored connector DRAFTS (TASK-94),
 *     keyed `(owner_user_id, agent_id, connector_id)`. A distinct per-(user,
 *     agent) lifecycle from the live registry — mirrors `skills_v1_authored`
 *     vs the global/user skill stores. A `pending` draft grants ZERO reach
 *     (it never reaches `connectors:resolve`, which reads only the live table)
 *     until a human approves it at the capability wall and it flips `active`.
 *
 * `default_attached` (TASK-97) once flagged a connector as the owner's DEFAULT
 * (effective on every agent that owner could chat with, no attachment needed).
 * "Set default" is retired (TASK-808): NOTHING writes the column any more and no
 * code path treats it as reach. It is kept — no destructive migration — only so
 * the transitional `connectors:list-legacy-defaults` / `connectors:clear-legacy-default`
 * hooks can let `@ax/agents` convert each still-flagged row into explicit
 * attachments at boot and then clear it. Drop the column once every database has
 * been through one boot of that conversion. Added as an idempotent in-place
 * `ADD COLUMN IF NOT EXISTS` (greenfield — no v1→v2 split).
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

  // TASK-97 — the retired workspace-default flag (see the header: TASK-808 kept
  // the column, only the conversion hooks read it). Idempotent ADD COLUMN;
  // NOT NULL DEFAULT false so an upsert that omits it writes "not a default".
  // It stays so a database that still holds flagged rows keeps them until
  // `@ax/agents` converts them to attachments.
  await sql`
    ALTER TABLE connectors_v1_connectors
      ADD COLUMN IF NOT EXISTS default_attached BOOLEAN NOT NULL DEFAULT false
  `.execute(db);

  // Existing definitions retain the legacy implicit owner attachment. New
  // definitions are marked by the store and require an explicit agent/skill
  // attachment.
  await sql`
    ALTER TABLE connectors_v1_connectors
      ADD COLUMN IF NOT EXISTS requires_attachment BOOLEAN NOT NULL DEFAULT false
  `.execute(db);

  // SIGNINS-9 (slice 7) — every connector is shared: drop the retired visibility column + its index.
  await sql`DROP INDEX IF EXISTS connectors_v1_connectors_shared`.execute(db);
  await sql`ALTER TABLE connectors_v1_connectors DROP COLUMN IF EXISTS visibility`.execute(db);
  // Its replacement: a NON-unique index on live ids, for every by-id lookup
  // and the duplicate check. Deliberately not UNIQUE — an existing duplicate
  // would fail boot; a unique index (closing the create race) is a follow-up.
  await sql`
    CREATE INDEX IF NOT EXISTS connectors_v1_connectors_live_id
      ON connectors_v1_connectors (connector_id)
      WHERE deleted_at IS NULL
  `.execute(db);

  // TASK-94 — agent-authored connector drafts. Keyed per-(owner, agent,
  // connector) because an authored draft is THIS agent's model-generated
  // proposal (the approved-caps wall is also per-(owner, agent, subject)); the
  // live `connectors_v1_connectors` table is per-(owner, connector) with no
  // agent dimension. `capability_proposal` is the declared, UNAPPROVED
  // mechanism-agnostic surface (the same opaque Capabilities JSONB); it is
  // stored verbatim and never interpreted. `status` is the gate verdict —
  // `pending` (zero reach, awaiting a human) or `active` (approved).
  await sql`
    CREATE TABLE IF NOT EXISTS connectors_v1_authored (
      owner_user_id       TEXT NOT NULL,
      agent_id            TEXT NOT NULL,
      connector_id        TEXT NOT NULL,
      name                TEXT NOT NULL,
      usage_note          TEXT NOT NULL DEFAULT '',
      key_mode            TEXT NOT NULL
        CHECK (key_mode IN ('personal', 'workspace')),
      capability_proposal JSONB NOT NULL,
      status              TEXT NOT NULL
        CHECK (status IN ('pending', 'active')),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, agent_id, connector_id)
    )
  `.execute(db);

  // Per-(owner, agent) draft listing (the card source + grant re-resolution).
  await sql`
    CREATE INDEX IF NOT EXISTS connectors_v1_authored_owner_agent
      ON connectors_v1_authored (owner_user_id, agent_id)
  `.execute(db);

  // Slice 2b — one-shot boot steps this plugin has COMPLETED, keyed by a
  // constant step name (e.g. the non-admin connector removal). A row means
  // "done, never run again"; it is written only after a complete pass.
  await sql`
    CREATE TABLE IF NOT EXISTS connectors_v1_boot_steps (
      name    TEXT PRIMARY KEY,
      done_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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
  capabilities: unknown;
  /**
   * TASK-97, retired by TASK-808 — see the migration header. `Generated` so no
   * insert has to name it (the DB default is false); only the transitional
   * `listLegacyDefaults` / `clearLegacyDefault` store methods touch it.
   */
  default_attached: Generated<boolean>;
  requires_attachment: Generated<boolean>;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Authored-connector draft row — `capability_proposal` is JSONB and
 * deserializes to `unknown` until validated against `CapabilitiesSchema` (same
 * don't-trust-the-DB posture as `connectors_v1_connectors.capabilities`).
 */
export interface ConnectorsAuthoredRow {
  owner_user_id: string;
  agent_id: string;
  connector_id: string;
  name: string;
  usage_note: string;
  key_mode: string;
  capability_proposal: unknown;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/** Slice 2b — a completed one-shot boot step (see the migration). */
export interface ConnectorsBootStepRow {
  name: string;
  done_at: Generated<Date>;
}

export interface ConnectorDatabase {
  connectors_v1_connectors: ConnectorsRow;
  connectors_v1_authored: ConnectorsAuthoredRow;
  connectors_v1_boot_steps: ConnectorsBootStepRow;
}
