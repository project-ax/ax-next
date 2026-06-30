import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqliteDb } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Kysely type witness for the FTS5 virtual table.
// FTS5 rows don't have rowid-based PKs in a typed sense, but having this
// interface gives Kysely's sql`` template tag typed context.
// ---------------------------------------------------------------------------

export interface MemoryStrataIndexRow {
  // Per-agent scope key (TASK-186). Derived from the calling ctx
  // (sha256([userId, agentId])) so every row is owned by exactly one agent;
  // search/delete/clear filter on it. UNINDEXED in FTS5 — it's an exact-match
  // filter column, never full-text-searched.
  agent_key: string;
  doc_id: string;
  category: string;
  slug: string;
  summary: string;
  fact_type: string;
  body: string;
  headers: string;
}

export interface Database {
  memory_strata_index_v2_docs: MemoryStrataIndexRow;
}

// Table is versioned (v2 ← v1, TASK-186). FTS5 has no clean ALTER TABLE ADD
// COLUMN, so adding `agent_key` to an existing `v1` table is impossible in
// place. Bumping the version creates a fresh table with the column; the old
// pooled `v1` rows are simply orphaned (the index rebuilds from the agent's
// own consolidated docs on the next pass — no migration needed, see TASK-186
// decision log).
export const TABLE = 'memory_strata_index_v2_docs';

export interface OpenDatabaseResult {
  /** Kysely instance — used for typed async queries. */
  db: Kysely<Database>;
  /** Raw better-sqlite3 driver — used for synchronous transaction in upsert (I22). */
  rawDriver: BetterSqliteDb;
}

export function openDatabase(databasePath: string): OpenDatabaseResult {
  const driver = new BetterSqlite3(databasePath);
  driver.pragma('journal_mode = WAL');

  // Kysely's schema DSL doesn't speak FTS5 virtual-table syntax — use the
  // better-sqlite3 driver's exec() directly for the one-time migration.
  // The SQL string is fully static (no user input), so there is no injection
  // risk here despite any security hook warning about child_process.exec.
  driver.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE}
    USING fts5(
      agent_key UNINDEXED,
      doc_id UNINDEXED,
      category UNINDEXED,
      slug UNINDEXED,
      summary,
      fact_type UNINDEXED,
      body,
      headers,
      tokenize = 'porter unicode61'
    )
  `);

  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: driver }),
  });

  return { db, rawDriver: driver };
}
