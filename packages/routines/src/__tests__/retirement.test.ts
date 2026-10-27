import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { runRoutinesMigration as legacyMigration } from './fixtures/legacy-migration.js';
let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;
beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }) });
}, 120_000);
afterAll(async () => { await db?.destroy(); if (container) await stopPostgresContainer(container); }, 60_000);
beforeEach(async () => { await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public`.execute(db); });
const columns = async (table: string) => (await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_name=${table}`.execute(db)).rows.map(r => r.column_name);
describe('authored retirement', () => {
  it('creates only database identity and durable lifecycle tables on fresh installs', async () => {
    await runRoutinesMigration(db);
    expect(await columns('routines_v1_definitions')).toContain('routine_id');
    expect(await columns('routines_v1_definitions')).not.toContain('path');
    expect(await columns('default_routines_v1')).not.toContain('source_md');
    expect(await columns('routines_v1_requests')).toContain('result');
  });
  it('retires authored definitions and orphan fires once, retaining defaults and exact cleanup scope', async () => {
    await legacyMigration(db as never);
    for (const [path, kind, spec] of [
      ['one.md', 'interval', { kind: 'interval', every: '60s' }],
      ['two.md', 'cron', { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }],
      ['three.md', 'webhook', { kind: 'webhook', path: '/hook', events: ['push'], hmac: { secretRef: 'provider:anthropic', header: 'x-signature', algorithm: 'sha256', prefix: 'sha256=' } }],
    ] as const) {
      await sql`INSERT INTO routines_v1_definitions (agent_id,path,owner_user_id,name,description,spec_hash,trigger_kind,trigger_spec,active_hours,silence_token,silence_max,conversation,prompt_body,last_run_at,last_status,last_error,last_warning) VALUES ('a',${path},'owner',${path},'description','hash',${kind},${JSON.stringify(spec)}::jsonb,'{"start":"09:00","end":"17:00","tz":"UTC"}','quiet',400,'shared','body',now(),'error','old-error','warning')`.execute(db);
      await sql`INSERT INTO routines_v1_fires (agent_id,path,trigger_source,status) VALUES ('a',${path},'tick','ok')`.execute(db);
    }
    await sql`INSERT INTO routines_v1_fires (agent_id,path,trigger_source,status) VALUES ('a','orphan.md','tick','ok'), ('a','default:skill-reflection','tick','ok'), ('a','default:deleted-catalog-entry','tick','ok')`.execute(db);
    await sql`UPDATE default_routines_v1 SET prompt_body='custom body', source_md='custom', spec_hash='custom-hash', enabled=true WHERE name='heartbeat'`.execute(db);
    await sql`INSERT INTO agent_default_routine_overrides_v1 (agent_id,default_routine_id,owner_user_id,enabled) VALUES ('a','skill-reflection','owner',false)`.execute(db);
    await sql`INSERT INTO routines_v1_definitions (agent_id,path,owner_user_id,name,description,spec_hash,trigger_kind,trigger_spec,conversation,prompt_body,definition_id) VALUES ('a','default:default-heartbeat-2026-05-19','owner','heartbeat','','custom-hash','interval','{"kind":"interval","every":"24h"}','shared','custom body','default-heartbeat-2026-05-19')`.execute(db);
    await sql`INSERT INTO routines_v1_fires (agent_id,path,trigger_source,status,conversation_id) VALUES ('a','default:default-heartbeat-2026-05-19','tick','ok','existing-conversation')`.execute(db);
    await runRoutinesMigration(db);
    const rows = await sql<{ routine_id: string; revision: string }>`SELECT routine_id,revision FROM routines_v1_definitions`.execute(db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.routine_id).toBe('default:default-heartbeat-2026-05-19');
    expect(rows.rows[0]?.revision).not.toBe('initial');
    const jobs = (await sql`SELECT agent_id,routine_id,credential_ref,owner_user_id FROM routines_v1_credential_cleanup`.execute(db)).rows;
    expect(jobs).toEqual([{ agent_id: 'a', routine_id: 'three.md', credential_ref: 'routine:a:three.md:hmac', owner_user_id: 'owner' }]);
    expect((await sql`SELECT routine_id,conversation_id FROM routines_v1_fires ORDER BY id`.execute(db)).rows).toEqual([{ routine_id: 'default:skill-reflection', conversation_id: null }, { routine_id: 'default:deleted-catalog-entry', conversation_id: null }, { routine_id: 'default:default-heartbeat-2026-05-19', conversation_id: 'existing-conversation' }]);
    expect((await sql`SELECT prompt_body,enabled FROM default_routines_v1 WHERE name='heartbeat'`.execute(db)).rows).toEqual([{ prompt_body: 'custom body', enabled: true }]);
    expect((await sql`SELECT * FROM agent_default_routine_overrides_v1`.execute(db)).rows).toHaveLength(1);
    await sql`INSERT INTO routines_v1_definitions (agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,schedule_spec,webhook_spec,conversation,prompt_body) VALUES ('a','r_new','rev_new','owner','new','','hash','{"kind":"interval","every":"60s"}',NULL,'per-fire','new')`.execute(db);
    await runRoutinesMigration(db);
    expect((await sql`SELECT * FROM routines_v1_definitions`.execute(db)).rows).toHaveLength(2);
    expect(await columns('default_routines_v1')).not.toContain('source_md');
  });
  it('rolls retirement and schema changes back if DDL fails', async () => {
    await legacyMigration(db as never);
    await sql`INSERT INTO routines_v1_definitions(agent_id,path,owner_user_id,name,description,spec_hash,trigger_kind,trigger_spec,conversation,prompt_body) VALUES ('a','rollback.md','owner','rollback','','hash','interval','{"kind":"interval","every":"60s"}','per-fire','keep me')`.execute(db);
    await sql`CREATE FUNCTION block_routine_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN IF tg_tag = 'CREATE INDEX' THEN RAISE EXCEPTION 'injected DDL failure'; END IF; END $$; CREATE EVENT TRIGGER block_routine_ddl ON ddl_command_start EXECUTE FUNCTION block_routine_ddl()`.execute(db);
    try { await expect(runRoutinesMigration(db)).rejects.toThrow('injected DDL failure'); } finally { await sql`DROP EVENT TRIGGER block_routine_ddl`.execute(db); }
    expect(await columns('routines_v1_definitions')).toContain('path');
    expect((await sql`SELECT path FROM routines_v1_definitions`.execute(db)).rows).toEqual([{ path: 'rollback.md' }]);
    expect(await columns('default_routines_v1')).toContain('source_md');
  });
});
