import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createRoutinesPlugin } from '../plugin.js';
import type { RoutinesDatabase } from '../migrations.js';
import type { RoutinesConfig } from '../types.js';
import { createRoutinesStore } from '../store.js';
import { SKILL_REFLECTION_ROUTINE_NAME } from '../index.js';

pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function harness(config: RoutinesConfig = {}): Promise<TestHarness> {
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
      createRoutinesPlugin({ tickIntervalMs: 60_000, ...config }),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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
    // agent_default_routine_overrides_v1 FK-references default_routines_v1,
    // so it must be truncated in the same TRUNCATE statement (Postgres
    // refuses to truncate a table referenced by an FK unless the referencing
    // table is truncated together).
    await cleanup.query(`
      DO $$ BEGIN
        IF to_regclass('public.routines_v1_definitions') IS NOT NULL
           AND to_regclass('public.routines_v1_fires') IS NOT NULL
           AND to_regclass('public.default_routines_v1') IS NOT NULL
           AND to_regclass('public.agent_default_routine_overrides_v1') IS NOT NULL THEN
          TRUNCATE routines_v1_definitions, routines_v1_fires, default_routines_v1, agent_default_routine_overrides_v1;
        END IF;
      END $$;
    `);
  } finally {
    await cleanup.end();
  }
});

afterAll(async () => { if (container) await stopPostgresContainer(container); }, 60_000);

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

  it('manifest.registers includes the per-agent default-override hooks (TASK-177)', () => {
    const p = createRoutinesPlugin();
    expect(p.manifest.registers).toContain('routines:set-agent-default-enabled');
    expect(p.manifest.registers).toContain('routines:list-agent-defaults');
  });

  it('manifest.calls includes agents:resolve (owner ACL for the override hooks)', () => {
    const p = createRoutinesPlugin();
    expect(p.manifest.calls).toContain('agents:resolve');
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

  it('flips the seeded skill-reflection global kill-switch on/off via the enabled flag (TASK-183)', async () => {
    const h = await harness();

    const enabledOf = async (name: string): Promise<boolean> => {
      const listed = await h.bus.call(
        'routines:list-defaults', h.ctx({ userId: 'u1' }), {},
      );
      const defaults = (listed as { defaults: Array<{ name: string; enabled: boolean }> }).defaults;
      const row = defaults.find((d) => d.name === name);
      expect(row).toBeDefined();
      return row!.enabled;
    };

    // The migration seeds skill-reflection with the global kill-switch OFF.
    expect(await enabledOf('skill-reflection')).toBe(false);

    const md = intervalMd('skill-reflection', 'skill-reflection routine', '24h');

    // 1) A plain spec re-upsert (no `enabled`) must NOT touch the global flag —
    //    otherwise every spec edit would silently re-enable a default that an
    //    operator deliberately left off.
    const noFlag = await h.bus.call(
      'routines:upsert-default', h.ctx({ userId: 'u1' }), { sourceMd: md },
    );
    // ON CONFLICT (name) → updates the seeded row, so created is false.
    expect((noFlag as { created: boolean }).created).toBe(false);
    expect(await enabledOf('skill-reflection')).toBe(false);

    // 2) upsert-default with enabled:true flips the kill-switch ON.
    await h.bus.call(
      'routines:upsert-default', h.ctx({ userId: 'u1' }),
      { sourceMd: md, enabled: true },
    );
    expect(await enabledOf('skill-reflection')).toBe(true);

    // 3) upsert-default with enabled:false flips it back OFF (true↔false).
    await h.bus.call(
      'routines:upsert-default', h.ctx({ userId: 'u1' }),
      { sourceMd: md, enabled: false },
    );
    expect(await enabledOf('skill-reflection')).toBe(false);
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
        owner_user_id: '@ax/routines/defaults',
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

// TASK-609: the facts-memory preset boots @ax/routines with
// `forceDisabledDefaults: ['skill-reflection']` — reflection's recurrence gate
// reads memory only Strata wrote (deleted in TASK-608), so it stays OFF there
// until TASK-611. A caller that passes nothing (`presets/k8s` still does) must
// behave exactly as before.
describe('forceDisabledDefaults (TASK-609)', () => {
  const FORCED: RoutinesConfig = { forceDisabledDefaults: [SKILL_REFLECTION_ROUTINE_NAME] };

  function kysely(): Kysely<RoutinesDatabase> {
    return new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
  }

  async function reboot(config: RoutinesConfig = {}): Promise<TestHarness> {
    while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
    return harness(config);
  }

  async function flagOf(k: Kysely<RoutinesDatabase>, name: string): Promise<boolean> {
    const row = await k.selectFrom('default_routines_v1')
      .select(['enabled']).where('name', '=', name).executeTakeFirstOrThrow();
    return row.enabled;
  }

  async function agentsWith(k: Kysely<RoutinesDatabase>, name: string): Promise<string[]> {
    const rows = await k.selectFrom('routines_v1_definitions')
      .select(['agent_id'])
      .where('definition_id', 'is not', null)
      .where('name', '=', name)
      .orderBy('agent_id')
      .execute();
    return rows.map((r) => r.agent_id);
  }

  /** A deployment that already turned reflection ON and materialized it. */
  async function seedReflectionOn(k: Kysely<RoutinesDatabase>): Promise<void> {
    await harness();
    await k.updateTable('default_routines_v1')
      .set({ enabled: true }).where('name', '=', SKILL_REFLECTION_ROUTINE_NAME).execute();
    await createRoutinesStore(k).materializeMissing({
      agents: [
        { agentId: 'agt_1', ownerUserId: 'u1' },
        { agentId: 'agt_2', ownerUserId: 'u2' },
      ],
      now: new Date(),
    });
    expect(await agentsWith(k, SKILL_REFLECTION_ROUTINE_NAME)).toEqual(['agt_1', 'agt_2']);
    expect(await agentsWith(k, 'heartbeat')).toEqual(['agt_1', 'agt_2']);
  }

  it('turns an already-ON, already-materialized skill-reflection off at boot, leaves heartbeat alone, and is a no-op on re-run', async () => {
    const k = kysely();
    try {
      await seedReflectionOn(k);

      await reboot(FORCED);
      expect(await flagOf(k, SKILL_REFLECTION_ROUTINE_NAME)).toBe(false);
      expect(await agentsWith(k, SKILL_REFLECTION_ROUTINE_NAME)).toEqual([]);
      expect(await flagOf(k, 'heartbeat')).toBe(true);
      expect(await agentsWith(k, 'heartbeat')).toEqual(['agt_1', 'agt_2']);

      const heartbeatBefore = await k.selectFrom('default_routines_v1')
        .selectAll().where('name', '=', 'heartbeat').executeTakeFirstOrThrow();

      // Idempotent: a second boot finds nothing to change.
      await reboot(FORCED);
      expect(await flagOf(k, SKILL_REFLECTION_ROUTINE_NAME)).toBe(false);
      expect(await agentsWith(k, SKILL_REFLECTION_ROUTINE_NAME)).toEqual([]);
      expect(await agentsWith(k, 'heartbeat')).toEqual(['agt_1', 'agt_2']);
      const heartbeatAfter = await k.selectFrom('default_routines_v1')
        .selectAll().where('name', '=', 'heartbeat').executeTakeFirstOrThrow();
      expect(heartbeatAfter).toEqual(heartbeatBefore);

      // A new agent gets heartbeat, never reflection.
      await createRoutinesStore(k).materializeMissing({
        agents: [{ agentId: 'agt_3', ownerUserId: 'u3' }],
        now: new Date(),
      });
      expect(await agentsWith(k, 'heartbeat')).toEqual(['agt_1', 'agt_2', 'agt_3']);
      expect(await agentsWith(k, SKILL_REFLECTION_ROUTINE_NAME)).toEqual([]);
    } finally {
      await k.destroy();
    }
  });

  it('without the option (as presets/k8s passes it) an ON skill-reflection and its rows survive a boot', async () => {
    const k = kysely();
    try {
      await seedReflectionOn(k);
      await reboot();
      expect(await flagOf(k, SKILL_REFLECTION_ROUTINE_NAME)).toBe(true);
      expect(await agentsWith(k, SKILL_REFLECTION_ROUTINE_NAME)).toEqual(['agt_1', 'agt_2']);
    } finally {
      await k.destroy();
    }
  });

  it('refuses to turn a forced-off default back on, and a re-created one lands off', async () => {
    const h = await harness(FORCED);
    const md = intervalMd(SKILL_REFLECTION_ROUTINE_NAME, 'skill-reflection routine', '24h');
    await expect(
      h.bus.call('routines:upsert-default', h.ctx({ userId: 'u1' }), { sourceMd: md, enabled: true }),
    ).rejects.toMatchObject({ code: 'default-disabled-by-deployment' });

    const k = kysely();
    try {
      expect(await flagOf(k, SKILL_REFLECTION_ROUTINE_NAME)).toBe(false);
      // delete-default, then a plain spec upsert would INSERT with enabled
      // defaulting to true — a forced name must still land OFF.
      await h.bus.call('routines:delete-default', h.ctx({ userId: 'u1' }), {
        defaultRoutineId: SKILL_REFLECTION_ROUTINE_NAME,
      });
      await h.bus.call('routines:upsert-default', h.ctx({ userId: 'u1' }), { sourceMd: md });
      expect(await flagOf(k, SKILL_REFLECTION_ROUTINE_NAME)).toBe(false);

      // Other defaults are not affected by the option.
      await h.bus.call('routines:upsert-default', h.ctx({ userId: 'u1' }), {
        sourceMd: intervalMd('demo', 'demo routine', '5m'),
        enabled: true,
      });
      expect(await flagOf(k, 'demo')).toBe(true);
    } finally {
      await k.destroy();
    }
  });
});
