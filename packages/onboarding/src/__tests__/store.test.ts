import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runOnboardingMigration, type OnboardingDatabase } from '../migrations.js';
import { createOnboardingStore, type OnboardingStore } from '../store.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<OnboardingDatabase>[] = [];

function makeKysely(): Kysely<OnboardingDatabase> {
  const k = new Kysely<OnboardingDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 2 }),
    }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('bootstrap_state').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('bootstrap_state store — Invariant I6', () => {
  // Helper: each test gets a fresh kysely + fresh migrated schema.
  async function setup(): Promise<OnboardingStore> {
    const db = makeKysely();
    await runOnboardingMigration(db);
    return createOnboardingStore(db);
  }

  it('starts as null (no row)', async () => {
    const store = await setup();
    expect(await store.read()).toBeNull();
  });

  it('initializeWithHash inserts pending row', async () => {
    const store = await setup();
    await store.initializeWithHash('hash-A');
    const row = await store.read();
    expect(row?.status).toBe('pending');
    expect(row?.token_hash).toBe('hash-A');
  });

  it('claim returns ok on first call, not-pending on second', async () => {
    const store = await setup();
    await store.initializeWithHash('hash-A');
    const a = await store.claim();
    expect(a.ok).toBe(true);
    const b = await store.claim();
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.reason).toBe('already-claimed-or-completed');
    }
  });

  it('complete sets completed_at AND blocks future claims', async () => {
    const store = await setup();
    await store.initializeWithHash('hash-A');
    await store.claim();
    await store.complete();
    const row = await store.read();
    expect(row?.status).toBe('completed');
    expect(row?.completed_at).toBeInstanceOf(Date);
    const c = await store.claim();
    expect(c.ok).toBe(false);
  });

  it('concurrent claims: exactly one wins (atomic CAS)', async () => {
    const store = await setup();
    await store.initializeWithHash('hash-A');
    const results = await Promise.all([
      store.claim(),
      store.claim(),
      store.claim(),
      store.claim(),
      store.claim(),
    ]);
    expect(results.filter((r) => r.ok).length).toBe(1);
  });

  it('initializeWithHash is idempotent — re-init with same hash leaves status=pending', async () => {
    const store = await setup();
    await store.initializeWithHash('hash-A');
    await store.initializeWithHash('hash-A');
    const row = await store.read();
    expect(row?.status).toBe('pending');
  });

  it('complete on uninitialized store is a no-op (I6 backward-transition guard)', async () => {
    const store = await setup();
    await store.complete();
    expect(await store.read()).toBeNull();
  });

  it('complete is idempotent — calling twice does not re-stamp completed_at (I6)', async () => {
    const store = await setup();
    await store.initializeWithHash('hash-A');
    await store.claim();
    await store.complete();
    const first = await store.read();
    const firstStamp = first!.completed_at;
    // Wait long enough that NOW() would be observably different.
    await new Promise((r) => setTimeout(r, 50));
    await store.complete();
    const second = await store.read();
    expect(second!.completed_at?.getTime()).toBe(firstStamp?.getTime());
  });
});
