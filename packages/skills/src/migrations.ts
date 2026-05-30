import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/skills owns tables under the `skills_v1_`
 * prefix — never reach into them from another plugin (Invariant I4 — one
 * source of truth per concept). Schema version is additive-only. New
 * columns land via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (idempotent,
 * forward-only). Destructive changes (drop column, rename, type change)
 * require a new `skills_v2_*` side-table instead.
 *
 * Tables:
 *   skills_v1_skills — admin-managed installed skills (manifest YAML +
 *   body markdown + version counter). Primary key: skill_id (TEXT).
 *
 *   skills_v1_user_skills — user-scoped private skill namespace. Each user
 *   can install their own private copy of a skill without affecting the
 *   admin-managed global list. Keyed by (owner_user_id, skill_id) compound
 *   primary key so the same skill_id can exist for multiple users
 *   independently.
 *
 *   skills_v1_user_attachments — per-(user, agent) skill activation (TASK-33).
 *   A self-serve layer that sits ABOVE the admin-managed agent-global
 *   attachments owned by @ax/agents: a user activates a catalog skill on
 *   THEIR agent without affecting others. Keyed by the compound primary key
 *   (owner_user_id, agent_id, skill_id). `agent_id` is an opaque scoping key
 *   — no FK to agents_v1_agents (cross-plugin FKs are banned; a dangling row
 *   to a deleted agent simply never resolves at session open).
 */
// Schema-agnostic: the executor only needs to issue raw DDL.
export async function runSkillsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_skills (
      skill_id      TEXT PRIMARY KEY,
      description   TEXT NOT NULL,
      manifest_yaml TEXT NOT NULL,
      body_md       TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    ALTER TABLE skills_v1_skills
      ADD COLUMN IF NOT EXISTS default_attached BOOLEAN NOT NULL DEFAULT false
  `.execute(db);

  await sql`
    ALTER TABLE skills_v1_skills
      ADD COLUMN IF NOT EXISTS source_url TEXT NULL
  `.execute(db);

  // Content address (sha256) of the bundle's EXTRA (non-SKILL.md) files. NULL =
  // a single-file (SKILL.md-only) skill. Originally a git tree OID (TASK-40);
  // out-of-git Part D2 swapped the byte-store to the shared `blob:*` store, so
  // this now holds the blob's sha256 (a content hash, not a git oid). The column
  // NAME is kept (additive-only migration policy; it's a storage detail that
  // never appears in a hook payload — bundles cross boundaries as files[]).
  await sql`
    ALTER TABLE skills_v1_skills
      ADD COLUMN IF NOT EXISTS bundle_tree_sha TEXT NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_user_skills (
      owner_user_id TEXT NOT NULL,
      skill_id      TEXT NOT NULL,
      description   TEXT NOT NULL,
      manifest_yaml TEXT NOT NULL,
      body_md       TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 0,
      source_url    TEXT NULL,
      default_attached BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, skill_id)
    )
  `.execute(db);

  // Same content-addressed bundle pointer for the user-scoped table (TASK-40).
  await sql`
    ALTER TABLE skills_v1_user_skills
      ADD COLUMN IF NOT EXISTS bundle_tree_sha TEXT NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_user_attachments (
      owner_user_id       TEXT NOT NULL,
      agent_id            TEXT NOT NULL,
      skill_id            TEXT NOT NULL,
      credential_bindings JSONB NOT NULL DEFAULT '{}',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, agent_id, skill_id)
    )
  `.execute(db);

  // skills_v1_skill_files — SUPERSEDED by the content-addressed git bundle
  // store (TASK-40, JIT git-tree backing). Extra bundle files now live as a
  // git tree keyed by skills_v1_skills.bundle_tree_sha /
  // skills_v1_user_skills.bundle_tree_sha. This table is no longer read or
  // written; it is RETAINED (not dropped) because the migration policy is
  // additive-only (destructive changes require a skills_v2 side-table). No
  // backfill: the multi-file write path was half-wired (no production caller)
  // from TASK-32 until TASK-40, so this table is empty in every deployment.
  // The CREATE remains so an old deployment's table keeps validating and the
  // migration stays idempotent.
  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_skill_files (
      scope         TEXT NOT NULL,
      owner_user_id TEXT NOT NULL DEFAULT '',
      skill_id      TEXT NOT NULL,
      path          TEXT NOT NULL,
      contents      TEXT NOT NULL,
      PRIMARY KEY (scope, owner_user_id, skill_id, path)
    )
  `.execute(db);

  // skills_v1_catalog_requests — the admit-to-catalog queue (JIT §6D, §11.6).
  // BOTH cold-start "a user needed X" requests AND share-to-catalog
  // submissions land here. A share request is an IMMUTABLE SNAPSHOT of the
  // source user-scoped skill at submit time: manifest_yaml/body_md verbatim
  // (the SKILL.md index) + bundle_tree_sha (the content-addressed pointer to
  // the extra-file bytes, NULL for a single-file skill). Snapshotting at
  // submit guarantees the bytes the admin reviews are exactly the bytes
  // admit promotes (no review-vs-ship drift). Cold-start rows carry NULL for
  // all three snapshot columns. `source_owner_user_id` is the user whose
  // editable working copy admit retires (NULL for cold-start). `status`:
  // 'pending' | 'admitted' | 'rejected'.
  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_catalog_requests (
      request_id           TEXT PRIMARY KEY,
      kind                 TEXT NOT NULL,
      skill_id             TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL,
      source_owner_user_id TEXT NULL,
      status               TEXT NOT NULL DEFAULT 'pending',
      description          TEXT NOT NULL DEFAULT '',
      manifest_yaml        TEXT NULL,
      body_md              TEXT NULL,
      bundle_tree_sha      TEXT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at           TIMESTAMPTZ NULL,
      decided_by_user_id   TEXT NULL
    )
  `.execute(db);

  // Dedup: at most one PENDING request per skill_id (a decided request frees
  // the id for re-submission). Partial unique index — the DB enforces the
  // §13 "deduped" guarantee even under a SELECT-then-INSERT race.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS skills_v1_catalog_requests_one_pending
      ON skills_v1_catalog_requests (skill_id)
      WHERE status = 'pending'
  `.execute(db);

  // skills_v1_quarantine — per-(user, agent, skill) draft-skill safety status
  // (Phase 2). Set by the @ax/validator-skill commit scan (accept-but-annotate),
  // read by the host discovery projection (Phase 3) to OMIT a quarantined draft.
  // `agent_id` is an opaque scoping key — no FK to agents_v1_agents (cross-plugin
  // FKs are banned; a dangling row to a deleted agent simply never resolves).
  // Additive-only.
  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_quarantine (
      owner_user_id TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      skill_id      TEXT NOT NULL,
      reason        TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, agent_id, skill_id)
    )
  `.execute(db);

  // skills_v1_approved_caps — per-(user, agent, skill, capability) approval
  // metadata (Phase 4). Each row records ONE capability a human approved at the
  // wall for a self-authored draft. `approved = union of rows`; the host
  // discovery projection grants `proposal ∩ approved`. The bundle frontmatter is
  // the proposal source of truth; this table is thin approval metadata (I4).
  // `agent_id` is an opaque scoping key — no FK to agents_v1_agents (cross-plugin
  // FKs are banned). `cap_detail` is optional display/audit JSON (slot kind +
  // account, or an MCP spec); the projection matches on (cap_kind, cap_value)
  // only. Additive-only.
  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_approved_caps (
      owner_user_id TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      skill_id      TEXT NOT NULL,
      cap_kind      TEXT NOT NULL,
      cap_value     TEXT NOT NULL,
      cap_detail    JSONB NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, agent_id, skill_id, cap_kind, cap_value)
    )
  `.execute(db);
}

/**
 * Row shape returned by postgres. Store helpers parse/validate before
 * returning to plugin code.
 */
export interface SkillsRow {
  skill_id: string;
  description: string;
  manifest_yaml: string;
  body_md: string;
  version: number;
  default_attached: boolean;
  source_url: string | null;
  /** Root git tree SHA of the bundle's EXTRA (non-SKILL.md) files. NULL = single-file skill. */
  bundle_tree_sha: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Row shape for the user-scoped skills side-table. Mirrors SkillsRow but
 * adds owner_user_id as the first part of the compound primary key
 * (owner_user_id, skill_id).
 */
export interface UserSkillsRow {
  owner_user_id: string;
  skill_id: string;
  description: string;
  manifest_yaml: string;
  body_md: string;
  version: number;
  default_attached: boolean;
  source_url: string | null;
  /** Root git tree SHA of the bundle's EXTRA (non-SKILL.md) files. NULL = single-file skill. */
  bundle_tree_sha: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Per-(user, agent) skill activation. Self-serve layer that sits ABOVE the
 * admin-managed agent-global attachments owned by @ax/agents. `agent_id` is
 * an opaque scoping key — no FK to agents_v1_agents (cross-plugin FKs are
 * banned; a dangling row to a deleted agent simply never resolves at session
 * open). `credential_bindings` is a JSONB slot → opaque-ref map (never a
 * secret), mirroring the agent-global attachment shape.
 */
export interface UserAttachmentRow {
  owner_user_id: string;
  agent_id: string;
  skill_id: string;
  credential_bindings: unknown; // JSONB Record<string,string>; store casts on read
  created_at: Date;
  updated_at: Date;
}

/**
 * Row shape for the bundle extra-files side-table. One row per non-SKILL.md
 * file in a skill bundle. `scope` distinguishes global vs user skills;
 * `owner_user_id` is '' for global rows and the user id for user-scoped rows,
 * mirroring the owning skills table's keying.
 */
export interface SkillFileRow {
  scope: 'global' | 'user';
  owner_user_id: string; // '' for global
  skill_id: string;
  path: string;
  contents: string;
}

/**
 * Admit-queue request row. A share request snapshots the source user-scoped
 * skill (manifest_yaml/body_md verbatim + bundle_tree_sha pointer); a
 * cold-start request leaves the snapshot columns NULL. `bundle_tree_sha` is a
 * storage detail — never surfaced in a hook payload (bundles cross hook
 * boundaries as files[]).
 */
export interface CatalogRequestRow {
  request_id: string;
  kind: 'share' | 'cold-start';
  skill_id: string;
  requested_by_user_id: string;
  source_owner_user_id: string | null;
  status: 'pending' | 'admitted' | 'rejected';
  description: string;
  manifest_yaml: string | null;
  body_md: string | null;
  bundle_tree_sha: string | null;
  created_at: Date;
  updated_at: Date;
  decided_at: Date | null;
  decided_by_user_id: string | null;
}

/**
 * Per-(user, agent, skill) draft-skill quarantine status. `reason` is the
 * safety-scan verdict surfaced to the agent + a human. Storage detail only — the
 * hook surface carries ownerUserId/agentId/skillId/reason, not row vocabulary.
 */
export interface QuarantineRow {
  owner_user_id: string;
  agent_id: string;
  skill_id: string;
  reason: string;
  created_at: Date;
}

/**
 * Per-(user, agent, skill, capability) approval row (Phase 4). One row per
 * approved capability. `cap_kind` ∈ 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';
 * `cap_value` is the host / slot name / package name / mcp server name. Storage
 * detail only — the hook surface carries {kind, value}, never row vocabulary.
 */
export interface ApprovedCapRow {
  owner_user_id: string;
  agent_id: string;
  skill_id: string;
  cap_kind: string;
  cap_value: string;
  cap_detail: unknown | null; // JSONB; nullable
  created_at: Date;
}

export interface SkillsDatabase {
  skills_v1_skills: SkillsRow;
  skills_v1_user_skills: UserSkillsRow;
  skills_v1_user_attachments: UserAttachmentRow;
  skills_v1_skill_files: SkillFileRow;
  skills_v1_catalog_requests: CatalogRequestRow;
  skills_v1_quarantine: QuarantineRow;
  skills_v1_approved_caps: ApprovedCapRow;
}
