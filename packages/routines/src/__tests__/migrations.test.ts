import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';
import { runRoutinesMigration as legacyMigration } from './fixtures/legacy-migration.js';
import { SKILL_REFLECTION_PROMPT, SKILL_REFLECTION_SEED_HASH, SKILL_REFLECTION_STRATA_SEED_HASH } from '../reflection-prompt.js';
let container: StartedPostgreSqlContainer; let db: Kysely<RoutinesDatabase>;
beforeAll(async () => { container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine')); db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }) }); }, 120_000);
afterAll(async () => { await db?.destroy(); if (container) await stopPostgresContainer(container); }, 60_000);
beforeEach(async () => { await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public`.execute(db); });
const definitionColumns = async () => (await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='routines_v1_definitions'`.execute(db)).rows.map(r => r.column_name);
const versions = async () => (await sql<{ version: number }>`SELECT version FROM routines_schema_versions ORDER BY version`.execute(db)).rows.map(r => r.version);
const kindChecks = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_constraint WHERE conname='routines_v1_definitions_kind_chk' AND conrelid='routines_v1_definitions'::regclass`.execute(db)).rows[0]?.n;
const rewindToVersion2 = async () => {
  await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT IF EXISTS routines_v1_definitions_kind_chk, DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS good_when`.execute(db);
  await sql`DELETE FROM routines_schema_versions WHERE version = 3`.execute(db);
};
describe('versioned routines migration', () => {
  it('seeds canonical defaults once, leaves reflection off, and creates required indexes', async () => {
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    const defaults = await db.selectFrom('default_routines_v1').selectAll().orderBy('name').execute();
    expect(defaults).toHaveLength(2); expect(defaults[0]?.name).toBe('heartbeat'); expect(defaults[0]?.enabled).toBe(true);
    expect(defaults[1]).toMatchObject({ name: 'skill-reflection', enabled: false, prompt_body: SKILL_REFLECTION_PROMPT, spec_hash: SKILL_REFLECTION_SEED_HASH });
    const indexes = (await sql<{ indexname: string }>`SELECT indexname FROM pg_indexes WHERE tablename IN ('routines_v1_definitions','routines_v1_fires')`.execute(db)).rows.map(r => r.indexname);
    expect(indexes).toEqual(expect.arrayContaining(['routines_v1_due', 'routines_v1_fires_by_agent', 'routines_v1_webhook_path_unique', 'routines_v1_fires_dispatch_id_key']));
    await db.deleteFrom('default_routines_v1').where('name', '=', 'heartbeat').execute(); await runRoutinesMigration(db);
    expect(await db.selectFrom('default_routines_v1').selectAll().execute()).toHaveLength(1);
  });
  it.each([false, true])('preserves guarded legacy seed update with prior fire=%s', async (fired) => {
    await legacyMigration(db as never);
    await sql`UPDATE default_routines_v1 SET spec_hash=${SKILL_REFLECTION_STRATA_SEED_HASH},source_md='seed',prompt_body='old',enabled=false WHERE name='skill-reflection'`.execute(db);
    if (fired) await sql`INSERT INTO routines_v1_fires(agent_id,path,trigger_source,status) VALUES ('a','default:skill-reflection','tick','silenced')`.execute(db);
    await runRoutinesMigration(db);
    const row = await db.selectFrom('default_routines_v1').selectAll().where('name', '=', 'skill-reflection').executeTakeFirstOrThrow();
    expect(row.prompt_body).toBe(SKILL_REFLECTION_PROMPT); expect(row.spec_hash).toBe(SKILL_REFLECTION_SEED_HASH); expect(row.enabled).toBe(fired);
    expect(await definitionColumns()).toEqual(expect.arrayContaining(['kind', 'good_when']));
  });
  it('does not overwrite a customized legacy seed even when its old hash remains', async () => {
    await legacyMigration(db as never);
    await sql`UPDATE default_routines_v1 SET spec_hash=${SKILL_REFLECTION_STRATA_SEED_HASH},source_md='custom',prompt_body='my prompt',enabled=false WHERE name='skill-reflection'`.execute(db);
    await runRoutinesMigration(db); expect((await db.selectFrom('default_routines_v1').selectAll().where('name', '=', 'skill-reflection').executeTakeFirstOrThrow()).prompt_body).toBe('my prompt');
    expect(await definitionColumns()).toEqual(expect.arrayContaining(['kind', 'good_when']));
  });
  it('adds kind and good_when to a version-2 database; existing rows read back as repeat/null', async () => {
    await runRoutinesMigration(db);
    await rewindToVersion2();
    // The version-2 column list from retirement.test.ts.
    await sql`INSERT INTO routines_v1_definitions (agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,trigger_kind,trigger_spec,conversation,prompt_body) VALUES ('a','r_old','rev_old','owner','old','','hash','interval','{"kind":"interval","every":"60s"}','per-fire','old')`.execute(db);
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect((await sql`SELECT kind, good_when FROM routines_v1_definitions WHERE routine_id='r_old'`.execute(db)).rows).toEqual([{ kind: 'repeat', good_when: null }]);
    expect(await createRoutinesStore(db).findOne({ agentId: 'a', routineId: 'r_old' })).toMatchObject({ kind: 'repeat', goodWhen: null });
    expect(await versions()).toEqual([2, 3]);
  });
  it('refuses an unknown kind at the database', async () => {
    await runRoutinesMigration(db);
    await expect(sql`INSERT INTO routines_v1_definitions (agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,trigger_kind,trigger_spec,conversation,prompt_body,kind) VALUES ('a','r_new','rev_new','owner','new','','hash','interval','{"kind":"interval","every":"60s"}','per-fire','new','get-done')`.execute(db))
      .rejects.toMatchObject({ code: '23514', constraint: 'routines_v1_definitions_kind_chk' });
  });
  it.each([false, true])('finishes version 3 over kind and good_when that already exist (check dropped=%s), keeping their values', async (dropCheck) => {
    await runRoutinesMigration(db);
    await sql`INSERT INTO routines_v1_definitions (agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,trigger_kind,trigger_spec,conversation,prompt_body,kind,good_when) VALUES ('a','r_task','rev_task','owner','task','','hash','interval','{"kind":"interval","every":"15m"}','per-fire','body','stay-on-top','Nothing waits a day.')`.execute(db);
    if (dropCheck) await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT routines_v1_definitions_kind_chk`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 3`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3]);
    expect(await kindChecks()).toBe(1);
    expect((await sql`SELECT kind, good_when FROM routines_v1_definitions`.execute(db)).rows).toEqual([{ kind: 'stay-on-top', good_when: 'Nothing waits a day.' }]);
  });
});
