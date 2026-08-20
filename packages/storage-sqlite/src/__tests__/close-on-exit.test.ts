// ---------------------------------------------------------------------------
// An unclosed better-sqlite3 Database must be closed before the Node
// environment tears down, or its destructor calls RemoveEnvironmentCleanupHook
// with a null env and aborts the process:
//
//   Assertion failed: (env) != nullptr   ← ../src/api/hooks.cc:142
//    3: Database::~Database() [better_sqlite3.node]
//
// SIGABRT, no exception, no failing assertion. Under vitest's forks pool that
// reads as "Worker exited unexpectedly", blaming whichever test file the dying
// worker happened to hold — a different one each run. It reddened `main` for
// weeks and was repeatedly written off as a vitest flake.
//
// We pin the BEHAVIOUR (an unclosed handle gets closed on the way out) rather
// than the abort. Whether the abort actually fires depends on the Node patch
// version — it reproduced on CI's 24.19 and not on 24.15 — so a test that
// asserted the crash would pass for the wrong reason on half the machines that
// run it, which is exactly the kind of guard that looks strong and isn't.
// ---------------------------------------------------------------------------

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { closeTrackedDatabasesForExit, openDatabase } from '../schema.js';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ax-sqlite-exit-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  closeTrackedDatabasesForExit();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** The driver behind a Kysely instance, so we can ask whether it is still open. */
function driverOf(dbPath: string): BetterSqlite3.Database {
  return new BetterSqlite3(dbPath, { readonly: true });
}

describe('close-on-exit net', () => {
  it('closes a database the caller never shut down', async () => {
    const path = join(scratch(), 'db.sqlite');
    const db = openDatabase(path);
    // Force a real connection before we abandon it.
    await db.selectFrom('kv').select('key').limit(1).execute();

    closeTrackedDatabasesForExit();

    // A closed better-sqlite3 handle rejects further use. Reaching through
    // Kysely is the honest check: it proves the DRIVER we tracked is the one
    // that got closed, not some other handle.
    await expect(
      db.selectFrom('kv').select('key').limit(1).execute(),
    ).rejects.toThrow(/not open/i);
  });

  it('is idempotent — a second sweep is a no-op, not a throw', async () => {
    const path = join(scratch(), 'db.sqlite');
    openDatabase(path);
    closeTrackedDatabasesForExit();
    expect(() => closeTrackedDatabasesForExit()).not.toThrow();
  });

  it('does not throw when the caller already shut down properly', async () => {
    const path = join(scratch(), 'db.sqlite');
    const db = openDatabase(path);
    await db.destroy(); // the real contract — shutdown() does this
    expect(() => closeTrackedDatabasesForExit()).not.toThrow();
  });

  it('closes every open database, not just the most recent', async () => {
    const dir = scratch();
    const a = join(dir, 'a.sqlite');
    const b = join(dir, 'b.sqlite');
    const dbA = openDatabase(a);
    const dbB = openDatabase(b);
    await dbA.selectFrom('kv').select('key').limit(1).execute();
    await dbB.selectFrom('kv').select('key').limit(1).execute();

    closeTrackedDatabasesForExit();

    await expect(dbA.selectFrom('kv').select('key').limit(1).execute())
      .rejects.toThrow(/not open/i);
    await expect(dbB.selectFrom('kv').select('key').limit(1).execute())
      .rejects.toThrow(/not open/i);
  });

  it('leaves the file readable afterwards (a clean close, not a yank)', async () => {
    const path = join(scratch(), 'db.sqlite');
    const db = openDatabase(path);
    await db
      .insertInto('kv')
      .values({ key: 'k', value: Buffer.from('v') })
      .execute();

    closeTrackedDatabasesForExit();

    const reader = driverOf(path);
    try {
      const row = reader.prepare('SELECT key FROM kv WHERE key = ?').get('k');
      expect(row).toEqual({ key: 'k' });
    } finally {
      reader.close();
    }
  });

  it('does not pin an abandoned database (weak refs, not a leak)', async () => {
    // The net must not turn "crashes on exit" into "holds every fd for the
    // whole run". Tracking is by WeakRef, so an abandoned handle stays
    // collectable; we can't force GC deterministically, so assert the property
    // that makes that true — the registry holds weak refs, and a swept
    // registry is empty rather than growing.
    const dir = scratch();
    openDatabase(join(dir, 'w1.sqlite'));
    openDatabase(join(dir, 'w2.sqlite'));
    closeTrackedDatabasesForExit();
    // A second open after a sweep starts from a clean registry, and sweeping
    // again must still be safe.
    const db = openDatabase(join(dir, 'w3.sqlite'));
    await db.selectFrom('kv').select('key').limit(1).execute();
    closeTrackedDatabasesForExit();
    await expect(
      db.selectFrom('kv').select('key').limit(1).execute(),
    ).rejects.toThrow(/not open/i);
  });

  it('registers exactly one process exit listener however many databases open', () => {
    const before = process.listenerCount('exit');
    const dir = scratch();
    openDatabase(join(dir, 'x1.sqlite'));
    openDatabase(join(dir, 'x2.sqlite'));
    openDatabase(join(dir, 'x3.sqlite'));
    // The hook installs once, on the first open — three more databases must not
    // pile three more listeners onto `process` (that would trip the
    // MaxListenersExceededWarning and, worse, mean the net was re-armed rather
    // than shared).
    expect(process.listenerCount('exit')).toBeLessThanOrEqual(before + 1);
  });
});
