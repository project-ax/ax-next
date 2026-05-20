import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';

// Parse BIGINT as Number, matching migrations.test.ts pattern (BIGSERIAL returns strings by default).
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
}, 60_000);

const baseUpsert = {
  agentId: 'agt_a',
  path: '.ax/routines/r.md',
  authorUserId: 'u1',
  name: 'r',
  description: 'd',
  specHash: 'sha-1',
  trigger: { kind: 'interval' as const, every: '60s' },
  activeHours: null,
  silenceToken: null,
  silenceMax: 300,
  conversation: 'per-fire' as const,
  promptBody: '# x',
  nextRunAt: new Date('2026-05-14T12:00:00Z'),
};

describe('routines store', () => {
  it('upsert creates a new row', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    const rows = await db.selectFrom('routines_v1_definitions').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe('agt_a');
    expect(rows[0]!.spec_hash).toBe('sha-1');
  });

  it('upsert with same spec_hash preserves next_run_at', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    const newer = new Date('2026-05-14T13:00:00Z');
    await store.upsert({ ...baseUpsert, nextRunAt: newer });
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T12:00:00.000Z');
  });

  it('upsert with new spec_hash resets next_run_at', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    const newer = new Date('2026-05-14T13:00:00Z');
    await store.upsert({ ...baseUpsert, specHash: 'sha-2', nextRunAt: newer });
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T13:00:00.000Z');
  });

  it('delete removes the row', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    await store.delete({ agentId: 'agt_a', path: '.ax/routines/r.md' });
    const rows = await db.selectFrom('routines_v1_definitions').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('claimDue returns due rows and advances next_run_at by the claim window', async () => {
    const store = createRoutinesStore(db);
    await store.upsert({ ...baseUpsert, nextRunAt: new Date('2026-05-14T11:00:00Z') });
    const claimedAt = new Date('2026-05-14T12:00:00Z');
    const claimed = await store.claimDue({ now: claimedAt, limit: 50, claimWindowMinutes: 5 });
    expect(claimed).toHaveLength(1);
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T11:05:00.000Z');
  });

  it('claimDue skips webhook rows', async () => {
    const store = createRoutinesStore(db);
    await db.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_b', path: '.ax/routines/w.md', author_user_id: 'u1',
      name: 'w', description: 'd', spec_hash: 'h',
      trigger_kind: 'webhook', trigger_spec: { kind: 'webhook', path: '/x' },
      active_hours: null, silence_token: null, silence_max: 300,
      conversation: 'per-fire', prompt_body: '# x',
      next_run_at: new Date('2026-05-14T11:00:00Z'),
    }).execute();
    const claimed = await store.claimDue({ now: new Date('2026-05-14T12:00:00Z'), limit: 50, claimWindowMinutes: 5 });
    expect(claimed).toHaveLength(0);
  });

  it('advance updates next_run_at + last_run_at + last_status', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    const advancedAt = new Date('2026-05-14T12:01:00Z');
    const nextAt = new Date('2026-05-14T12:30:00Z');
    await store.advance({
      agentId: 'agt_a', path: '.ax/routines/r.md',
      nextRunAt: nextAt, lastRunAt: advancedAt,
      lastStatus: 'ok', lastError: null,
    });
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.next_run_at?.toISOString()).toBe(nextAt.toISOString());
    expect(row.last_run_at?.toISOString()).toBe(advancedAt.toISOString());
    expect(row.last_status).toBe('ok');
  });

  it('recordFire appends a fires row', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    const id = await store.recordFire({
      agentId: 'agt_a', path: '.ax/routines/r.md',
      triggerSource: 'tick', conversationId: 'cnv_x', status: 'ok', error: null,
    });
    expect(id).toBeGreaterThan(0);
    const fires = await db.selectFrom('routines_v1_fires').selectAll().execute();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.status).toBe('ok');
  });

  it('list returns all rows (optionally filtered by agent)', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    await store.upsert({ ...baseUpsert, agentId: 'agt_b', path: '.ax/routines/r2.md' });
    expect(await store.list({})).toHaveLength(2);
    expect(await store.list({ agentId: 'agt_a' })).toHaveLength(1);
  });
});
