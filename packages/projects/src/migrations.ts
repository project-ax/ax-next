import { sql, type Generated, type Kysely, type Selectable } from 'kysely';

/**
 * Per-plugin migration. @ax/projects owns tables under the `projects_v1_`
 * prefix — never reach into them from another plugin (invariant I4 — one
 * source of truth per concept). Additive-only.
 *
 * projects_v1_projects — one row per project: a W2 shared folder plus a name.
 * Membership and ownership are NOT here: they are the folder's grants in
 * @ax/shared-folders, and repeating them would make two sources of truth.
 * There is deliberately no agent-keyed column, so this table needs no
 * `agents:deleted` handling: an owner agent's deletion either passes the
 * folder to an editor (the project survives) or tombstones it, and the
 * `shared-folders:deleted` subscriber removes the row.
 *
 * `folder_id` is an opaque key with no FK to shared_folders_v1_folders
 * (cross-plugin FKs are banned).
 */
export async function runProjectsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS projects_v1_projects (
      project_id      TEXT PRIMARY KEY,
      folder_id       TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      description     TEXT NULL,
      created_by_user TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
}

export interface ProjectsTable {
  project_id: string;
  folder_id: string;
  name: string;
  description: string | null;
  created_by_user: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ProjectRow = Selectable<ProjectsTable>;

export interface ProjectsDatabase {
  projects_v1_projects: ProjectsTable;
}
