import { sql, type ColumnType, type Generated, type Kysely, type Selectable } from 'kysely';

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

  // ---- W3d: file history (spec §7.2; plan 2026-10-18-w3d-history-undo-impl) ----
  //
  // Every history table's project_id REFERENCES projects_v1_projects ON DELETE
  // CASCADE (a same-plugin FK, so allowed): deleting a project takes its
  // history with it, and a pass or host write still running when the project
  // goes gets a foreign-key violation instead of leaving orphan rows (and
  // orphan blob refs) behind.
  //
  // projects_v1_file_versions — one row per recorded state of one file. Bytes
  // live in the blob store (`blob_sha`; null for a delete or a file too large
  // to keep). `owner_user_id` is whom `blob:put` charged (the project's owner),
  // so `blob:collect-refs` answers from this row alone. `author_agent_id` and
  // `conversation_id` are nulled on `agents:deleted` / `conversations:purged`
  // (the version stays: "a removed agent"). `seq` orders versions; created_at
  // ties within a millisecond (a preimage and the edit right after it).
  await sql`
    CREATE TABLE IF NOT EXISTS projects_v1_file_versions (
      seq             BIGSERIAL PRIMARY KEY,
      version_id      TEXT NOT NULL UNIQUE,
      project_id      TEXT NOT NULL REFERENCES projects_v1_projects(project_id) ON DELETE CASCADE,
      path            TEXT NOT NULL,
      blob_sha        TEXT NULL,
      size            BIGINT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('write', 'delete')),
      too_large       BOOLEAN NOT NULL DEFAULT FALSE,
      label           TEXT NOT NULL CHECK (label IN ('edit', 'agent', 'baseline', 'outside', 'restore', 'seed')),
      owner_user_id   TEXT NULL,
      author_user_id  TEXT NULL,
      author_agent_id TEXT NULL,
      conversation_id TEXT NULL,
      req_id          TEXT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS projects_v1_file_versions_path_idx
      ON projects_v1_file_versions (project_id, path, created_at DESC)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS projects_v1_file_versions_blob_idx
      ON projects_v1_file_versions (blob_sha) WHERE blob_sha IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS projects_v1_file_versions_agent_idx
      ON projects_v1_file_versions (author_agent_id) WHERE author_agent_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS projects_v1_file_versions_conversation_idx
      ON projects_v1_file_versions (conversation_id) WHERE conversation_id IS NOT NULL
  `.execute(db);
  // W3d-2: when the agent turn a version belongs to ended, as the turn-end
  // subscriber first saw it (before its background pass). Set only on `agent`
  // rows; the chat's "Updated project memory" chip matches a version to its
  // turn by this, since `created_at` is when the pass finished, which can be
  // after the person's next message. Additive and idempotent.
  await sql`
    ALTER TABLE projects_v1_file_versions ADD COLUMN IF NOT EXISTS turn_at TIMESTAMPTZ NULL
  `.execute(db);
  // projects_v1_file_manifest — what the last pass saw: one row per file, its
  // stat and (when read) its content hash. A pass diffs the next scan by
  // (size, mtime_ms, ino). DOUBLE PRECISION, not BIGINT, so the driver hands
  // back numbers (exact to 2^53, which every one of these fits).
  await sql`
    CREATE TABLE IF NOT EXISTS projects_v1_file_manifest (
      project_id TEXT NOT NULL REFERENCES projects_v1_projects(project_id) ON DELETE CASCADE,
      path       TEXT NOT NULL,
      size       DOUBLE PRECISION NOT NULL,
      mtime_ms   DOUBLE PRECISION NOT NULL,
      ino        DOUBLE PRECISION NOT NULL,
      sha256     TEXT NULL,
      PRIMARY KEY (project_id, path)
    )
  `.execute(db);
  // projects_v1_history_gaps — "history may be missing changes from around
  // <at>": a pass that failed or ran out of time.
  await sql`
    CREATE TABLE IF NOT EXISTS projects_v1_history_gaps (
      gap_id     BIGSERIAL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects_v1_projects(project_id) ON DELETE CASCADE,
      at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reason     TEXT NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS projects_v1_history_gaps_project_idx
      ON projects_v1_history_gaps (project_id, at DESC)
  `.execute(db);
  // projects_v1_history_state — a project whose history has started. A pass
  // over a project with no row here is the baseline ("Before history
  // started"); a new project gets its row at create (nothing came before).
  await sql`
    CREATE TABLE IF NOT EXISTS projects_v1_history_state (
      project_id TEXT PRIMARY KEY REFERENCES projects_v1_projects(project_id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
  // projects_v1_history_leases — a pass's lease on its project: one pass at a
  // time per project, across replicas, without holding a database connection
  // for the pass's length. A lease past `until` may be taken over; a pass
  // releases only its own `token`.
  await sql`
    CREATE TABLE IF NOT EXISTS projects_v1_history_leases (
      project_id TEXT PRIMARY KEY REFERENCES projects_v1_projects(project_id) ON DELETE CASCADE,
      token      TEXT NOT NULL,
      until      TIMESTAMPTZ NOT NULL
    )
  `.execute(db);
}

export type HistoryLabel = 'edit' | 'agent' | 'baseline' | 'outside' | 'restore' | 'seed';

export interface FileVersionsTable {
  seq: Generated<string>;
  version_id: string;
  project_id: string;
  path: string;
  blob_sha: string | null;
  /** BIGINT: the driver returns a string. */
  size: ColumnType<string, number, number>;
  kind: 'write' | 'delete';
  too_large: boolean;
  label: HistoryLabel;
  owner_user_id: string | null;
  author_user_id: string | null;
  author_agent_id: string | null;
  conversation_id: string | null;
  req_id: string | null;
  /** W3d-2: when the agent's turn ended (`agent` rows only); null otherwise. */
  turn_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: Generated<Date>;
}

export interface FileManifestTable {
  project_id: string;
  path: string;
  size: number;
  mtime_ms: number;
  ino: number;
  sha256: string | null;
}

export interface HistoryGapsTable {
  gap_id: Generated<string>;
  project_id: string;
  at: Generated<Date>;
  reason: string;
}

export interface HistoryStateTable {
  project_id: string;
  started_at: Generated<Date>;
}

export interface HistoryLeasesTable {
  project_id: string;
  token: string;
  until: Date;
}

export type FileVersionRow = Selectable<FileVersionsTable>;

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
  projects_v1_file_versions: FileVersionsTable;
  projects_v1_file_manifest: FileManifestTable;
  projects_v1_history_gaps: HistoryGapsTable;
  projects_v1_history_state: HistoryStateTable;
  projects_v1_history_leases: HistoryLeasesTable;
}
