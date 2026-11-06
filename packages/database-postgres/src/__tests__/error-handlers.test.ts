import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Regression test for Fix 3 (production hardening):
//
// pg.Pool emits 'error' asynchronously when an idle pool connection's
// socket dies (postgres restart in k8s, network blip). Without an 'error'
// listener attached, Node treats it as unhandled and crashes the process.
// We trigger a real failure by terminating all backend connections from a
// parallel admin connection, then wait for the pool's idle health-check to
// surface the error.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;

const opened: Kysely<unknown>[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

interface LoggedRecord {
  level: string;
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function makeRecordingLogger() {
  const records: LoggedRecord[] = [];
  const make = (level: string) => (msg: string, bindings?: Record<string, unknown>) => {
    records.push({ level, msg, bindings });
  };
  const logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: () => logger,
  };
  return { records, logger };
}

describe('@ax/database-postgres background error handler', () => {
  it('survives a forced backend termination on the pool (logs, no crash)', async () => {
    const { records, logger } = makeRecordingLogger();
    const h = await createTestHarness({
      plugins: [createDatabasePostgresPlugin({ connectionString, logger })],
    });
    const ctx = h.ctx();
    const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctx,
      {},
    );
    opened.push(db);

    // Warm one connection in the pool so the kill below has something to
    // sever (otherwise the pool is empty and 'error' never fires).
    await sql<{ one: number }>`SELECT 1::int as one`.execute(db);

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);

    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
      `);
    } finally {
      await admin.end().catch(() => {});
    }

    // Give the pool time to surface the idle-connection error.
    await new Promise((r) => setTimeout(r, 500));

    process.off('uncaughtException', onUnhandled);
    process.off('unhandledRejection', onUnhandled);

    expect(unhandled).toEqual([]);
    // TASK-1048: codes only, and only the pool's line. This client was checked
    // out once (the warm-up query) before it went idle, so a checked-out
    // listener still attached after release would add a second line here.
    expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
      ['error', 'database_postgres_pool_error', { code: '57P01', name: 'error' }],
    ]);
  }, 15000);

  it("survives Postgres ending a checked-out client's session: one code-only line, no crash (TASK-1048)", async () => {
    const { records, logger } = makeRecordingLogger();
    const h = await createTestHarness({ plugins: [createDatabasePostgresPlugin({ connectionString, logger })] });
    const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>('database:get-instance', h.ctx(), {});
    opened.push(db);
    // Stands in for the host. Production has no uncaughtException handler, so
    // an 'error' nobody listens for ends the process. vitest stays quiet while
    // another listener exists, so this list is the only witness.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => { unhandled.push(err); };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);
    let probe: unknown;
    try {
      await db.connection().execute(async (conn) => {
        const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(conn);
        const admin = new pg.Client({ connectionString });
        await admin.connect();
        try { await admin.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]); }
        finally { await admin.end().catch(() => {}); }
        // The server's 57P01, then the socket closing: both land while the client is checked out.
        await expect.poll(() => records.length + unhandled.length, { timeout: 10_000 }).toBeGreaterThan(0);
        await new Promise((r) => setTimeout(r, 200));
        probe = await sql`SELECT 1`.execute(conn).then(() => 'answered', (err: unknown) => err);
      });
      // pg-pool dropped the dead client at release, and the pool still answers.
      expect((await sql<{ one: number }>`SELECT 1::int AS one`.execute(db)).rows).toEqual([{ one: 1 }]);
    } finally {
      process.off('uncaughtException', onUnhandled);
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(probe).toBeInstanceOf(Error); // the caller still sees the failure
    expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
      ['error', 'database_postgres_client_error', { code: '57P01', name: 'error' }],
    ]);
  }, 30_000);
});
