import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/shared-folders owns tables under the
 * `shared_folders_v1_` prefix — never reach into them from another plugin
 * (invariant I4 — one source of truth per concept). Additive-only.
 *
 * shared_folders_v1_folders — one row per folder. There is deliberately NO
 * owner column: ownership is the single `role = 'owner'` grant (one source of
 * truth; decision AXWM-2). `deleted_at` is the tombstone set while the
 * folder's bytes are being removed; `cleanup_attempts` / `next_cleanup_at`
 * drive the sweep's backoff.
 *
 * shared_folders_v1_grants — who may mount a folder, and how. Exactly one
 * owner per folder (the unique partial index), at most one grant per
 * (folder, agent) (the primary key). `agent_id` is an opaque key with no FK to
 * agents_v1_agents (cross-plugin FKs are banned); this plugin subscribes to
 * `agents:deleted` and removes the agent's rows itself.
 */
export async function runSharedFoldersMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS shared_folders_v1_folders (
      folder_id        TEXT PRIMARY KEY,
      created_by_user  TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at       TIMESTAMPTZ NULL,
      cleanup_attempts INTEGER NOT NULL DEFAULT 0,
      next_cleanup_at  TIMESTAMPTZ NULL
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS shared_folders_v1_grants (
      folder_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      role            TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      granted_by_user TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (folder_id, agent_id)
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS shared_folders_v1_grants_one_owner
      ON shared_folders_v1_grants (folder_id) WHERE role = 'owner'
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS shared_folders_v1_grants_agent
      ON shared_folders_v1_grants (agent_id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS shared_folders_v1_folders_due_cleanup
      ON shared_folders_v1_folders (next_cleanup_at) WHERE deleted_at IS NOT NULL
  `.execute(db);
}

export type SharedFolderRole = 'owner' | 'editor' | 'viewer';

export interface SharedFolderRow {
  folder_id: string;
  created_by_user: string;
  created_at: Date;
  deleted_at: Date | null;
  cleanup_attempts: number;
  next_cleanup_at: Date | null;
}

export interface SharedFolderGrantRow {
  folder_id: string;
  agent_id: string;
  role: SharedFolderRole;
  granted_by_user: string;
  created_at: Date;
}

export interface SharedFoldersDatabase {
  shared_folders_v1_folders: SharedFolderRow;
  shared_folders_v1_grants: SharedFolderGrantRow;
}
