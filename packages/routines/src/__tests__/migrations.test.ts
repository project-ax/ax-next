import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { ROUTINE_REPORT_STATUSES } from '@ax/routines-contract';
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
const constraintCount = async (name: string, table: string) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_constraint WHERE conname=${name} AND conrelid=${table}::regclass`.execute(db)).rows[0]?.n;
const rewindToVersion3 = async () => {
  await sql`DROP INDEX IF EXISTS routines_v1_dispatches_open_conversation`.execute(db);
  await sql`ALTER TABLE routines_v1_dispatches DROP COLUMN IF EXISTS conversation_id, DROP COLUMN IF EXISTS report`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT IF EXISTS routines_v1_definitions_task_status_chk,
    DROP COLUMN IF EXISTS task_status, DROP COLUMN IF EXISTS task_update, DROP COLUMN IF EXISTS task_ask,
    DROP COLUMN IF EXISTS task_reported_at, DROP COLUMN IF EXISTS task_report_accepted_at, DROP COLUMN IF EXISTS agent_notes`.execute(db);
  await sql`ALTER TABLE routines_v1_fires DROP CONSTRAINT IF EXISTS routines_v1_fires_report_status_chk,
    DROP COLUMN IF EXISTS report_status, DROP COLUMN IF EXISTS report_update, DROP COLUMN IF EXISTS report_ask`.execute(db);
  await sql`DELETE FROM routines_schema_versions WHERE version = 4`.execute(db);
};
const insertTask = (extraColumns = sql``, extraValues = sql``) => sql`INSERT INTO routines_v1_definitions (agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,trigger_kind,trigger_spec,conversation,prompt_body,kind,good_when${extraColumns}) VALUES ('a','r_task','rev_task','owner','task','','hash','interval','{"kind":"interval","every":"15m"}','per-fire','body','stay-on-top','Nothing waits a day.'${extraValues})`.execute(db);
const reportColumns = async () => ({
  dispatches: (await sql`SELECT dispatch_id, conversation_id, report FROM routines_v1_dispatches ORDER BY dispatch_id`.execute(db)).rows,
  definitions: (await sql`SELECT task_status, task_update, task_ask, task_reported_at, task_report_accepted_at, agent_notes FROM routines_v1_definitions WHERE routine_id='r_task'`.execute(db)).rows,
  fires: (await sql`SELECT dispatch_id, report_status, report_update, report_ask FROM routines_v1_fires ORDER BY dispatch_id`.execute(db)).rows,
});
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
    expect(await versions()).toEqual([2, 3, 4]);
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
    expect(await versions()).toEqual([2, 3, 4]);
    expect(await kindChecks()).toBe(1);
    expect((await sql`SELECT kind, good_when FROM routines_v1_definitions`.execute(db)).rows).toEqual([{ kind: 'stay-on-top', good_when: 'Nothing waits a day.' }]);
  });
  it('adds the report columns to a version-3 database; existing rows read back with no report', async () => {
    await runRoutinesMigration(db);
    await rewindToVersion3();
    // Version-3 shapes: a task, an open run that began before the upgrade, and a finished run's fire.
    await insertTask();
    await sql`INSERT INTO routines_v1_dispatches (dispatch_id,agent_id,routine_id,revision,req_id,accepted_at,completed_at,trigger_source) VALUES ('d_open','a','r_task','rev_task','req_open','2031-01-01T00:00:00Z',NULL,'tick')`.execute(db);
    await sql`INSERT INTO routines_v1_fires (agent_id,routine_id,dispatch_id,fired_at,trigger_source,conversation_id,status) VALUES ('a','r_task','d_done','2030-12-31T23:45:00Z','tick','c_done','ok')`.execute(db);
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4]);
    expect(await reportColumns()).toEqual({
      dispatches: [{ dispatch_id: 'd_open', conversation_id: null, report: null }],
      definitions: [{ task_status: null, task_update: null, task_ask: null, task_reported_at: null, task_report_accepted_at: null, agent_notes: null }],
      fires: [{ dispatch_id: 'd_done', report_status: null, report_update: null, report_ask: null }],
    });
    const indexes = (await sql<{ indexname: string }>`SELECT indexname FROM pg_indexes WHERE tablename='routines_v1_dispatches'`.execute(db)).rows.map(r => r.indexname);
    expect(indexes).toContain('routines_v1_dispatches_open_conversation');
    const store = createRoutinesStore(db);
    expect(await store.findOne({ agentId: 'a', routineId: 'r_task' })).toMatchObject({ routineId: 'r_task', kind: 'stay-on-top', goodWhen: 'Nothing waits a day.' });
    // The run that was open across the upgrade still finishes, with no report.
    expect(await store.finishDispatch({ dispatchId: 'd_open', outcome: { status: 'ok', conversationId: 'c_open', error: null, renderedPrompt: 'body', warning: null } })).toBe(true);
    expect((await reportColumns()).fires).toEqual([
      { dispatch_id: 'd_done', report_status: null, report_update: null, report_ask: null },
      { dispatch_id: 'd_open', report_status: null, report_update: null, report_ask: null },
    ]);
  });
  it('refuses an unknown task or report status at the database', async () => {
    await runRoutinesMigration(db);
    // INSERT, not UPDATE: the schema is dropped before each test, so an UPDATE would touch no row.
    await expect(insertTask(sql`,task_status`, sql`,'done'`)).rejects.toMatchObject({ code: '23514', constraint: 'routines_v1_definitions_task_status_chk' });
    await expect(sql`INSERT INTO routines_v1_fires (agent_id,routine_id,trigger_source,status,report_status) VALUES ('a','r_task','tick','ok','done')`.execute(db))
      .rejects.toMatchObject({ code: '23514', constraint: 'routines_v1_fires_report_status_chk' });
    for (const status of ROUTINE_REPORT_STATUSES) {
      await sql`INSERT INTO routines_v1_fires (agent_id,routine_id,trigger_source,status,report_status,report_update) VALUES ('a','r_task','tick','ok',${status},'ok')`.execute(db);
    }
    await insertTask(sql`,task_status`, sql`,'needs-you'`);
  });
  it.each(['none', 'routines_v1_definitions_task_status_chk', 'routines_v1_fires_report_status_chk'])('finishes version 4 over columns that already exist (check dropped=%s), keeping their values', async (dropped) => {
    await runRoutinesMigration(db);
    await insertTask(sql`,task_status,task_update,task_ask,task_reported_at,task_report_accepted_at,agent_notes`,
      sql`,'needs-you','Two tickets are late.','Can I refund order 1234?','2031-01-01T00:10:00Z','2031-01-01T00:00:00Z','Order 1234 waits on a refund.'`);
    await sql`INSERT INTO routines_v1_dispatches (dispatch_id,agent_id,routine_id,revision,req_id,accepted_at,completed_at,trigger_source,conversation_id,report) VALUES ('d_open','a','r_task','rev_task','req_open','2031-01-01T00:00:00Z',NULL,'tick','c_open','{"status":"needs-you","update":"Two tickets are late.","ask":null}')`.execute(db);
    await sql`INSERT INTO routines_v1_fires (agent_id,routine_id,dispatch_id,trigger_source,status,report_status,report_update,report_ask) VALUES ('a','r_task','d_done','tick','ok','off-track','Behind by one.',NULL)`.execute(db);
    if (dropped === 'routines_v1_definitions_task_status_chk') await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT routines_v1_definitions_task_status_chk`.execute(db);
    if (dropped === 'routines_v1_fires_report_status_chk') await sql`ALTER TABLE routines_v1_fires DROP CONSTRAINT routines_v1_fires_report_status_chk`.execute(db);
    const before = await reportColumns();
    await sql`DELETE FROM routines_schema_versions WHERE version = 4`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4]);
    expect(await constraintCount('routines_v1_definitions_task_status_chk', 'routines_v1_definitions')).toBe(1);
    expect(await constraintCount('routines_v1_fires_report_status_chk', 'routines_v1_fires')).toBe(1);
    expect((await sql`SELECT 1 FROM pg_indexes WHERE indexname='routines_v1_dispatches_open_conversation'`.execute(db)).rows).toHaveLength(1);
    expect(await reportColumns()).toEqual(before);
    expect(before.definitions).toEqual([{ task_status: 'needs-you', task_update: 'Two tickets are late.', task_ask: 'Can I refund order 1234?',
      task_reported_at: new Date('2031-01-01T00:10:00Z'), task_report_accepted_at: new Date('2031-01-01T00:00:00Z'), agent_notes: 'Order 1234 waits on a refund.' }]);
  });
});
