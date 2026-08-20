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

// ---------------------------------------------------------------------------
// Close-on-exit safety net.
//
// better-sqlite3's `Database` destructor calls `RemoveEnvironmentCleanupHook`.
// If a Database is still OPEN when the Node environment tears down, that hook
// removal runs with a null env and aborts the process:
//
//   node[9672]: void node::RemoveEnvironmentCleanupHook(...) at ../src/api/hooks.cc:142
//   Assertion failed: (env) != nullptr
//    3: Database::~Database() [better_sqlite3.node]
//
// SIGABRT — no exception, no failing assertion. Under vitest's forks pool that
// surfaces as `Worker exited unexpectedly` / `Timeout terminating forks worker`,
// blaming whichever test file the dying worker happened to hold. Which file gets
// blamed changes run to run, which is why it read as a vitest flake for weeks
// while it reddened `main`.
//
// `shutdown()` (which destroys the Kysely instance, closing the driver) remains
// the real contract and every long-lived caller should still call it. This is
// the net under every caller that exits without one — a test that bootstraps and
// returns, or a host that dies on an uncaught exception. `exit` handlers run
// while the environment is still alive, so closing here turns the destructor
// into a no-op instead of a crash.
// ---------------------------------------------------------------------------

const openDrivers = new Set<BetterSqliteDb>();
let exitHookInstalled = false;

/**
 * Close every still-open driver. Exported for the regression test — the
 * behaviour worth pinning is "an unclosed database gets closed before the
 * environment goes away", and reproducing the native abort itself depends on
 * the Node patch version, so asserting the abort would prove nothing on a
 * machine whose Node happens not to trip it.
 */
export function closeTrackedDatabasesForExit(): void {
  for (const driver of openDrivers) {
    try {
      if (driver.open) driver.close();
    } catch {
      // The process is on its way out; a close that fails here has nothing
      // left to corrupt and nowhere useful to report.
    }
  }
  openDrivers.clear();
}

function trackDriver(driver: BetterSqliteDb): void {
  openDrivers.add(driver);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `once`, and never `unref`-ed: this must run on a normal exit, which is
  // exactly the path a vitest worker takes.
  process.once('exit', closeTrackedDatabasesForExit);
}

export function openDatabase(databasePath: string): OpenDatabaseResult {
  const driver = new BetterSqlite3(databasePath);
  trackDriver(driver);
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
