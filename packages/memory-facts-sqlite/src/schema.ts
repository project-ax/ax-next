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
      closed_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_facts_slot ON ${TABLE}(agent_key, about, slot, valid_end);
  `);

  return { driver };
}
