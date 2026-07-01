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
// Table is versioned (v2 ← v1, TASK-186). The v2 table adds a per-agent
// `agent_key` column and a composite PRIMARY KEY (agent_key, doc_id) so the
// single shared table is partitioned per (userId, agentId) — without it, agent
// A's `memory_search` could return agent B's facts (a multi-tenant leak). A
// fresh table is created rather than ALTERing v1 in place; the old pooled v1
// rows are orphaned and the index rebuilds from each agent's own docs on the
// next consolidation pass (no row migration — see the TASK-186 decision log).
export async function runIndexMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS memory_strata_index_v2_docs (
      agent_key TEXT NOT NULL,
      doc_id    TEXT NOT NULL,
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
      ) STORED,
      PRIMARY KEY (agent_key, doc_id)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS memory_strata_index_v2_docs_tsv_gin
      ON memory_strata_index_v2_docs
      USING GIN (search_tsv)
  `.execute(db);
}

export interface MemoryStrataIndexDocRow {
  agent_key: string;
  doc_id: string;
  category: string;
  slug: string;
  summary: string;
  fact_type: string;
  body: string;
  headers: string;
}

export interface MemoryStrataIndexDatabase {
  memory_strata_index_v2_docs: MemoryStrataIndexDocRow;
}
