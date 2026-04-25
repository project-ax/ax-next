import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. Each postgres-backed AX plugin owns its own
 * tables under a unique prefix — `storage_postgres_v1_` for this one.
 * No cross-plugin foreign keys (Invariant 4 + architecture doc Section 6).
 *
 * The `v1` in the prefix is the schema version. When the shape needs to
 * change incompatibly, we add a `v2` table and a forward-only migration —
 * we do NOT mutate v1 in place, because old code may still be reading it
 * during a rolling deploy.
 */
// The migration is schema-agnostic — it issues raw DDL via sql``.execute,
// which only needs the executor, not the type-level table map. The generic
// keeps callers free to pass in a `Kysely<MySchema>` without a cast.
export async function runStorageMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS storage_postgres_v1_kv (
      key TEXT PRIMARY KEY,
      value BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
}

export interface StorageKvRow {
  key: string;
  value: Buffer;
  updated_at: Date;
}

export interface StorageDatabase {
  storage_postgres_v1_kv: StorageKvRow;
}
