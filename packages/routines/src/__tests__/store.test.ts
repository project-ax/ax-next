import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';

// Parse BIGINT as Number, matching sync.test.ts pattern (BIGSERIAL returns strings by default).
pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runRoutinesMigration(db);
}, 120_000);

afterEach(async () => {
  await sql`TRUNCATE routines_v1_definitions, routines_v1_fires`.execute(db);
});

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
});

function baseInput(over: Partial<Parameters<ReturnType<typeof createRoutinesStore>['upsert']>[0]> = {}) {
  return {
    agentId: 'agt_a',
    path: '.ax/routines/r.md',
    authorUserId: 'u1',
    name: 'r',
    description: 'd',
    specHash: 'h1',
    trigger: { kind: 'webhook' as const, path: '/r' },
    activeHours: null,
    silenceToken: null,
    silenceMax: 300,
    conversation: 'per-fire' as const,
    promptBody: 'hi',
    nextRunAt: null,
    ...over,
  };
}

describe('RoutinesStore.findOne', () => {
  it('returns the row for an existing (agentId, path)', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput());
    const row = await store.findOne({ agentId: 'agt_a', path: '.ax/routines/r.md' });
    expect(row).not.toBeNull();
    expect(row!.agentId).toBe('agt_a');
    expect(row!.path).toBe('.ax/routines/r.md');
  });

  it('returns null on miss', async () => {
    const store = createRoutinesStore(db);
    expect(await store.findOne({ agentId: 'agt_a', path: '.ax/routines/missing.md' })).toBeNull();
  });

  it('distinguishes rows by both agentId and path', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput({ agentId: 'agt_a' }));
    await store.upsert(baseInput({ agentId: 'agt_b' }));
    const a = await store.findOne({ agentId: 'agt_a', path: '.ax/routines/r.md' });
    const b = await store.findOne({ agentId: 'agt_b', path: '.ax/routines/r.md' });
    expect(a!.agentId).toBe('agt_a');
    expect(b!.agentId).toBe('agt_b');
  });
});

describe('RoutinesStore.upsert change-detection', () => {
  it('returns { changed: true } on first insert', async () => {
    const store = createRoutinesStore(db);
    const r = await store.upsert(baseInput({ specHash: 'h1' }));
    expect(r.changed).toBe(true);
  });

  it('returns { changed: true } when spec_hash differs from existing row', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput({ specHash: 'h1' }));
    const r = await store.upsert(baseInput({ specHash: 'h2' }));
    expect(r.changed).toBe(true);
  });

  it('returns { changed: false } when spec_hash matches existing row', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput({ specHash: 'h1' }));
    const r = await store.upsert(baseInput({ specHash: 'h1' }));
    expect(r.changed).toBe(false);
  });
});
