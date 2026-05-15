import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';

// pg returns BIGINT (OID 20) as string by default; parse as number for test assertions.
pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let connectionString: string;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
}, 120_000);

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
});

afterEach(async () => {
  await sql`DROP TABLE IF EXISTS routines_v1_fires`.execute(db);
  await sql`DROP TABLE IF EXISTS routines_v1_definitions`.execute(db);
});

describe('runRoutinesMigration', () => {
  it('creates routines_v1_definitions with primary key (agent_id, path)', async () => {
    await runRoutinesMigration(db);
    await db.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md', author_user_id: 'u1',
      name: 'r', description: 'd', spec_hash: 'h',
      trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
      active_hours: null, silence_token: null, silence_max: 300,
      conversation: 'per-fire', prompt_body: '# x',
      next_run_at: new Date(),
    }).execute();
    await expect(
      db.insertInto('routines_v1_definitions').values({
        agent_id: 'agt_a', path: '.ax/routines/r.md', author_user_id: 'u1',
        name: 'r2', description: 'd', spec_hash: 'h',
        trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
        active_hours: null, silence_token: null, silence_max: 300,
        conversation: 'per-fire', prompt_body: '# x',
        next_run_at: new Date(),
      }).execute(),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it('creates routines_v1_fires with append-only id', async () => {
    await runRoutinesMigration(db);
    const row = await db.insertInto('routines_v1_fires').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md',
      trigger_source: 'tick', status: 'ok',
    }).returningAll().executeTakeFirstOrThrow();
    expect(row.id).toBeGreaterThan(0);
  });

  it('routines_v1_due index excludes null next_run_at', async () => {
    await runRoutinesMigration(db);
    const idxes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'routines_v1_definitions'
    `.execute(db);
    const names = idxes.rows.map((r) => r.indexname);
    expect(names).toContain('routines_v1_due');
  });

  it('is idempotent', async () => {
    await runRoutinesMigration(db);
    await runRoutinesMigration(db);
  });
});
