import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqliteDb } from 'better-sqlite3';

export const TABLE = 'memory_facts_v1';

/** Sentinel `valid_end` value meaning "still active" — never actually the year 9999. */
export const INFINITY_SENTINEL = '9999-12-31T23:59:59.999Z';

export interface FactRow {
  id: string;
  agent_key: string;
  about: string;
  relation: string;
  value: string;
  slot: string | null;
  provenance: 'extracted' | 'agent' | 'human';
  owner_user_id: string | null;
  conversation_id: string | null;
  valid_start: string;
  valid_end: string;
  transaction_time: string;
  closed_by: string | null;
  /**
   * The `batchKey` of the `memory:facts:record` call that wrote this row, or
   * NULL when the caller passed none. Every row of one batch carries the same
   * value; dedup is `(agent_key, batch_key)`, never `batch_key` alone.
   */
  batch_key: string | null;
  /**
   * 0-based position of this row WITHIN its batch.
   *
   * It exists because `transaction_time` cannot order a batch: `record`
   * computes `now` once per call, so every row of a batch shares one value to
   * the millisecond. Nor can `id` — it is a random UUID. Nor is `rowid` safe:
   * SQLite explicitly reserves the right to renumber it during `VACUUM` on a
   * table (like this one) whose primary key is not an INTEGER. A stored
   * counter is the only tiebreak that survives all three.
   *
   * Set on every row, batched or not, so the column has one meaning.
   */
  batch_seq: number | null;
}

// ---------------------------------------------------------------------------
// Close-on-exit safety net — copied verbatim (pattern and rationale) from
// `@ax/memory-strata-index-sqlite`'s `schema.ts`.
//
// better-sqlite3's `Database` destructor calls `RemoveEnvironmentCleanupHook`.
// If a Database is still OPEN when the Node environment tears down, that hook
// removal runs with a null env and aborts the process (SIGABRT, no exception).
// Under vitest's forks pool that surfaces as `Worker exited unexpectedly`,
// blaming whichever test file the dying worker happened to hold.
//
// `shutdown()` (closing the driver) remains the real contract; this is the
// net under every caller that exits without one.
//
// STRONG references, deliberately: keeping a handle reachable stops GC from
// finalizing it on V8's own schedule, which is what triggers the abort if it
// lands mid-teardown. The only thing that closes a tracked driver is this
// sweep, on `exit`, while the environment is still alive.
// ---------------------------------------------------------------------------

const openDrivers = new Set<BetterSqliteDb>();
let exitHookInstalled = false;

/** Exported for a regression test, mirroring the sibling package's pattern. */
export function closeTrackedDatabasesForExit(): void {
  for (const driver of openDrivers) {
    try {
      if (driver.open) driver.close();
    } catch {
      // The process is on its way out; nothing left to corrupt or report.
    }
  }
  openDrivers.clear();
}

function trackDriver(driver: BetterSqliteDb): void {
  openDrivers.add(driver);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', closeTrackedDatabasesForExit);
}

export interface OpenDatabaseResult {
  driver: BetterSqliteDb;
}

export function openDatabase(databasePath: string): OpenDatabaseResult {
  const driver = new BetterSqlite3(databasePath);
  trackDriver(driver);
  driver.pragma('journal_mode = WAL');

  // Fully static SQL — no user input, no injection risk.
  driver.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      agent_key TEXT NOT NULL,
      about TEXT NOT NULL,
      relation TEXT NOT NULL,
      value TEXT NOT NULL,
      slot TEXT,
      provenance TEXT NOT NULL CHECK(provenance IN ('extracted','agent','human')),
      owner_user_id TEXT,
      conversation_id TEXT,
      valid_start TEXT NOT NULL,
      valid_end TEXT NOT NULL DEFAULT '${INFINITY_SENTINEL}',
      transaction_time TEXT NOT NULL,
      closed_by TEXT,
      batch_key TEXT,
      batch_seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_facts_slot ON ${TABLE}(agent_key, about, slot, valid_end);
  `);

  // `CREATE TABLE IF NOT EXISTS` is a no-op against a db TASK-421 already
  // created, so that db would keep the 13-column shape forever and every
  // `batch_key` read would fail with "no such column". The additive migration
  // below is what actually moves an existing store forward. It has to run
  // BEFORE idx_facts_batch, which indexes the column it adds.
  migrateAddColumns(driver);

  driver.exec(
    `CREATE INDEX IF NOT EXISTS idx_facts_batch ON ${TABLE}(agent_key, batch_key);`,
  );

  return { driver };
}

/**
 * Add any column this version needs that an older db does not have.
 *
 * Idempotent by construction: `PRAGMA table_info` is read first and a column
 * already present is skipped, so a second `openDatabase` on the same file is a
 * no-op rather than a "duplicate column name" throw. (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, which is why the pragma is needed at all.)
 *
 * Every identifier here is a module constant — `TABLE` and the literal column
 * names — so the SQL stays fully static even though it is template-built. No
 * caller value reaches it.
 */
function migrateAddColumns(driver: BetterSqliteDb): void {
  const present = new Set(
    (driver.pragma(`table_info(${TABLE})`) as Array<{ name: string }>).map((c) => c.name),
  );
  // Nullable and with no default, so the ALTER is instant and needs no
  // backfill: an older row genuinely has no batch, and NULL says exactly that.
  // A NULL `batch_key` never matches a dedup lookup, because every lookup
  // binds a non-empty string.
  if (!present.has('batch_key')) {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN batch_key TEXT`);
  }
  if (!present.has('batch_seq')) {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN batch_seq INTEGER`);
  }
}
