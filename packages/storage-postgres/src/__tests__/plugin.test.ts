import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '../plugin.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<unknown>[] = [];

async function makeHarness() {
  // Loads BOTH plugins — the storage-postgres test fixture proves the
  // database:get-instance handshake at the same time as it tests the
  // storage hooks. (Per I2 — storage-postgres MUST NOT direct-import
  // @ax/database-postgres at runtime; it reaches the kysely instance
  // through the bus.)
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createStoragePostgresPlugin(),
    ],
  });
  // Capture the singleton kysely so afterEach can drain its pool before
  // the next test or container shutdown.
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  opened.push(db);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    // Drop the table so each test starts with a fresh KV namespace.
    try {
      await k
        .schema.dropTable('storage_postgres_v1_kv')
        .ifExists()
        .execute();
    } catch {
      /* drained pool — ignore */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('@ax/storage-postgres', () => {
  it('round-trips bytes via storage:set then storage:get', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    const value = new TextEncoder().encode('hello postgres');
    await h.bus.call('storage:set', ctx, { key: 'k1', value });
    const got = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: 'k1' },
    );
    expect(got.value).toBeDefined();
    expect(new TextDecoder().decode(got.value!)).toBe('hello postgres');
  });

  it('storage:get on a missing key returns { value: undefined }', async () => {
    const h = await makeHarness();
    const got = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      h.ctx(),
      { key: 'missing' },
    );
    expect(got.value).toBeUndefined();
  });

  it('storage:set upserts: writing the same key twice replaces the value', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    await h.bus.call('storage:set', ctx, {
      key: 'k',
      value: new Uint8Array([1, 2, 3]),
    });
    await h.bus.call('storage:set', ctx, {
      key: 'k',
      value: new Uint8Array([9, 9]),
    });
    const got = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: 'k' },
    );
    expect(Array.from(got.value!)).toEqual([9, 9]);
  });
});
