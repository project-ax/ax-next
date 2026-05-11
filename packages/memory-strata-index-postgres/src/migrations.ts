import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration for @ax/memory-strata-index-postgres.
 *
 * Creates a tsvector + GIN index over docs/ memory strata.
 * Weights: summary=A (most important), headers=B, body=C.
 * The `search_tsv` column is GENERATED ALWAYS (STORED) — Postgres
 * updates it automatically on every INSERT/UPDATE at the storage layer.
 *
 * Schema-agnostic helper (mirrors runStorageMigration): callers pass
 * Kysely<anything> and we issue raw DDL via sql``.execute().
 */
export async function runIndexMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS memory_strata_index_v1_docs (
      doc_id    TEXT PRIMARY KEY,
      category  TEXT NOT NULL,
      slug      TEXT NOT NULL,
      summary   TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      body      TEXT NOT NULL,
      headers   TEXT NOT NULL,
      search_tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(headers, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(body,    '')), 'C')
      ) STORED
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS memory_strata_index_v1_docs_tsv_gin
      ON memory_strata_index_v1_docs
      USING GIN (search_tsv)
  `.execute(db);
}

export interface MemoryStrataIndexDocRow {
  doc_id: string;
  category: string;
  slug: string;
  summary: string;
  fact_type: string;
  body: string;
  headers: string;
}

export interface MemoryStrataIndexDatabase {
  memory_strata_index_v1_docs: MemoryStrataIndexDocRow;
}
