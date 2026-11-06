import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin, type DatabasePostgresConfig } from '../plugin.js';

// ---------------------------------------------------------------------------
// TASK-1061: Postgres ends a pooled session left idle inside a transaction.
//
// The statement timeout (TASK-1056) bounds a statement and a lock wait, but
// not the holder. A transaction that took its locks and then awaited something
// in JavaScript that never settled (routines' webhook admissions await
// blob:put, and the S3 client has no request timeout) kept those locks
// forever. These tests leave a real transaction idle past the bound and check
// the database ends it and frees its lock, while a connection idle OUTSIDE a
// transaction is left alone.
// ---------------------------------------------------------------------------

const harnesses: TestHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function instance(config: DatabasePostgresConfig): Promise<Kysely<unknown>> {
  const h = await createTestHarness({ plugins: [createDatabasePostgresPlugin(config)] });
  harnesses.push(h);
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  return db;
}

function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

interface LoggedRecord {
  level: string;
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function recordingLogger() {
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

describe('idle-in-transaction timeout, config', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '300'])(
    'refuses idleInTransactionTimeoutMs %s at boot',
    async (value) => {
      await expect(
        createTestHarness({
          plugins: [
            createDatabasePostgresPlugin({
              connectionString: 'postgres://ax@127.0.0.1:1/ax',
              idleInTransactionTimeoutMs: value as number,
            }),
          ],
        }),
      ).rejects.toMatchObject({
        name: 'PluginError',
        code: 'invalid-config',
        plugin: '@ax/database-postgres',
        message: expect.stringContaining('idleInTransactionTimeoutMs'),
      });
    },
  );

  // These pass before the change too; they guard the ends of the range.
  it.each([1, 2_147_483_647])('accepts idleInTransactionTimeoutMs %s', async (value) => {
    await instance({
      connectionString: 'postgres://ax@127.0.0.1:1/ax',
      idleInTransactionTimeoutMs: value,
    });
  });

  // pg lays the connection string's query parameters over the explicit config
  // (measured with pg 8.20's startup packet): the first three rows switch the
  // bound off (pg reads a bare key as unset, and decodes each key on its own
  // even next to a malformed escape), and the last replaces it. The guard is
  // the statement timeout's; statement-timeout.test.ts's rows pin the
  // normalization both keys share.
  it.each([
    'postgres://ax@127.0.0.1:1/ax?idle_in_transaction_session_timeout=0',
    'postgres://ax@127.0.0.1:1/ax?idle_in_transaction_session_timeout',
    'postgres://ax@127.0.0.1:1/ax?x%zz=1&%69dle_in_transaction_session_timeout=0',
    'postgres://ax@127.0.0.1:1/ax?sslmode=no-verify&idle_in_transaction_session_timeout=60000',
  ])(
    'refuses a connection string that sets the idle-in-transaction timeout itself: %s',
    async (connectionString) => {
      await expect(
        createTestHarness({ plugins: [createDatabasePostgresPlugin({ connectionString })] }),
      ).rejects.toMatchObject({
        name: 'PluginError',
        code: 'invalid-config',
        plugin: '@ax/database-postgres',
        message: expect.stringContaining('idleInTransactionTimeoutMs'),
      });
    },
  );
});

describe('idle-in-transaction timeout, against a real database', () => {
  let container: StartedPostgreSqlContainer;
  let connectionString: string;

  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = container.getConnectionUri();
  });

  afterAll(async () => {
    if (container) await stopPostgresContainer(container);
  });

  /**
   * Another session tries for the session-level advisory lock `key` without
   * waiting, and lets go at once if it got it.
   */
  async function tryLock(key: number): Promise<boolean> {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS ok',
        [key],
      );
      const ok = rows[0]?.ok === true;
      if (ok) await client.query('SELECT pg_advisory_unlock($1)', [key]);
      return ok;
    } finally {
      await client.end().catch(() => {});
    }
  }

  it('a transaction left idle past the bound is ended by the server, which frees its locks', async () => {
    const { records, logger } = recordingLogger();
    const db = await instance({ connectionString, idleInTransactionTimeoutMs: 500, logger });
    // Stands in for the host. Production has no uncaughtException handler, so
    // an 'error' nobody listens for ends the process. vitest stays quiet while
    // another listener exists, so this list is the only witness.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve; // stands in for an awaited upload that never settles
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const outcome = errorOf(
      db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(4242)`.execute(trx);
        locked();
        await gate;
        await sql`SELECT 1`.execute(trx);
      }),
    );
    try {
      // Poll only once the transaction holds the lock: an earlier try could
      // take the still-free lock itself and pass before anything idled.
      await Promise.race([lockTaken, outcome]);
      await expect.poll(() => tryLock(4242), { timeout: 10_000 }).toBe(true);
      // The client has seen its session end before its next statement goes out.
      await expect
        .poll(() => records.length + unhandled.length, { timeout: 10_000 })
        .toBeGreaterThan(0);
      release();
      expect(await outcome).toMatchObject({
        message: 'Client has encountered a connection error and is not queryable',
      });
      // pg-pool dropped the dead connection at release, and the pool still answers.
      expect((await sql<{ one: number }>`SELECT 1 AS one`.execute(db)).rows).toEqual([{ one: 1 }]);
    } finally {
      release(); // a red run must not leave the transaction holding the pool open
      process.off('uncaughtException', onUnhandled);
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
      ['error', 'database_postgres_client_error', { code: '25P03', name: 'error' }],
    ]);
  });

  // Passes before the change too. It pins that the bound is the idle-IN-
  // transaction one: `idle_session_timeout` would end this session, and the
  // routines leader and blob-gc hold their session-level locks on pinned
  // connections just like it.
  it('a session-level advisory lock on a connection idle outside a transaction survives the bound', async () => {
    const db = await instance({ connectionString, idleInTransactionTimeoutMs: 500 });
    await db.connection().execute(async (conn) => {
      const took = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(77) AS ok`.execute(conn);
      expect(took.rows).toEqual([{ ok: true }]);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect((await sql<{ one: number }>`SELECT 1 AS one`.execute(conn)).rows).toEqual([{ one: 1 }]);
      expect(await tryLock(77)).toBe(false);
      await sql`SELECT pg_advisory_unlock(77)`.execute(conn);
    });
  });

  it('defaults to 60 seconds', async () => {
    const db = await instance({ connectionString });
    const { rows } = await sql<{
      setting: string;
    }>`SELECT setting FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'`.execute(db);
    expect(rows[0]?.setting).toBe('60000');
  });
});
