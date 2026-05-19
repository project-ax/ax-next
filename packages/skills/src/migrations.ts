import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/skills owns tables under the `skills_v1_`
 * prefix — never reach into them from another plugin (Invariant I4 — one
 * source of truth per concept). Schema version is forward-only via a
 * future `v2` side-table, never an in-place ALTER.
 *
 * Single table:
 *   skills_v1_skills — admin-managed installed skills (manifest YAML +
 *   body markdown + version counter).
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
  created_at: Date;
  updated_at: Date;
}

export interface SkillsDatabase {
  skills_v1_skills: SkillsRow;
}
