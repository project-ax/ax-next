import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createRoutinesPlugin } from '../plugin.js';
import type { RoutinesDatabase } from '../migrations.js';

pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function harness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const i = input as { agentId: string };
        return { agent: { id: i.agentId, ownerId: 'u1', workspaceRef: null } };
      },
      'conversations:find-or-create': async () => ({
        conversation: { conversationId: 'cnv_x' }, created: true,
      }),
      'conversations:create': async () => ({ conversationId: 'cnv_y' }),
      'conversations:drop-turn': async () => undefined,
      'conversations:hide': async () => undefined,
      'agent:invoke': async () => ({ kind: 'complete', messages: [] }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createRoutinesPlugin({ tickIntervalMs: 60_000 }),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('TRUNCATE routines_v1_definitions, routines_v1_fires');
  } finally {
    await cleanup.end();
  }
});

afterAll(async () => { if (container) await container.stop(); });

describe('routines:list', () => {
  it('returns rows in the mirror, filtered by agent', async () => {
    const h = await harness();
    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    await k.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md', author_user_id: 'u1',
      name: 'r', description: 'd', spec_hash: 'h',
      trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
      active_hours: null, silence_token: null, silence_max: 300,
      conversation: 'per-fire', prompt_body: '# x',
      next_run_at: new Date(),
    }).execute();
    await k.destroy();
    const out = await h.bus.call('routines:list', h.ctx({ userId: 'u1' }), { agentId: 'agt_a' });
    expect((out as { routines: unknown[] }).routines).toHaveLength(1);
  });
});

describe('routines:fire-now', () => {
  it('fires an existing routine and records a fires row', async () => {
    const h = await harness();
    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    await k.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md', author_user_id: 'u1',
      name: 'r', description: 'd', spec_hash: 'h',
      trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
      active_hours: null, silence_token: null, silence_max: 300,
      conversation: 'per-fire', prompt_body: '# x',
      next_run_at: new Date(),
    }).execute();
    const out = await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
      agentId: 'agt_a', path: '.ax/routines/r.md',
    });
    expect((out as { status: string }).status).toBe('ok');
    const fires = await k.selectFrom('routines_v1_fires').selectAll().execute();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.trigger_source).toBe('manual');
    await k.destroy();
  });

  it('throws not-found for an unknown routine', async () => {
    const h = await harness();
    await expect(
      h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
        agentId: 'agt_a', path: '.ax/routines/missing.md',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
