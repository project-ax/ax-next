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

export interface AttachmentsDatabase {
  attachments_v1_temps: AttachmentTempsTable;
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
}
