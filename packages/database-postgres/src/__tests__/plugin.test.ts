import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness } from '@ax/test-harness';
import { PluginError } from '@ax/core';
import { createDatabasePostgresPlugin } from '../plugin.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;

const opened: Kysely<unknown>[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  // Drain pools BEFORE the container stops, otherwise the abrupt server
  // shutdown bubbles up as an unhandled `terminating connection due to
  // administrator command` from pg-protocol. There's no plugin shutdown
  // lifecycle yet (TODO: kernel-shutdown), so tests own the cleanup.
  while (opened.length > 0) {
    const k = opened.pop()!;
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('@ax/database-postgres', () => {
  it('database:get-instance returns a working Kysely instance', async () => {
    const h = await createTestHarness({
      plugins: [createDatabasePostgresPlugin({ connectionString })],
    });
    const ctx = h.ctx();
    const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctx,
      {},
    );
    opened.push(db);
    const result = await sql<{ one: number }>`SELECT 1::int as one`.execute(db);
    expect(result.rows[0]?.one).toBe(1);
  });

  it('returns the SAME Kysely instance on every call (singleton)', async () => {
    const h = await createTestHarness({
      plugins: [createDatabasePostgresPlugin({ connectionString })],
    });
    const ctx = h.ctx();
    const a = await h.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctx,
      {},
    );
    const b = await h.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctx,
      {},
    );
    opened.push(a.db);
    expect(a.db).toBe(b.db);
  });

  it('boot fails with a structured PluginError on bad connection string', async () => {
    await expect(
      createTestHarness({
        plugins: [createDatabasePostgresPlugin({ connectionString: '' })],
      }),
    ).rejects.toMatchObject({
      name: 'PluginError',
      plugin: '@ax/database-postgres',
    });

    await expect(
      createTestHarness({
        plugins: [
          createDatabasePostgresPlugin({ connectionString: 'mysql://wrong-scheme/x' }),
        ],
      }),
    ).rejects.toBeInstanceOf(PluginError);
  });
});
