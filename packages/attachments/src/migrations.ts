import { sql, type Kysely } from 'kysely';

/**
 * @ax/attachments owns tables under the `attachments_v1_` prefix
 * (Invariant I4 — one source of truth per concept). The greenfield
 * posture matches @ax/conversations: pure-additive ALTERs in place
 * forever; no v1 → v2 split.
 *
 * Tables:
 *   attachments_v1_temps — pending uploads keyed by attachmentId.
 *
 * The `bytes` column is BYTEA — fine up to the default 25 MiB cap.
 * A future @ax/attachments-pg-bytea-only impl (no LFS) would keep this
 * same shape for durable storage; today the temp store is the only
 * caller, so bytes here are short-lived (TTL default 10 min).
 *
 * Indexes:
 *   - user_id: for the per-user pending-bytes quota query.
 *   - expires_at: for the TTL janitor's WHERE expires_at <= now() sweep.
 */
export interface AttachmentTempsTable {
  attachment_id: string;
  user_id: string;
  bytes: Buffer;
  display_name: string;
  media_type: string;
  size_bytes: number;
  expires_at: Date;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// TASK-68 (out-of-git Part C): durable metadata rows for committed uploads and
// published artifacts. The BYTES live in the content-addressed blob store
// (blob:put); these rows map (conversationId, path) → sha256 + display metadata
// so the download ACL and the runner's session-start materialization can resolve
// a path back to its blob. NO bytes here — that's the blob store's job (one
// source of truth per concept, I4).
//
// `sha256` is the OWN content digest of the file (storage-agnostic identity, the
// same value the alternate @ax/attachments-pg-bytea-only impl would compute), NOT
// a git sha / backend pointer — so it's allowed (I1). The `path` is the
// workspace-relative key the transcript + download ACL already use.
//
// Files (inbound uploads) and artifacts (outbound deliverables) get separate
// tables — same shape but distinct lifecycles + namespaces. Both are owned by
// @ax/attachments (which also owns the download ACL that resolves either).
// ---------------------------------------------------------------------------
export interface AttachmentFilesTable {
  attachment_id: string;
  conversation_id: string;
  user_id: string;
  sha256: string;
  path: string;
  display_name: string;
  media_type: string;
  size_bytes: number;
  created_at: Date;
}

export interface ArtifactFilesTable {
  artifact_id: string;
  conversation_id: string;
  user_id: string;
  sha256: string;
  path: string;
  display_name: string;
  media_type: string;
  size_bytes: number;
  created_at: Date;
}

export interface AttachmentsDatabase {
  attachments_v1_temps: AttachmentTempsTable;
  attachments_v1_files: AttachmentFilesTable;
  attachments_v1_artifacts: ArtifactFilesTable;
}

export async function runAttachmentsMigration<DB>(
  db: Kysely<DB>,
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attachments_v1_temps (
      attachment_id  TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      bytes          BYTEA NOT NULL,
      display_name   TEXT NOT NULL,
      media_type     TEXT NOT NULL,
      size_bytes     BIGINT NOT NULL CHECK (size_bytes >= 0),
      expires_at     TIMESTAMPTZ NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS attachments_v1_temps_user_id_idx
      ON attachments_v1_temps (user_id)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS attachments_v1_temps_expires_at_idx
      ON attachments_v1_temps (expires_at)
  `.execute(db);

  // Committed uploads. (conversation_id, path) is the natural key the download
  // ACL + the runner's materialize loop resolve against; UNIQUE so a re-commit
  // of the same path upserts rather than duplicating.
  await sql`
    CREATE TABLE IF NOT EXISTS attachments_v1_files (
      attachment_id   TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      sha256          TEXT NOT NULL,
      path            TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      media_type      TEXT NOT NULL,
      size_bytes      BIGINT NOT NULL CHECK (size_bytes >= 0),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (conversation_id, path)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS attachments_v1_files_conversation_id_idx
      ON attachments_v1_files (conversation_id)
  `.execute(db);

  // Published artifacts. Same shape; separate namespace + lifecycle (outbound).
  await sql`
    CREATE TABLE IF NOT EXISTS attachments_v1_artifacts (
      artifact_id     TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      sha256          TEXT NOT NULL,
      path            TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      media_type      TEXT NOT NULL,
      size_bytes      BIGINT NOT NULL CHECK (size_bytes >= 0),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (conversation_id, path)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS attachments_v1_artifacts_conversation_id_idx
      ON attachments_v1_artifacts (conversation_id)
  `.execute(db);
}
