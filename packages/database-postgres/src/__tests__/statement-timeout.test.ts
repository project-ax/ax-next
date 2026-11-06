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
// TASK-1056: Postgres cancels a pooled statement that runs too long.
//
// Without a statement timeout, a stuck statement (or a lock wait behind a stuck
// holder) holds its pool connection forever. These tests make a statement
// genuinely run long, then check the database cancels it with 57014 and the
// connection stays usable.
// ---------------------------------------------------------------------------

const unblock: Array<() => void | Promise<void>> = [];
const harnesses: TestHarness[] = [];

afterEach(async () => {
  // Unblock first: a pool can't end while one of its connections is held.
  for (const f of unblock.splice(0)) await f();
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

/**
 * Holds a transaction-scoped advisory lock on a raw connection (outside the
 * pool under test) until the returned `release` runs.
 */
async function holdAdvisoryLock(
  connectionString: string,
  key: number,
): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock($1)', [key]);
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  };
  unblock.push(release);
  return release;
}

describe('statement timeout, config', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '300'])(
    'refuses statementTimeoutMs %s at boot',
    async (value) => {
      await expect(
        createTestHarness({
          plugins: [
            createDatabasePostgresPlugin({
              connectionString: 'postgres://ax@127.0.0.1:1/ax',
              statementTimeoutMs: value as number,
            }),
          ],
        }),
      ).rejects.toMatchObject({
        name: 'PluginError',
        code: 'invalid-config',
        plugin: '@ax/database-postgres',
      });
    },
  );

  // These pass on the unfixed plugin too; they guard the ends of the range.
  it.each([1, 2_147_483_647])('accepts statementTimeoutMs %s', async (value) => {
    await instance({ connectionString: 'postgres://ax@127.0.0.1:1/ax', statementTimeoutMs: value });
  });
});

describe('statement timeout, against a real database', () => {
  let container: StartedPostgreSqlContainer;
  let connectionString: string;

  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = container.getConnectionUri();
  });

  afterAll(async () => {
    if (container) await stopPostgresContainer(container);
  });

  it('a statement that runs past the timeout fails with 57014, and the same connection serves the next query', async () => {
    const db = await instance({
      connectionString,
      poolMax: 1,
      checkoutTimeoutMs: 1_000,
      statementTimeoutMs: 300,
    });
    const pid = async (): Promise<number> =>
      (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)).rows[0]!.pid;
    const before = await pid();
    const started = performance.now();
    const err = await errorOf(sql`SELECT pg_sleep(5)`.execute(db));
    const waited = performance.now() - started;
    expect(err).toMatchObject({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    });
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(waited).toBeLessThan(3_000);
    expect(await pid()).toBe(before); // returned to the pool, usable, not replaced
  }, 15_000);

  it('a wait for an advisory lock is bounded too, and the lock is taken once its holder lets go', async () => {
    const db = await instance({
      connectionString,
      poolMax: 1,
      checkoutTimeoutMs: 1_000,
      statementTimeoutMs: 300,
    });
    const release = await holdAdvisoryLock(connectionString, 1056);
    const lock = (): Promise<void> =>
      db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(1056)`.execute(trx);
      });
    const started = performance.now();
    expect(await errorOf(lock())).toMatchObject({ code: '57014' });
    expect(performance.now() - started).toBeLessThan(3_000);
    await release();
    await expect(lock()).resolves.toBeUndefined();
  }, 15_000);

  it('SET LOCAL statement_timeout = 0 lifts the bound for one transaction only (the migration recipe)', async () => {
    const db = await instance({ connectionString, statementTimeoutMs: 300 });
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = 0`.execute(trx);
      await sql`SELECT pg_sleep(0.6)`.execute(trx);
    });
    expect(await errorOf(sql`SELECT pg_sleep(0.6)`.execute(db))).toMatchObject({ code: '57014' });
  }, 15_000);

  it('defaults to 30 seconds', async () => {
    const db = await instance({ connectionString });
    const { rows } = await sql<{
      setting: string;
    }>`SELECT setting FROM pg_settings WHERE name = 'statement_timeout'`.execute(db);
    expect(rows[0]?.setting).toBe('30000');
  });
});
