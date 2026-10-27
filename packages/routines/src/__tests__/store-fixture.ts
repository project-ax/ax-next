import { beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { RoutineDefinitionSchema, RoutineUpsertDefaultInputSchema } from '@ax/routines-contract';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';
export function fixture(poolOptions: Pick<pg.PoolConfig, 'max' | 'connectionTimeoutMillis'> = {}) {
  let container: StartedPostgreSqlContainer;
  let db: Kysely<RoutinesDatabase>;
  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri(), ...poolOptions }) }) });
    await runRoutinesMigration(db);
  }, 120_000);
  beforeEach(async () => { await sql`TRUNCATE routines_v1_deliveries,routines_v1_retired_agents,routines_v1_definitions,routines_v1_fires,routines_v1_requests,routines_v1_dispatches,routines_v1_credential_cleanup,routines_v1_replies,agent_default_routine_overrides_v1`.execute(db); await sql`DELETE FROM default_routines_v1 WHERE name NOT IN ('heartbeat','skill-reflection')`.execute(db); });
  afterAll(async () => { await db?.destroy(); if (container) await stopPostgresContainer(container); }, 60_000);
  return { get db() { return db; }, get store() { return createRoutinesStore(db); } };
}
export const now = new Date('2031-01-01T00:00:00Z');
export function createInput(requestId = 'create-1') {
  return {
    agentId: 'a', actorUserId: 'editor', ownerUserId: 'owner', requestId, now,
    // Narrowed to a repeat routine: the default-routine upsert only accepts one.
    definition: { ...RoutineDefinitionSchema.parse({ name: 'Check in', promptBody: '  first line\n\nsecond line\n', trigger: { kind: 'interval', every: '60s' } }), kind: 'repeat' as const, goodWhen: null },
  };
}
export function webhookInput(requestId = 'hook-1') {
  return { ...createInput(requestId), definition: RoutineDefinitionSchema.parse({ name: 'hook', promptBody: 'body', trigger: { kind: 'webhook', path: '/hook', hmac: { header: 'x-signature', algorithm: 'sha256' } } }) };
}
/** The separate housekeeping catalog keeps its interval-only legacy DTO. */
export function defaultDefinition() {
  const { schedule, webhook: _webhook, ...fields } = createInput().definition;
  return RoutineUpsertDefaultInputSchema.parse({ ...fields, trigger: schedule });
}
