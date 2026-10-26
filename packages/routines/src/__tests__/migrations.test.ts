import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { CHECK_IN_MISSES, ROUTINE_REPORT_STATUSES } from '@ax/routines-contract';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore, taskConversationQuery } from '../store.js';
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
const insertTask = (extraColumns = sql``, extraValues = sql``, routineId = 'r_task') => sql`INSERT INTO routines_v1_definitions (agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,schedule_spec,webhook_spec,conversation,prompt_body,kind,good_when${extraColumns}) VALUES ('a',${routineId},'rev_task','owner','task','','hash','{"kind":"interval","every":"15m"}',NULL,'per-fire','body','stay-on-top','Nothing waits a day.'${extraValues})`.execute(db);
const MISS_REASON_CHECK = 'routines_v1_definitions_task_miss_reason_chk';
const FINISH_BY_CHECK = 'routines_v1_definitions_finish_by_chk';
const missColumns = async () => (await sql`SELECT task_misses_in_a_row, task_miss_reason, task_miss_at, task_auto_paused_at FROM routines_v1_definitions WHERE routine_id='r_task'`.execute(db)).rows;
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
  it('repairs missing v3 kind/good_when fields without changing canonical method storage', async () => {
    await runRoutinesMigration(db);
    await rewindToVersion2();
    // Repair the missing v3 fields while retaining the later canonical method storage.
    await sql`INSERT INTO routines_v1_definitions (agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,schedule_spec,webhook_spec,conversation,prompt_body) VALUES ('a','r_old','rev_old','owner','old','','hash','{"kind":"interval","every":"60s"}',NULL,'per-fire','old')`.execute(db);
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect((await sql`SELECT kind, good_when FROM routines_v1_definitions WHERE routine_id='r_old'`.execute(db)).rows).toEqual([{ kind: 'repeat', good_when: null }]);
    expect(await createRoutinesStore(db).findOne({ agentId: 'a', routineId: 'r_old' })).toMatchObject({ kind: 'repeat', goodWhen: null });
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
  it('refuses an unknown kind at the database', async () => {
    await runRoutinesMigration(db);
    await expect(sql`INSERT INTO routines_v1_definitions (agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,schedule_spec,webhook_spec,conversation,prompt_body,kind) VALUES ('a','r_new','rev_new','owner','new','','hash','{"kind":"interval","every":"60s"}',NULL,'per-fire','new','nope')`.execute(db))
      .rejects.toMatchObject({ code: '23514', constraint: 'routines_v1_definitions_kind_chk' });
  });
  it.each([false, true])('finishes version 3 over kind and good_when that already exist (check dropped=%s), keeping their values', async (dropCheck) => {
    await runRoutinesMigration(db);
    await sql`INSERT INTO routines_v1_definitions (agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,schedule_spec,webhook_spec,conversation,prompt_body,kind,good_when) VALUES ('a','r_task','rev_task','owner','task','','hash','{"kind":"interval","every":"15m"}',NULL,'per-fire','body','stay-on-top','Nothing waits a day.')`.execute(db);
    if (dropCheck) await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT routines_v1_definitions_kind_chk`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 3`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
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
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
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
  it('version 5 indexes every run\'s conversation, and a finished run\'s lookup can use it (TASK-908)', async () => {
    await runRoutinesMigration(db);
    await sql`INSERT INTO routines_v1_dispatches (dispatch_id,agent_id,routine_id,revision,req_id,accepted_at,completed_at,trigger_source,conversation_id) VALUES ('d_done','a','r','rev','req_done','2031-01-01T00:00:00Z','2031-01-01T00:01:00Z','tick','c_done')`.execute(db);
    await sql`DROP INDEX routines_v1_dispatches_conversation`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 5`.execute(db);
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect((await sql`SELECT 1 FROM pg_indexes WHERE indexname='routines_v1_dispatches_conversation'`.execute(db)).rows).toHaveLength(1);
    expect((await sql`SELECT dispatch_id FROM routines_v1_dispatches`.execute(db)).rows).toEqual([{ dispatch_id: 'd_done' }]);
    // The planner may still pick a scan on a tiny table; with scans priced out, the store's own query reads the index.
    const compiled = taskConversationQuery(db, { agentId: 'a', conversationId: 'c_done' }).compile();
    await db.connection().execute(async conn => {
      await sql`SET enable_seqscan = off`.execute(conn);
      const plan = (await conn.executeQuery<{ 'QUERY PLAN': string }>(CompiledQuery.raw(`EXPLAIN ${compiled.sql}`, [...compiled.parameters]))).rows
        .map(row => row['QUERY PLAN']).join('\n');
      await sql`RESET enable_seqscan`.execute(conn);
      expect(plan).toContain('routines_v1_dispatches_conversation');
    });
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
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await constraintCount('routines_v1_definitions_task_status_chk', 'routines_v1_definitions')).toBe(1);
    expect(await constraintCount('routines_v1_fires_report_status_chk', 'routines_v1_fires')).toBe(1);
    expect((await sql`SELECT 1 FROM pg_indexes WHERE indexname='routines_v1_dispatches_open_conversation'`.execute(db)).rows).toHaveLength(1);
    expect(await reportColumns()).toEqual(before);
    expect(before.definitions).toEqual([{ task_status: 'needs-you', task_update: 'Two tickets are late.', task_ask: 'Can I refund order 1234?',
      task_reported_at: new Date('2031-01-01T00:10:00Z'), task_report_accepted_at: new Date('2031-01-01T00:00:00Z'), agent_notes: 'Order 1234 waits on a refund.' }]);
  });
  it('version 6 adds agent_notes_cleared_at; existing rows read back with none (TASK-910)', async () => {
    const cleared = async () => (await sql`SELECT agent_notes, agent_notes_cleared_at FROM routines_v1_definitions WHERE routine_id='r_task'`.execute(db)).rows;
    await runRoutinesMigration(db);
    await sql`ALTER TABLE routines_v1_definitions DROP COLUMN IF EXISTS agent_notes_cleared_at`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 6`.execute(db);
    // A version-5 task whose check-in left notes.
    await insertTask(sql`,agent_notes`, sql`,'Order 1234 waits on a refund.'`);
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await cleared()).toEqual([{ agent_notes: 'Order 1234 waits on a refund.', agent_notes_cleared_at: null }]);
    expect(await createRoutinesStore(db).findOne({ agentId: 'a', routineId: 'r_task' })).toMatchObject({ routineId: 'r_task', kind: 'stay-on-top' });
    // Finishing version 6 over the column it added keeps the column's values.
    await sql`UPDATE routines_v1_definitions SET agent_notes = NULL, agent_notes_cleared_at = '2031-01-01T00:00:00Z' WHERE routine_id='r_task'`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 6`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await cleared()).toEqual([{ agent_notes: null, agent_notes_cleared_at: new Date('2031-01-01T00:00:00Z') }]);
  });
  it('version 7 adds the miss columns; existing rows read back with none (TASK-930)', async () => {
    await runRoutinesMigration(db);
    await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT IF EXISTS routines_v1_definitions_task_miss_reason_chk,
      DROP COLUMN IF EXISTS task_misses_in_a_row, DROP COLUMN IF EXISTS task_miss_reason,
      DROP COLUMN IF EXISTS task_miss_at, DROP COLUMN IF EXISTS task_auto_paused_at`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 7`.execute(db);
    // A version-6 task.
    await insertTask();
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await missColumns()).toEqual([{ task_misses_in_a_row: 0, task_miss_reason: null, task_miss_at: null, task_auto_paused_at: null }]);
    expect(await constraintCount(MISS_REASON_CHECK, 'routines_v1_definitions')).toBe(1);
    expect((await createRoutinesStore(db).findOne({ agentId: 'a', routineId: 'r_task' }))?.noRecentUpdate).toBeNull();
    // Finishing version 7 over the columns it added keeps their values, with its CHECK in place or dropped.
    const at = new Date('2031-01-01T00:00:00Z');
    await sql`UPDATE routines_v1_definitions SET task_misses_in_a_row = 2, task_miss_reason = 'interrupted', task_miss_at = ${at} WHERE routine_id='r_task'`.execute(db);
    for (const dropCheck of [false, true]) {
      if (dropCheck) await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT routines_v1_definitions_task_miss_reason_chk`.execute(db);
      await sql`DELETE FROM routines_schema_versions WHERE version = 7`.execute(db);
      await runRoutinesMigration(db);
      expect(await versions(), `check dropped=${dropCheck}`).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(await constraintCount(MISS_REASON_CHECK, 'routines_v1_definitions'), `check dropped=${dropCheck}`).toBe(1);
      expect(await missColumns(), `check dropped=${dropCheck}`).toEqual([{ task_misses_in_a_row: 2, task_miss_reason: 'interrupted', task_miss_at: at, task_auto_paused_at: null }]);
    }
    expect((await createRoutinesStore(db).findOne({ agentId: 'a', routineId: 'r_task' }))?.noRecentUpdate).toEqual({ inARow: 2, reason: 'interrupted', at, autoPausedAt: null });
  });
  it('version 8 adds the replies table; a re-run keeps its rows (TASK-931)', async () => {
    await runRoutinesMigration(db);
    await sql`DROP TABLE routines_v1_replies`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 8`.execute(db);
    // A version-7 task.
    await insertTask();
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect((await sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='routines_v1_replies' ORDER BY ordinal_position`.execute(db)).rows).toEqual([
      { column_name: 'reply_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'agent_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'routine_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'author_user_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'request_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'body', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    ]);
    const byRoutine = (await sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes WHERE indexname='routines_v1_replies_by_routine'`.execute(db)).rows;
    expect(byRoutine).toHaveLength(1);
    expect(byRoutine[0]?.indexdef).toContain('(agent_id, routine_id, created_at DESC)');
    expect(await constraintCount('routines_v1_replies_pkey', 'routines_v1_replies')).toBe(1);
    expect(await constraintCount('routines_v1_replies_request_unique', 'routines_v1_replies')).toBe(1);
    // A retry's key: the same person, request and routine is one reply, whatever its id.
    const reply = (replyId: string) => sql`INSERT INTO routines_v1_replies (reply_id,agent_id,routine_id,author_user_id,request_id,body,created_at)
      VALUES (${replyId},'a','r_task','owner','req_1','I answered Acme.','2031-01-01T00:00:00Z')`.execute(db);
    await reply('reply_1');
    await expect(reply('reply_2')).rejects.toMatchObject({ code: '23505', constraint: 'routines_v1_replies_request_unique' });
    // Finishing version 8 over the table it made keeps its rows.
    await sql`DELETE FROM routines_schema_versions WHERE version = 8`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect((await sql`SELECT reply_id, body FROM routines_v1_replies`.execute(db)).rows).toEqual([{ reply_id: 'reply_1', body: 'I answered Acme.' }]);
    expect(await createRoutinesStore(db).findOne({ agentId: 'a', routineId: 'r_task' })).toMatchObject({ routineId: 'r_task', kind: 'stay-on-top' });
  });
  it('version 9 records who each run ran as: existing runs read as their routine’s owner, a gone routine’s stay unknown, and a re-run keeps them (TASK-936)', async () => {
    await runRoutinesMigration(db);
    await sql`ALTER TABLE routines_v1_dispatches DROP COLUMN IF EXISTS run_as_user_id`.execute(db);
    await sql`ALTER TABLE routines_v1_fires DROP COLUMN IF EXISTS run_as_user_id`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 9`.execute(db);
    // Version-8 rows: a task, a run open across the upgrade, a finished run's fire, and a fire whose routine is gone.
    await insertTask();
    await sql`INSERT INTO routines_v1_dispatches (dispatch_id,agent_id,routine_id,revision,req_id,accepted_at,completed_at,trigger_source) VALUES ('d_open','a','r_task','rev_task','req_open','2031-01-01T00:00:00Z',NULL,'tick')`.execute(db);
    await sql`INSERT INTO routines_v1_fires (agent_id,routine_id,dispatch_id,fired_at,trigger_source,conversation_id,status,report_status,report_update) VALUES ('a','r_task','d_done','2030-12-31T23:45:00Z','tick','c_done','ok','on-track','Queue is empty.')`.execute(db);
    await sql`INSERT INTO routines_v1_fires (agent_id,routine_id,dispatch_id,fired_at,trigger_source,conversation_id,status) VALUES ('a','r_gone','d_gone','2030-12-31T23:30:00Z','tick','c_gone','ok')`.execute(db);
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect((await sql`SELECT table_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema=current_schema() AND column_name='run_as_user_id' ORDER BY table_name`.execute(db)).rows).toEqual([
      { table_name: 'routines_v1_dispatches', data_type: 'text', is_nullable: 'YES' },
      { table_name: 'routines_v1_fires', data_type: 'text', is_nullable: 'YES' },
    ]);
    const runAs = async () => ({
      dispatches: (await sql`SELECT dispatch_id, run_as_user_id FROM routines_v1_dispatches ORDER BY dispatch_id`.execute(db)).rows,
      fires: (await sql`SELECT dispatch_id, run_as_user_id FROM routines_v1_fires ORDER BY dispatch_id`.execute(db)).rows,
    });
    const backfilled = {
      dispatches: [{ dispatch_id: 'd_open', run_as_user_id: 'owner' }],
      fires: [{ dispatch_id: 'd_done', run_as_user_id: 'owner' }, { dispatch_id: 'd_gone', run_as_user_id: null }],
    };
    expect(await runAs()).toEqual(backfilled);
    // Finishing version 9 over the columns it added keeps their values, even once the routine has another owner.
    await sql`UPDATE routines_v1_definitions SET owner_user_id = 'someone-else' WHERE routine_id = 'r_task'`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 9`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await runAs()).toEqual(backfilled);
  });
  it('version 10 adds the reading columns; existing rows read back with none, and a re-run keeps values (TASK-952)', async () => {
    await runRoutinesMigration(db);
    for (const statement of [
      sql`ALTER TABLE routines_v1_definitions DROP COLUMN IF EXISTS task_reading_value`,
      sql`ALTER TABLE routines_v1_definitions DROP COLUMN IF EXISTS task_reading_label`,
      sql`ALTER TABLE routines_v1_definitions DROP COLUMN IF EXISTS task_reading_reported_at`,
      sql`ALTER TABLE routines_v1_dispatches DROP COLUMN IF EXISTS report_reading_value`,
      sql`ALTER TABLE routines_v1_dispatches DROP COLUMN IF EXISTS report_reading_label`,
      sql`ALTER TABLE routines_v1_fires DROP COLUMN IF EXISTS report_reading_value`,
      sql`ALTER TABLE routines_v1_fires DROP COLUMN IF EXISTS report_reading_label`,
    ]) await statement.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 10`.execute(db);
    // A version-9 row.
    await insertTask();
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect((await sql`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema=current_schema() AND column_name LIKE '%reading%' ORDER BY table_name, column_name`.execute(db)).rows).toEqual([
      { table_name: 'routines_v1_definitions', column_name: 'task_reading_label', data_type: 'text', is_nullable: 'YES' },
      { table_name: 'routines_v1_definitions', column_name: 'task_reading_reported_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { table_name: 'routines_v1_definitions', column_name: 'task_reading_value', data_type: 'double precision', is_nullable: 'YES' },
      { table_name: 'routines_v1_dispatches', column_name: 'report_reading_label', data_type: 'text', is_nullable: 'YES' },
      { table_name: 'routines_v1_dispatches', column_name: 'report_reading_value', data_type: 'double precision', is_nullable: 'YES' },
      { table_name: 'routines_v1_fires', column_name: 'report_reading_label', data_type: 'text', is_nullable: 'YES' },
      { table_name: 'routines_v1_fires', column_name: 'report_reading_value', data_type: 'double precision', is_nullable: 'YES' },
    ]);
    const reading = async () => (await sql`SELECT task_reading_value, task_reading_label, task_reading_reported_at FROM routines_v1_definitions WHERE routine_id='r_task'`.execute(db)).rows;
    expect(await reading()).toEqual([{ task_reading_value: null, task_reading_label: null, task_reading_reported_at: null }]);
    // Finishing version 10 over the columns it added keeps their values.
    const at = new Date('2031-01-01T00:00:00Z');
    await sql`UPDATE routines_v1_definitions SET task_reading_value = 3, task_reading_label = 'Open tickets', task_reading_reported_at = ${at} WHERE routine_id='r_task'`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 10`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await reading()).toEqual([{ task_reading_value: 3, task_reading_label: 'Open tickets', task_reading_reported_at: at }]);
  });
  it('version 11 lets a task be get-done and gives every task an empty checklist; a re-run keeps both (TASK-948)', async () => {
    const insertKind = (routineId: string, kind: string) => sql`INSERT INTO routines_v1_definitions (agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,schedule_spec,webhook_spec,conversation,prompt_body,kind,good_when) VALUES ('a',${routineId},'rev','owner','task','','hash','{"kind":"interval","every":"15m"}',NULL,'per-fire','body',${kind},'Done when it is done.')`.execute(db);
    const stepsOf = async (routineId: string) => (await sql<{ task_steps: unknown }>`SELECT task_steps FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(db)).rows[0]?.task_steps;
    await runRoutinesMigration(db);
    // Back to version 10: the column gone and the old check in place.
    await sql`ALTER TABLE routines_v1_definitions DROP COLUMN IF EXISTS task_steps`.execute(db);
    await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT routines_v1_definitions_kind_chk, ADD CONSTRAINT routines_v1_definitions_kind_chk CHECK (kind IN ('repeat', 'stay-on-top'))`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 11`.execute(db);
    await insertTask();
    await expect(insertKind('r_early', 'get-done')).rejects.toMatchObject({ code: '23514', constraint: 'routines_v1_definitions_kind_chk' });
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await kindChecks()).toBe(1);
    expect((await sql`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='routines_v1_definitions' AND column_name='task_steps'`.execute(db)).rows)
      .toEqual([{ data_type: 'jsonb', is_nullable: 'NO', column_default: "'[]'::jsonb" }]);
    expect(await stepsOf('r_task')).toEqual([]);
    await insertKind('r_get_done', 'get-done');
    await expect(insertKind('r_nope', 'nope')).rejects.toMatchObject({ code: '23514', constraint: 'routines_v1_definitions_kind_chk' });
    // Finishing version 11 over the swap it already made keeps the check and every checklist.
    const kept = [{ id: 's000001', text: 'Keep me', done: true, addedBy: 'agent' }];
    await sql`UPDATE routines_v1_definitions SET task_steps = ${JSON.stringify(kept)}::jsonb WHERE routine_id = 'r_get_done'`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 11`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await kindChecks()).toBe(1);
    expect(await stepsOf('r_get_done')).toEqual(kept);
    await expect(insertKind('r_nope_2', 'nope')).rejects.toMatchObject({ code: '23514', constraint: 'routines_v1_definitions_kind_chk' });
  });
  it('version 12 gives a task a finish date column and its check; a re-run keeps both and every date (TASK-951)', async () => {
    const finishBy = async () => (await sql`SELECT finish_by FROM routines_v1_definitions WHERE routine_id='r_task'`.execute(db)).rows;
    await runRoutinesMigration(db);
    // Back to version 11: the column and its check gone.
    await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT IF EXISTS routines_v1_definitions_finish_by_chk, DROP COLUMN IF EXISTS finish_by`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 12`.execute(db);
    // A version-11 task.
    await insertTask();
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect((await sql`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='routines_v1_definitions' AND column_name='finish_by'`.execute(db)).rows)
      .toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
    expect(await constraintCount(FINISH_BY_CHECK, 'routines_v1_definitions')).toBe(1);
    expect(await finishBy()).toEqual([{ finish_by: null }]);
    expect((await createRoutinesStore(db).findOne({ agentId: 'a', routineId: 'r_task' }))?.finishBy).toBeNull();
    // Finishing version 12 over the column it added keeps its values and its one check.
    await sql`UPDATE routines_v1_definitions SET finish_by = '2026-11-14' WHERE routine_id='r_task'`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 12`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await constraintCount(FINISH_BY_CHECK, 'routines_v1_definitions')).toBe(1);
    expect(await finishBy()).toEqual([{ finish_by: '2026-11-14' }]);
  });
  it('refuses a finish_by that isn\'t YYYY-MM-DD at the database, and takes one that is (TASK-951)', async () => {
    await runRoutinesMigration(db);
    // INSERT, not UPDATE: the schema is dropped before each test, so an UPDATE would touch no row.
    // The second and third catch a check with no anchors, the last a digit class wider than ASCII.
    for (const value of ['Nov 14', ' 2026-11-14', '2026-11-14T00:00:00Z', '2026-1-14', '', '\uFF12\uFF10\uFF12\uFF16-11-14']) {
      await expect(insertTask(sql`,finish_by`, sql`,${value}`), JSON.stringify(value)).rejects.toMatchObject({ code: '23514', constraint: FINISH_BY_CHECK });
    }
    // The check is the format alone: a real date and NULL go in, and so does a day no calendar has, which a read
    // refuses instead (store.ts). A check written with \d, which Kysely's sql tag sends as a plain d, refuses both dates.
    await insertTask(sql`,finish_by`, sql`,'2026-11-14'`, 'r_dated');
    await insertTask(sql`,finish_by`, sql`,NULL`, 'r_undated');
    await insertTask(sql`,finish_by`, sql`,'2026-02-30'`, 'r_no_such_day');
    expect((await sql`SELECT routine_id, finish_by FROM routines_v1_definitions ORDER BY routine_id`.execute(db)).rows).toEqual([
      { routine_id: 'r_dated', finish_by: '2026-11-14' },
      { routine_id: 'r_no_such_day', finish_by: '2026-02-30' },
      { routine_id: 'r_undated', finish_by: null },
    ]);
  });
  it('version 13 adds a task’s claim and completion, nullable and empty; a re-run keeps them (TASK-950)', async () => {
    await runRoutinesMigration(db);
    await sql`ALTER TABLE routines_v1_definitions DROP COLUMN IF EXISTS task_done_claimed_at, DROP COLUMN IF EXISTS task_completed_at,
      DROP COLUMN IF EXISTS task_completed_by_user_id`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 13`.execute(db);
    // A version-12 row.
    await insertTask();
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect((await sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='routines_v1_definitions'
        AND column_name IN ('task_done_claimed_at', 'task_completed_at', 'task_completed_by_user_id') ORDER BY column_name`.execute(db)).rows).toEqual([
      { column_name: 'task_completed_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'task_completed_by_user_id', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'task_done_claimed_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ]);
    const doneColumns = async () => (await sql`SELECT task_done_claimed_at, task_completed_at, task_completed_by_user_id FROM routines_v1_definitions WHERE routine_id='r_task'`.execute(db)).rows;
    expect(await doneColumns()).toEqual([{ task_done_claimed_at: null, task_completed_at: null, task_completed_by_user_id: null }]);
    // Finishing version 13 over the columns it added keeps their values.
    const at = new Date('2031-01-01T00:00:00Z');
    await sql`UPDATE routines_v1_definitions SET task_done_claimed_at = ${at}, task_completed_at = ${at}, task_completed_by_user_id = 'owner' WHERE routine_id='r_task'`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 13`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await doneColumns()).toEqual([{ task_done_claimed_at: at, task_completed_at: at, task_completed_by_user_id: 'owner' }]);
  });
  it('version 14 gives a finish date the zone it was set from, nullable with no default or check; a re-run keeps every value (TASK-955)', async () => {
    const zoneOf = async (routineId: string) => (await sql`SELECT finish_by, finish_by_time_zone FROM routines_v1_definitions WHERE routine_id=${routineId}`.execute(db)).rows;
    await runRoutinesMigration(db);
    // Back to version 13: the column gone.
    await sql`ALTER TABLE routines_v1_definitions DROP COLUMN IF EXISTS finish_by_time_zone`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 14`.execute(db);
    // A version-13 row.
    await insertTask();
    await runRoutinesMigration(db); await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect((await sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='routines_v1_definitions' AND column_name='finish_by_time_zone'`.execute(db)).rows)
      .toEqual([{ column_name: 'finish_by_time_zone', data_type: 'text', is_nullable: 'YES', column_default: null }]);
    expect((await sql`SELECT finish_by_time_zone FROM routines_v1_definitions WHERE routine_id='r_task'`.execute(db)).rows).toEqual([{ finish_by_time_zone: null }]);
    // Finishing version 14 over the column it added keeps its values.
    await sql`UPDATE routines_v1_definitions SET finish_by = '2026-10-25', finish_by_time_zone = 'America/Los_Angeles' WHERE routine_id='r_task'`.execute(db);
    await sql`DELETE FROM routines_schema_versions WHERE version = 14`.execute(db);
    await runRoutinesMigration(db);
    expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await zoneOf('r_task')).toEqual([{ finish_by: '2026-10-25', finish_by_time_zone: 'America/Los_Angeles' }]);
    // No check of any kind. A zone no calendar has goes in: the read refuses it instead (`storedFinishByTimeZone`,
    // store.ts). So does a zone beside no date: code from before this version clears the date alone (its Remove date,
    // its change of kind), and that must still work after a rollback.
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid='routines_v1_definitions'::regclass AND pg_get_constraintdef(oid) LIKE '%finish_by_time_zone%'`.execute(db)).rows[0]?.n).toBe(0);
    await insertTask(sql`,finish_by_time_zone`, sql`,'Not/AZone'`, 'r_odd_zone');
    await insertTask(sql`,finish_by_time_zone`, sql`,'America/Los_Angeles'`, 'r_zone_no_date');
    expect(await zoneOf('r_odd_zone')).toEqual([{ finish_by: null, finish_by_time_zone: 'Not/AZone' }]);
    expect(await zoneOf('r_zone_no_date')).toEqual([{ finish_by: null, finish_by_time_zone: 'America/Los_Angeles' }]);
  });
  it('refuses an unknown miss reason at the database (TASK-930)', async () => {
    await runRoutinesMigration(db);
    // INSERT, not UPDATE: the schema is dropped before each test, so an UPDATE would touch no row.
    await expect(insertTask(sql`,task_miss_reason`, sql`,'gremlins'`)).rejects.toMatchObject({ code: '23514', constraint: MISS_REASON_CHECK });
    for (const reason of CHECK_IN_MISSES) await insertTask(sql`,task_miss_reason`, sql`,${reason}`, `r_${reason}`);
    expect((await sql<{ task_miss_reason: string }>`SELECT task_miss_reason FROM routines_v1_definitions ORDER BY routine_id`.execute(db)).rows.map(r => r.task_miss_reason).sort())
      .toEqual([...CHECK_IN_MISSES].sort());
  });
  it('a stored reason no code knows reads as failed and doesn\'t stop the tick (TASK-930)', async () => {
    await runRoutinesMigration(db);
    // A later version's reason, read after a rollback (TASK-913): its CHECK would allow it.
    await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT routines_v1_definitions_task_miss_reason_chk`.execute(db);
    const at = new Date('2031-01-01T00:00:00Z');
    const due = new Date('2031-01-01T00:15:00Z');
    await insertTask(sql`,task_misses_in_a_row,task_miss_reason,task_miss_at,next_run_at`, sql`,2,'gremlins',${at},${due}`);
    const store = createRoutinesStore(db);
    const misses = { inARow: 2, reason: 'failed', at, autoPausedAt: null };
    expect((await store.findOne({ agentId: 'a', routineId: 'r_task' }))?.noRecentUpdate).toEqual(misses);
    const claimed = await store.claimDue({ now: new Date(due.getTime() + 60_000), limit: 10, claimWindowMinutes: 5 });
    expect(claimed).toEqual([expect.objectContaining({ routineId: 'r_task', noRecentUpdate: misses })]);
  });
});
