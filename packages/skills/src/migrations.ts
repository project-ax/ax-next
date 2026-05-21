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
  created_at: Date;
  updated_at: Date;
}

export interface SkillsDatabase {
  skills_v1_skills: SkillsRow;
  skills_v1_user_skills: UserSkillsRow;
}
