import { sql, type ColumnType, type Kysely } from 'kysely';
import type { DirectoryAuth, PublisherProof } from './contract.js';

/**
 * @ax/connector-directory owns the tables under the `connector_directory_v1_`
 * prefix (invariant 4: one source of truth); nothing else reads or writes
 * them, and they have no foreign keys.
 *
 *   connector_directory_v1_entries — the mirror: one row per server name (its
 *     latest version), written only by the sync, every text field already
 *     cleaned (normalize.ts). At most MAX_ROWS rows.
 *   connector_directory_v1_sync_state — exactly one row (id = 1): the registry
 *     the mirror was copied from, the checkpoint the next incremental sync
 *     asks from (OUR clock's start time of the last complete sync), when the
 *     copy was last complete, and how the last attempt went.
 *
 * Additive-only, idempotent: every boot runs it.
 */
export interface ConnectorDirectoryEntriesTable {
  id: string;
  title: string;
  description: string;
  publisher: string;
  publisher_proof: PublisherProof;
  url: string;
  auth: DirectoryAuth;
  key_header: string | null;
  version: string;
  updated_at: Date;
  deprecated: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface ConnectorDirectorySyncStateTable {
  id: number;
  source: string;
  watermark: ColumnType<Date | null, Date | null | undefined, Date | null>;
  synced_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  last_attempt_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  last_attempt_failed: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface ConnectorDirectoryDatabase {
  connector_directory_v1_entries: ConnectorDirectoryEntriesTable;
  connector_directory_v1_sync_state: ConnectorDirectorySyncStateTable;
}

export async function runConnectorDirectoryMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS connector_directory_v1_entries (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      description     TEXT NOT NULL,
      publisher       TEXT NOT NULL,
      publisher_proof TEXT NOT NULL CHECK (publisher_proof IN ('domain', 'account')),
      url             TEXT NOT NULL,
      auth            TEXT NOT NULL CHECK (auth IN ('signin', 'key', 'none')),
      key_header      TEXT NULL,
      version         TEXT NOT NULL,
      updated_at      TIMESTAMPTZ NOT NULL,
      deprecated      BOOLEAN NOT NULL DEFAULT false
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS connector_directory_v1_sync_state (
      id                  SMALLINT PRIMARY KEY CHECK (id = 1),
      source              TEXT NOT NULL,
      watermark           TIMESTAMPTZ NULL,
      synced_at           TIMESTAMPTZ NULL,
      last_attempt_at     TIMESTAMPTZ NULL,
      last_attempt_failed BOOLEAN NOT NULL DEFAULT false
    )
  `.execute(db);
}
