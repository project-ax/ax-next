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
    // Tests that don't boot a harness (e.g. pure manifest assertions)
    // leave the tables un-created. Guard with to_regclass so the truncate
    // is a no-op in that case instead of throwing "relation does not exist".
    await cleanup.query(`
      DO $$ BEGIN
        IF to_regclass('public.routines_v1_definitions') IS NOT NULL
           AND to_regclass('public.routines_v1_fires') IS NOT NULL
           AND to_regclass('public.default_routines_v1') IS NOT NULL THEN
          TRUNCATE routines_v1_definitions, routines_v1_fires, default_routines_v1;
        END IF;
      END $$;
    `);
  } finally {
    await cleanup.end();
  }
});

afterAll(async () => { if (container) await container.stop(); }, 60_000);

// Minimal valid interval-trigger routine markdown.
function intervalMd(name: string, description: string, every = '60s'): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'trigger:',
    '  kind: interval',
    `  every: "${every}"`,
    'conversation: per-fire',
    '---',
    'do the thing',
    '',
  ].join('\n');
}

function webhookMd(): string {
  return [
    '---',
    'name: hook',
    'description: webhook routine',
    'trigger:',
    '  kind: webhook',
    '  path: /api/hook',
    'conversation: per-fire',
    '---',
    'on webhook',
    '',
  ].join('\n');
}

function cronMd(): string {
  return [
    '---',
    'name: nightly',
    'description: cron routine',
    'trigger:',
    '  kind: cron',
    '  expr: "0 0 * * *"',
    '  tz: UTC',
    'conversation: per-fire',
    '---',
    'every midnight',
    '',
  ].join('\n');
}

describe('routines plugin manifest', () => {
  it('manifest.registers includes the four default-routine hooks', () => {
    const p = createRoutinesPlugin();
    expect(p.manifest.registers).toContain('routines:list-defaults');
    expect(p.manifest.registers).toContain('routines:get-default');
    expect(p.manifest.registers).toContain('routines:upsert-default');
    expect(p.manifest.registers).toContain('routines:delete-default');
  });
});

describe('routines:list-defaults', () => {
  it('returns the seeded heartbeat default', async () => {
    const h = await harness();
    const out = await h.bus.call(
      'routines:list-defaults', h.ctx({ userId: 'u1' }), {},
    );
    const defaults = (out as { defaults: Array<{ name: string }> }).defaults;
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults.find((d) => d.name === 'heartbeat')).toBeDefined();
  });
});

describe('routines:upsert-default', () => {
  it('with interval trigger persists and shows up in list', async () => {
    const h = await harness();
    const out = await h.bus.call(
      'routines:upsert-default', h.ctx({ userId: 'u1' }),
      { sourceMd: intervalMd('demo', 'demo routine', '5m') },
    );
    const r = out as { defaultRoutineId: string; created: boolean };
    expect(r.created).toBe(true);
    expect(r.defaultRoutineId).toMatch(/^default-demo-/);

    const listed = await h.bus.call(
      'routines:list-defaults', h.ctx({ userId: 'u1' }), {},
    );
    const defaults = (listed as { defaults: Array<{ name: string }> }).defaults;
    expect(defaults.find((d) => d.name === 'demo')).toBeDefined();
  });

  it('rejects webhook trigger with code default-trigger-webhook-not-supported', async () => {
    const h = await harness();
    await expect(
      h.bus.call(
        'routines:upsert-default', h.ctx({ userId: 'u1' }),
        { sourceMd: webhookMd() },
      ),
    ).rejects.toMatchObject({ code: 'default-trigger-webhook-not-supported' });
  });

  it('rejects cron trigger with code default-trigger-cron-not-supported (v1 interval-only)', async () => {
    const h = await harness();
    await expect(
      h.bus.call(
        'routines:upsert-default', h.ctx({ userId: 'u1' }),
        { sourceMd: cronMd() },
      ),
    ).rejects.toMatchObject({ code: 'default-trigger-cron-not-supported' });
  });

  it('rejects invalid md with code invalid-routine-md', async () => {
    const h = await harness();
    await expect(
      h.bus.call(
        'routines:upsert-default', h.ctx({ userId: 'u1' }),
        { sourceMd: '# not a frontmatter file\n' },
      ),
    ).rejects.toMatchObject({ code: 'invalid-routine-md' });
  });
});

describe('routines:get-default', () => {
  it('returns the row when present', async () => {
    const h = await harness();
    // Find the seeded heartbeat to get a real defaultRoutineId.
    const listed = await h.bus.call(
      'routines:list-defaults', h.ctx({ userId: 'u1' }), {},
    );
    const defaults = (listed as { defaults: Array<{ name: string; defaultRoutineId: string }> }).defaults;
    const hb = defaults.find((d) => d.name === 'heartbeat');
    expect(hb).toBeDefined();
    const out = await h.bus.call(
      'routines:get-default', h.ctx({ userId: 'u1' }),
      { defaultRoutineId: hb!.defaultRoutineId },
    );
    const detail = out as { name: string; sourceMd: string };
    expect(detail.name).toBe('heartbeat');
    expect(typeof detail.sourceMd).toBe('string');
    expect(detail.sourceMd.length).toBeGreaterThan(0);
  });

  it('throws not-found for an unknown id', async () => {
    const h = await harness();
    await expect(
      h.bus.call(
        'routines:get-default', h.ctx({ userId: 'u1' }),
        { defaultRoutineId: 'does-not-exist' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('routines:delete-default', () => {
  it('cascades to per-agent rows', async () => {
    const h = await harness();
    // 1) upsert a default
    const upserted = await h.bus.call(
      'routines:upsert-default', h.ctx({ userId: 'u1' }),
      { sourceMd: intervalMd('cascade', 'cascade target', '60s') },
    );
    const defaultRoutineId = (upserted as { defaultRoutineId: string }).defaultRoutineId;

    // 2) materialize a per-agent row by inserting via SQL (cheaper than
    //    waiting for the tick loop).
    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    try {
      await k.insertInto('routines_v1_definitions').values({
        agent_id: 'agt_cascade', path: `default:${defaultRoutineId}`,
        author_user_id: '@ax/routines/defaults',
        name: 'cascade', description: 'cascade target',
        spec_hash: 'h', trigger_kind: 'interval',
        trigger_spec: { kind: 'interval', every: '60s' },
        active_hours: null, silence_token: null, silence_max: 300,
        conversation: 'per-fire', prompt_body: 'do the thing',
        next_run_at: null, definition_id: defaultRoutineId,
        definition_updated_at: new Date(),
      }).execute();

      const before = await k.selectFrom('routines_v1_definitions')
        .selectAll().where('definition_id', '=', defaultRoutineId).execute();
      expect(before).toHaveLength(1);

      // 3) delete the default → FK ON DELETE CASCADE drops the per-agent row.
      await h.bus.call(
        'routines:delete-default', h.ctx({ userId: 'u1' }),
        { defaultRoutineId },
      );

      const after = await k.selectFrom('routines_v1_definitions')
        .selectAll().where('definition_id', '=', defaultRoutineId).execute();
      expect(after).toHaveLength(0);

      const defaults = await k.selectFrom('default_routines_v1')
        .selectAll().where('default_routine_id', '=', defaultRoutineId).execute();
      expect(defaults).toHaveLength(0);
    } finally {
      await k.destroy();
    }
  });
});
