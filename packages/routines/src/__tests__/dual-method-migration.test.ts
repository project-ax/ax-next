import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';

const frozenSql = readFileSync(new URL('./fixtures/schema-v14.sql', import.meta.url), 'utf8');
const frozen = JSON.parse(readFileSync(new URL('./fixtures/schema-v14-operations.json', import.meta.url), 'utf8'));
let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;
const jsonValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }) });
}, 120_000);
afterAll(async () => {
  await db?.destroy();
  if (container) await stopPostgresContainer(container);
}, 60_000);
beforeEach(async () => {
  await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public`.execute(db);
  // Historical SQL came from the actual v14 binary, not today's migration helper.
  await db.executeQuery(CompiledQuery.raw(frozenSql));
  // A legacy materialization has the catalog's source identity and its interval fields.
  await sql`INSERT INTO routines_v1_definitions (
    agent_id,routine_id,revision,owner_user_id,name,description,spec_hash,
    trigger_kind,trigger_spec,interval_seconds,active_hours,silence_token,silence_max,
    conversation,prompt_body,enabled,definition_id,definition_updated_at,next_run_at
  ) SELECT 'fixture-agent','fixture-default-heartbeat','fixture-default-revision','fixture-owner',
    name,description,spec_hash,trigger_kind,trigger_spec,interval_seconds,active_hours,
    silence_token,silence_max,conversation,prompt_body,enabled,default_routine_id,updated_at,
    '2031-01-02T00:00:00Z'::timestamptz
    FROM default_routines_v1 WHERE name='heartbeat'`.execute(db);
});

describe('independent-method migration from a genuine v14 database', () => {
  it('replaces exclusive authored columns while preserving every legacy method and identity', async () => {
    await runRoutinesMigration(db);
    const columns = (await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_name='routines_v1_definitions' AND table_schema=current_schema()`.execute(db)).rows.map(row => row.column_name);
    expect(columns).toEqual(expect.arrayContaining(['schedule_spec', 'webhook_spec']));
    expect(columns).not.toContain('trigger_kind');
    expect(columns).not.toContain('trigger_spec');
    const store = createRoutinesStore(db);
    for (const old of frozen.definitions) {
      const row = await store.findOne({ agentId: old.agent_id, routineId: old.routine_id });
      expect(row).toMatchObject({
        agentId: old.agent_id, routineId: old.routine_id, revision: old.revision,
        ownerUserId: old.owner_user_id, name: old.name,
        schedule: old.trigger_kind === 'webhook' ? null : old.trigger_spec,
        webhook: old.trigger_kind === 'webhook' ? old.trigger_spec : null,
      });
      expect(row).not.toHaveProperty('trigger');
      expect(row?.nextRunAt?.toISOString() ?? null).toBe(old.next_run_at);
    }
    const defaults = await db.selectFrom('default_routines_v1').selectAll().orderBy('name').execute();
    expect(jsonValue(defaults)).toEqual(frozen.defaults);
    expect(await store.findOne({ agentId: 'fixture-agent', routineId: 'fixture-default-heartbeat' })).toMatchObject({
      definitionId: 'default-heartbeat-2026-05-19',
      schedule: { kind: 'interval', every: '24h' }, webhook: null,
      nextRunAt: new Date('2031-01-02T00:00:00Z'),
    });
  });

  it('keeps old request hashes and rehydrates create/update/dispatch results as canonical data', async () => {
    await runRoutinesMigration(db);
    const store = createRoutinesStore(db);
    const receipts = await db.selectFrom('routines_v1_requests').selectAll().orderBy('operation').orderBy('request_id').execute();
    expect(receipts).toHaveLength(frozen.receipts.length);
    for (const old of frozen.receipts) {
      const receipt = receipts.find(row => row.operation === old.operation && row.request_id === old.request_id);
      expect(receipt?.input_hash).toBe(old.input_hash);
      const replay = await store.findOperationReceipt({
        agentId: old.agent_id, actorUserId: old.owner_user_id,
        operation: old.operation, requestId: old.request_id, inputHash: old.input_hash,
      });
      const previous = old.operation === 'dispatch' ? old.result.row : old.result;
      const canonical = old.operation === 'dispatch' ? (replay as { row: unknown }).row : replay;
      expect(canonical).toMatchObject({
        routineId: previous.routineId, revision: previous.revision,
        schedule: previous.trigger.kind === 'webhook' ? null : previous.trigger,
        webhook: previous.trigger.kind === 'webhook' ? previous.trigger : null,
      });
      expect(canonical).not.toHaveProperty('trigger');
    }
  });

  it('runs twice without rewriting definitions, catalog defaults, request receipts or accepted dispatches', async () => {
    await runRoutinesMigration(db);
    const snapshot = async () => ({
      definitions: await db.selectFrom('routines_v1_definitions').selectAll().orderBy('routine_id').execute(),
      defaults: await db.selectFrom('default_routines_v1').selectAll().orderBy('name').execute(),
      requests: await db.selectFrom('routines_v1_requests').selectAll().orderBy('operation').orderBy('request_id').execute(),
      dispatches: await db.selectFrom('routines_v1_dispatches').selectAll().orderBy('dispatch_id').execute(),
      versions: (await sql`SELECT version, completed_at FROM routines_schema_versions ORDER BY version`.execute(db)).rows,
    });
    const before = await snapshot();
    expect(before.versions.map(row => (row as { version: number }).version)).toEqual(expect.arrayContaining(frozen.versions));
    expect(Math.max(...before.versions.map(row => (row as { version: number }).version))).toBeGreaterThan(14);
    await runRoutinesMigration(db);
    expect(await snapshot()).toEqual(before);
  });
});
