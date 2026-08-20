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

// WEAK references on purpose. A strong Set would pin every Database for the
// life of the process, so a handle the caller abandoned could never be
// collected — turning a crash-on-exit into fds and WAL files held open for the
// whole run. Weak refs keep the pre-existing behaviour (an unreachable Database
// is collected, and its destructor runs mid-run while the environment is still
// alive, which is harmless) and add only the exit-time sweep.
const openDrivers = new Set<WeakRef<BetterSqliteDb>>();
let exitHookInstalled = false;

// Prune the WeakRef wrapper when its Database is collected, so a long-lived
// host that opens and drops databases doesn't accumulate dead refs.
const driverFinalizer = new FinalizationRegistry<WeakRef<BetterSqliteDb>>(
  (ref) => {
    openDrivers.delete(ref);
  },
);

/**
 * Close every still-open tracked driver. Exported for the regression test — the
 * behaviour worth pinning is "an unclosed database gets closed before the
 * environment goes away". Reproducing the native abort itself depends on the
 * Node patch version (it fires on CI's 24.19 and not on 24.15), so a test that
 * asserted the crash would pass for the wrong reason on half the machines that
 * run it.
 */
export function closeTrackedDatabasesForExit(): void {
  for (const ref of openDrivers) {
    const driver = ref.deref();
    if (driver === undefined) continue;
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
  const ref = new WeakRef(driver);
  openDrivers.add(ref);
  driverFinalizer.register(driver, ref);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `once`, and deliberately not `unref`-ed: this must run on a normal exit,
  // which is exactly the path a vitest worker takes.
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
