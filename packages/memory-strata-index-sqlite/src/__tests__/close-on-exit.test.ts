// Twin of @ax/storage-sqlite's close-on-exit test — same native failure mode,
// second package that opens a better-sqlite3 Database. An unclosed handle whose
// destructor runs after the Node environment is gone aborts the process with
// `Assertion failed: (env) != nullptr`, which vitest's forks pool reports as
// "Worker exited unexpectedly" against an arbitrary test file. On `main` this
// signature blamed this package's bench smoke test on some runs and @ax/cli's
// on others. See the comment block in ../schema.ts for the full story.

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeTrackedDatabasesForExit, openDatabase, TABLE } from '../schema.js';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ax-msi-exit-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  closeTrackedDatabasesForExit();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('close-on-exit net', () => {
  it('closes a database the caller never shut down', () => {
    const { rawDriver } = openDatabase(join(scratch(), 'index.sqlite'));
    expect(rawDriver.open).toBe(true);

    closeTrackedDatabasesForExit();

    // The raw driver is the exact handle whose destructor would otherwise abort
    // the process, so assert on it directly rather than through Kysely.
    expect(rawDriver.open).toBe(false);
  });

  it('closes every open database, not just the most recent', () => {
    const dir = scratch();
    const first = openDatabase(join(dir, 'a.sqlite'));
    const second = openDatabase(join(dir, 'b.sqlite'));

    closeTrackedDatabasesForExit();

    expect(first.rawDriver.open).toBe(false);
    expect(second.rawDriver.open).toBe(false);
  });

  it('does not throw when the caller already shut down properly', async () => {
    const { db, rawDriver } = openDatabase(join(scratch(), 'index.sqlite'));
    await db.selectFrom(TABLE).select('doc_id').limit(1).execute();
    await db.destroy(); // the real contract — shutdown() does this
    expect(rawDriver.open).toBe(false);
    expect(() => closeTrackedDatabasesForExit()).not.toThrow();
  });

  // Worth pinning because it is the case the net exists for even when callers
  // behave: Kysely closes only a driver it actually initialised, and it
  // initialises lazily on the first query. A plugin that opens its database,
  // runs nothing, and then shuts down cleanly still leaves the handle OPEN —
  // and that handle is what aborts the process on the way out.
  it('catches a shutdown() that never ran a query (Kysely init is lazy)', async () => {
    const { db, rawDriver } = openDatabase(join(scratch(), 'index.sqlite'));
    await db.destroy();
    expect(rawDriver.open).toBe(true); // destroy() had no driver to close

    closeTrackedDatabasesForExit();

    expect(rawDriver.open).toBe(false);
  });

  it('is idempotent — a second sweep is a no-op, not a throw', () => {
    openDatabase(join(scratch(), 'index.sqlite'));
    closeTrackedDatabasesForExit();
    expect(() => closeTrackedDatabasesForExit()).not.toThrow();
  });

  it('registers exactly one process exit listener however many databases open', () => {
    const before = process.listenerCount('exit');
    const dir = scratch();
    openDatabase(join(dir, 'x1.sqlite'));
    openDatabase(join(dir, 'x2.sqlite'));
    openDatabase(join(dir, 'x3.sqlite'));
    expect(process.listenerCount('exit')).toBeLessThanOrEqual(before + 1);
  });
});
