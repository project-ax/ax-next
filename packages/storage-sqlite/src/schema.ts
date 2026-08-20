import { Kysely, SqliteDialect, type Generated } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqliteDb } from 'better-sqlite3';

export interface KvRow {
  key: string;
  value: Buffer;
  updated_at: Generated<string>;
}

export interface Database {
  kv: KvRow;
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

export function openDatabase(databasePath: string): Kysely<Database> {
  const driver = new BetterSqlite3(databasePath);
  trackDriver(driver);
  driver.pragma('journal_mode = WAL');
  driver.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: driver }),
  });
}
