import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { createRoutinesPlugin } from '../plugin.js';
import type { RoutinesDatabase } from '../migrations.js';

pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

// Ownership map for the auth-scoping tests: agentId -> owner userId.
// agents:resolve throws 'forbidden' for a non-owner, matching the real
// @ax/agents ACL gate (resolveAgent in packages/agents/src/plugin.ts).
const AGENT_OWNERS: Record<string, string> = { 'agt_a': 'u1', 'agt_owned': 'owner-1' };

async function harness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const i = input as { agentId: string; userId: string };
        const owner = AGENT_OWNERS[i.agentId] ?? 'u1';
        if (i.userId !== owner) {
          throw new PluginError({
            code: 'forbidden', plugin: '@ax/agents', hookName: 'agents:resolve',
            message: `agent '${i.agentId}' not accessible to user '${i.userId}'`,
          });
        }
        return { agent: { id: i.agentId, ownerId: owner, workspaceRef: null } };
      },
      'agents:ensure-webhook-token': async (_ctx, input: unknown) => {
        const i = input as { agentId: string };
        return { token: `tok-${i.agentId}` };
      },
      'agents:resolve-by-webhook-token': async () => ({ agent: null }),
      'agents:list-personal-owners': async () => ({ agents: [] }),
      'conversations:find-or-create': async () => ({
        conversation: { conversationId: 'cnv_x' }, created: true,
      }),
      'conversations:create': async () => ({ conversationId: 'cnv_y' }),
      'conversations:drop-turn': async () => undefined,
      'conversations:hide': async () => undefined,
      'agent:invoke': async () => ({ kind: 'complete', messages: [] }),
      'credentials:get': async () => 'secret',
      'http:register-route': async () => ({ unregister: () => {} }),
      'workspace:apply': async () => ({
        version: 'v1',
        delta: { before: null, after: 'v1', changes: [] },
      }),
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
    await cleanup.query(
      'TRUNCATE routines_v1_definitions, routines_v1_fires, agent_default_routine_overrides_v1',
    );
  } finally {
    await cleanup.end();
  }
});

afterAll(async () => { if (container) await stopPostgresContainer(container); }, 60_000);

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
    // Seed next_run_at far in the future so the harness's tick loop
    // can't race fire-now. fire-now ignores next_run_at; tick honors it.
    await k.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md', author_user_id: 'u1',
      name: 'r', description: 'd', spec_hash: 'h',
      trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
      active_hours: null, silence_token: null, silence_max: 300,
      conversation: 'per-fire', prompt_body: '# x',
      next_run_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
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

const HEARTBEAT_ID = 'default-heartbeat-2026-05-19';

describe('routines:list-agent-defaults', () => {
  it('reports the seeded default as enabled by default (absence = enabled)', async () => {
    const h = await harness();
    const out = await h.bus.call('routines:list-agent-defaults', h.ctx({ userId: 'owner-1' }), {
      agentId: 'agt_owned',
    });
    const defaults = (out as { defaults: Array<{ defaultRoutineId: string; name: string; enabled: boolean }> }).defaults;
    const hb = defaults.find((d) => d.defaultRoutineId === HEARTBEAT_ID);
    expect(hb).toBeDefined();
    expect(hb!.name).toBe('heartbeat');
    expect(hb!.enabled).toBe(true);
  });

  it('is owner-scoped — a non-owner is forbidden', async () => {
    const h = await harness();
    await expect(
      h.bus.call('routines:list-agent-defaults', h.ctx({ userId: 'intruder' }), {
        agentId: 'agt_owned',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('routines:set-agent-default-enabled', () => {
  it('is owner-scoped — a non-owner cannot toggle', async () => {
    const h = await harness();
    await expect(
      h.bus.call('routines:set-agent-default-enabled', h.ctx({ userId: 'intruder' }), {
        agentId: 'agt_owned', defaultRoutineId: HEARTBEAT_ID, enabled: false,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('disable de-materializes; list reflects it; re-enable re-materializes', async () => {
    const h = await harness();
    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });

    // Pre-materialize the heartbeat for this agent so disable has a row to drop.
    await k.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_owned', path: `default:${HEARTBEAT_ID}`, author_user_id: 'owner-1',
      name: 'heartbeat', description: 'd', spec_hash: 'seed-2026-05-19',
      trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '24h' },
      active_hours: null, silence_token: 'HEARTBEAT_OK', silence_max: 300,
      conversation: 'shared', prompt_body: 'p', next_run_at: null,
      definition_id: HEARTBEAT_ID, definition_updated_at: new Date(),
    }).execute();

    // Disable.
    await h.bus.call('routines:set-agent-default-enabled', h.ctx({ userId: 'owner-1' }), {
      agentId: 'agt_owned', defaultRoutineId: HEARTBEAT_ID, enabled: false,
    });
    const afterDisable = await k.selectFrom('routines_v1_definitions').selectAll()
      .where('agent_id', '=', 'agt_owned').where('definition_id', '=', HEARTBEAT_ID).execute();
    expect(afterDisable).toHaveLength(0);

    const listDisabled = await h.bus.call('routines:list-agent-defaults', h.ctx({ userId: 'owner-1' }), {
      agentId: 'agt_owned',
    });
    const hbDisabled = (listDisabled as { defaults: Array<{ defaultRoutineId: string; enabled: boolean }> })
      .defaults.find((d) => d.defaultRoutineId === HEARTBEAT_ID);
    expect(hbDisabled!.enabled).toBe(false);

    // Re-enable: the hook calls materializeMissing, which re-creates the row.
    await h.bus.call('routines:set-agent-default-enabled', h.ctx({ userId: 'owner-1' }), {
      agentId: 'agt_owned', defaultRoutineId: HEARTBEAT_ID, enabled: true,
    });
    const afterReEnable = await k.selectFrom('routines_v1_definitions').selectAll()
      .where('agent_id', '=', 'agt_owned').where('definition_id', '=', HEARTBEAT_ID).execute();
    expect(afterReEnable).toHaveLength(1);
    expect(afterReEnable[0]!.author_user_id).toBe('owner-1');

    const listEnabled = await h.bus.call('routines:list-agent-defaults', h.ctx({ userId: 'owner-1' }), {
      agentId: 'agt_owned',
    });
    const hbEnabled = (listEnabled as { defaults: Array<{ defaultRoutineId: string; enabled: boolean }> })
      .defaults.find((d) => d.defaultRoutineId === HEARTBEAT_ID);
    expect(hbEnabled!.enabled).toBe(true);

    await k.destroy();
  });

  it('throws not-found for an unknown default', async () => {
    const h = await harness();
    await expect(
      h.bus.call('routines:set-agent-default-enabled', h.ctx({ userId: 'owner-1' }), {
        agentId: 'agt_owned', defaultRoutineId: 'no-such-default', enabled: false,
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
