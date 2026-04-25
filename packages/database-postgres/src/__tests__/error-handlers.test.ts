import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { createTestHarness } from '@ax/test-harness';
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
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
    const poolErrors = records.filter(
      (r) => r.level === 'error' && r.msg === 'database_postgres_pool_error',
    );
    expect(poolErrors.length).toBeGreaterThanOrEqual(1);
  }, 15000);
});
