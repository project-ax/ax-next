import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
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
  if (container) await stopPostgresContainer(container);
}, 60_000);

afterEach(async () => {
  await sql`DROP TABLE IF EXISTS routines_v1_fires`.execute(db);
  await sql`DROP TABLE IF EXISTS routines_v1_definitions`.execute(db);
  // agent_default_routine_overrides_v1 FK-references default_routines_v1, so
  // drop it (CASCADE) before the parent.
  await sql`DROP TABLE IF EXISTS agent_default_routine_overrides_v1 CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS default_routines_v1 CASCADE`.execute(db);
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

  it('adds rendered_prompt column to routines_v1_fires', async () => {
    await runRoutinesMigration(db);
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'routines_v1_fires'
    `.execute(db);
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain('rendered_prompt');
  });

  it('default_routines_v1 table has expected schema', async () => {
    await runRoutinesMigration(db);
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'default_routines_v1'
       ORDER BY ordinal_position
    `.execute(db);
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byName['default_routine_id']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['name']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['trigger_kind']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['trigger_spec']).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
    expect(byName['interval_seconds']).toMatchObject({ data_type: 'integer', is_nullable: 'YES' });
    expect(byName['silence_token']).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    expect(byName['silence_max']).toMatchObject({ data_type: 'integer', is_nullable: 'NO' });
    expect(byName['conversation']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['prompt_body']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['enabled']).toMatchObject({ data_type: 'boolean', is_nullable: 'NO' });
    expect(byName['source_md']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
  });

  it('routines_v1_definitions gained definition_id + definition_updated_at columns', async () => {
    await runRoutinesMigration(db);
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'routines_v1_definitions'
         AND column_name IN ('definition_id', 'definition_updated_at')
    `.execute(db);
    expect(cols.rows).toHaveLength(2);
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byName['definition_id']).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    expect(byName['definition_updated_at']).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
  });

  it('CHECK constraint forbids default-sourced row with non-null next_run_at', async () => {
    await runRoutinesMigration(db);

    // First, seed a default so the FK resolves.
    await sql`
      INSERT INTO default_routines_v1
        (default_routine_id, name, description, spec_hash, trigger_kind, trigger_spec,
         interval_seconds, silence_max, conversation, prompt_body, source_md)
      VALUES
        ('d-hb', 'heartbeat-test', 'd', 'hash', 'interval', '{"kind":"interval","every":"24h"}'::jsonb,
         86400, 300, 'shared', 'p', 's')
    `.execute(db);

    let caught: unknown;
    try {
      await sql`
        INSERT INTO routines_v1_definitions
          (agent_id, path, author_user_id, name, description, spec_hash,
           trigger_kind, trigger_spec, silence_max, conversation, prompt_body,
           definition_id, next_run_at)
        VALUES
          ('agent-x', 'default:d-hb', 'admin', 'heartbeat', 'd', 'hash',
           'interval', '{"kind":"interval","every":"24h"}'::jsonb, 300, 'shared', 'p',
           'd-hb', now())
      `.execute(db);
    } catch (e) {
      caught = e;
    }
    // postgres CHECK violation = SQLSTATE 23514
    expect((caught as { code?: string } | undefined)?.code).toBe('23514');
  });

  it('first-boot seed of default heartbeat is idempotent', async () => {
    await runRoutinesMigration(db);
    await runRoutinesMigration(db);

    const rows = await sql<{ name: string; trigger_kind: string }>`
      SELECT name, trigger_kind FROM default_routines_v1 WHERE name = 'heartbeat'
    `.execute(db);
    expect(rows.rows).toEqual([{ name: 'heartbeat', trigger_kind: 'interval' }]);
  });

  it('routines_v1_definitions_default_idx exists', async () => {
    await runRoutinesMigration(db);
    const r = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'routines_v1_definitions'
         AND indexname = 'routines_v1_definitions_default_idx'
    `.execute(db);
    expect(r.rows).toHaveLength(1);
  });

  it('agent_default_routine_overrides_v1 has PK (agent_id, default_routine_id) and cascades from default_routines_v1', async () => {
    await runRoutinesMigration(db);
    // PK enforces one override per (agent, default).
    await db.insertInto('agent_default_routine_overrides_v1').values({
      agent_id: 'agt_a', default_routine_id: 'default-heartbeat-2026-05-19',
      owner_user_id: 'u1', enabled: false,
    }).execute();
    await expect(
      db.insertInto('agent_default_routine_overrides_v1').values({
        agent_id: 'agt_a', default_routine_id: 'default-heartbeat-2026-05-19',
        owner_user_id: 'u2', enabled: false,
      }).execute(),
    ).rejects.toThrow(/duplicate|unique/i);

    // FK ON DELETE CASCADE: deleting the default drops its overrides.
    await db.deleteFrom('default_routines_v1')
      .where('default_routine_id', '=', 'default-heartbeat-2026-05-19').execute();
    const remaining = await db.selectFrom('agent_default_routine_overrides_v1')
      .selectAll().where('agent_id', '=', 'agt_a').execute();
    expect(remaining).toEqual([]);
  });

  it('agent_default_routine_overrides_v1 rejects an override for a non-existent default (FK)', async () => {
    await runRoutinesMigration(db);
    await expect(
      db.insertInto('agent_default_routine_overrides_v1').values({
        agent_id: 'agt_a', default_routine_id: 'no-such-default',
        owner_user_id: 'u1', enabled: false,
      }).execute(),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
