import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { HookBus, PluginError } from '@ax/core';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';
import { runTickOnce, type FireRoutineFn } from '../tick.js';
import { createFireRoutine, type PendingFires } from '../fire.js';

// Parse BIGINT as Number — matches sibling tests; BIGSERIAL returns strings
// by default and would otherwise produce surprising assertions.
pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runRoutinesMigration(db);
}, 120_000);

// Value of prompt_body on the migration-seeded heartbeat default. The
// admin-edit step (4) writes a different value to assert refresh.
const SEEDED_PROMPT_BODY =
  'If nothing is outstanding, respond with HEARTBEAT_OK and end.';

afterEach(async () => {
  // CASCADE on default_routines_v1 drops dependent per-agent rows via FK
  // ON DELETE CASCADE. Re-seed heartbeat so each test starts from the
  // post-migration baseline (matches store.test.ts pattern).
  await sql`TRUNCATE default_routines_v1 CASCADE`.execute(db);
  await sql`TRUNCATE routines_v1_definitions, routines_v1_fires`.execute(db);
  await sql`
    INSERT INTO default_routines_v1
      (default_routine_id, name, description, spec_hash, trigger_kind,
       trigger_spec, interval_seconds, silence_token, silence_max,
       conversation, prompt_body, source_md)
    VALUES
      ('default-heartbeat-2026-05-19', 'heartbeat',
       'Daily check-in: ask if anything is outstanding.',
       'seed-2026-05-19',
       'interval', ${'{"kind":"interval","every":"24h"}'}::jsonb, 86400,
       'HEARTBEAT_OK', 300, 'shared',
       ${SEEDED_PROMPT_BODY},
       'seed')
    ON CONFLICT (name) DO NOTHING
  `.execute(db);
});

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
}, 60_000);

describe('canary — defaults materialize → claim → fire → override → admin-edit (I-R8)', () => {
  it('drives all four state transitions end-to-end', async () => {
    const store = createRoutinesStore(db);
    const fireSpy = vi.fn<FireRoutineFn>(async () => ({
      status: 'ok', error: null, conversationId: null, renderedPrompt: 'p',
    }));

    // ----- (1) Materialize ------------------------------------------------
    // First tick: heartbeat default exists in default_routines_v1; no
    // per-agent row yet. runTickOnce should materialize one for agt_x.
    // It should NOT fire on this tick — the 24h interval starting from
    // the freshly-stamped created_at puts the next due time well in the
    // future.
    const t0 = new Date('2030-01-01T00:00:00Z');
    await runTickOnce({
      store, fire: fireSpy, now: t0,
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgents: async () => [{ agentId: 'agt_x', ownerUserId: 'u_test' }],
    });

    const materialized = await db
      .selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agt_x')
      .where('definition_id', 'is not', null)
      .execute();
    expect(materialized).toHaveLength(1);
    expect(materialized[0]!.path).toBe('default:default-heartbeat-2026-05-19');
    expect(materialized[0]!.next_run_at).toBeNull();
    expect(materialized[0]!.prompt_body).toBe(SEEDED_PROMPT_BODY);
    expect(fireSpy).not.toHaveBeenCalled();

    // ----- (2) Claim + fire -----------------------------------------------
    // Make the row eligible by rewinding created_at well past the
    // interval window. claim formula is COALESCE(last_run_at, created_at)
    // + interval_seconds <= now.
    await sql`
      UPDATE routines_v1_definitions
         SET created_at = ${new Date(t0.getTime() - 25 * 3600 * 1000)}
       WHERE agent_id = 'agt_x' AND definition_id IS NOT NULL
    `.execute(db);

    fireSpy.mockClear();
    await runTickOnce({
      store, fire: fireSpy, now: t0,
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgents: async () => [{ agentId: 'agt_x', ownerUserId: 'u_test' }],
    });

    expect(fireSpy).toHaveBeenCalledTimes(1);
    const firedRow = fireSpy.mock.calls[0]![0];
    expect(firedRow.agentId).toBe('agt_x');
    expect(firedRow.path).toBe('default:default-heartbeat-2026-05-19');
    expect(firedRow.name).toBe('heartbeat');
    expect(firedRow.promptBody).toBe(SEEDED_PROMPT_BODY);
    expect(firedRow.definitionId).toBe('default-heartbeat-2026-05-19');
    expect(fireSpy.mock.calls[0]![1]).toBe('tick');

    const fires = await db
      .selectFrom('routines_v1_fires')
      .selectAll()
      .where('agent_id', '=', 'agt_x')
      .execute();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.status).toBe('ok');
    expect(fires[0]!.path).toBe('default:default-heartbeat-2026-05-19');
    expect(fires[0]!.trigger_source).toBe('tick');

    // ----- (3) Override by workspace routine of same name ----------------
    // Insert a workspace routine with name='heartbeat' for the same
    // agent. Claim SQL excludes the default-sourced row when a same-name
    // workspace row exists for that agent, so only the workspace row
    // fires on the next tick.
    await store.upsert({
      agentId: 'agt_x',
      path: '.ax/routines/heartbeat.md',
      authorUserId: 'u_test',
      name: 'heartbeat',
      description: 'workspace override',
      specHash: 'ws-hash',
      trigger: { kind: 'interval', every: '24h' },
      activeHours: null,
      silenceToken: null,
      silenceMax: 300,
      conversation: 'per-fire',
      promptBody: 'WORKSPACE PROMPT',
      // Already due — workspace claim uses next_run_at <= now.
      nextRunAt: new Date(t0.getTime() - 1000),
    });

    // Make the default-sourced row "due" again too, so we can prove the
    // override predicate (NOT EXISTS workspace same-name) is what
    // suppresses it — not a missing eligibility.
    await sql`
      UPDATE routines_v1_definitions
         SET last_run_at = ${new Date(t0.getTime() - 25 * 3600 * 1000)},
             created_at = ${new Date(t0.getTime() - 25 * 3600 * 1000)}
       WHERE agent_id = 'agt_x' AND definition_id IS NOT NULL
    `.execute(db);

    fireSpy.mockClear();
    await runTickOnce({
      store, fire: fireSpy, now: t0,
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgents: async () => [{ agentId: 'agt_x', ownerUserId: 'u_test' }],
    });

    const firedPaths = fireSpy.mock.calls.map((c) => c[0].path);
    expect(firedPaths).toContain('.ax/routines/heartbeat.md');
    expect(firedPaths.some((p) => p.startsWith('default:'))).toBe(false);

    // ----- (4) Admin edit → refresh updates denormalized copy ------------
    // Drop the workspace override so the default-sourced row is no longer
    // shadowed. Bump default's prompt_body + updated_at; on the next
    // tick, refreshStale must propagate the new prompt to the per-agent
    // row BEFORE claim, and the spied fire call's row.promptBody must
    // reflect the new value.
    await db
      .deleteFrom('routines_v1_definitions')
      .where('path', '=', '.ax/routines/heartbeat.md')
      .execute();

    // Advance the wall clock 1 hour for the default's updated_at so it's
    // strictly LATER than the per-agent row's definition_updated_at
    // (which was set during materialize at t0). refreshStale's WHERE
    // clause is `r.definition_updated_at < d.updated_at`.
    const editTime = new Date(t0.getTime() + 3600 * 1000);
    await sql`
      UPDATE default_routines_v1
         SET prompt_body = 'EDITED PROMPT',
             updated_at = ${editTime}
       WHERE name = 'heartbeat'
    `.execute(db);

    // Rewind last_run_at/created_at again so the default-sourced row is
    // due. The previous (2) fire set last_run_at = t0; without rewinding
    // claim wouldn't pick it up.
    const t1 = new Date(t0.getTime() + 2 * 3600 * 1000);
    await sql`
      UPDATE routines_v1_definitions
         SET last_run_at = ${new Date(t1.getTime() - 25 * 3600 * 1000)},
             created_at = ${new Date(t1.getTime() - 25 * 3600 * 1000)}
       WHERE agent_id = 'agt_x' AND definition_id IS NOT NULL
    `.execute(db);

    fireSpy.mockClear();
    await runTickOnce({
      store, fire: fireSpy, now: t1,
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgents: async () => [{ agentId: 'agt_x', ownerUserId: 'u_test' }],
    });

    expect(fireSpy).toHaveBeenCalledTimes(1);
    const refreshedRow = fireSpy.mock.calls[0]![0];
    expect(refreshedRow.path).toBe('default:default-heartbeat-2026-05-19');
    expect(refreshedRow.promptBody).toBe('EDITED PROMPT');

    // And the denormalized copy on disk is also refreshed (not just the
    // in-memory row claimDue returned).
    const onDisk = await db
      .selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agt_x')
      .where('definition_id', 'is not', null)
      .executeTakeFirstOrThrow();
    expect(onDisk.prompt_body).toBe('EDITED PROMPT');
  });
});

// PR #105 regression: materialize previously hardcoded
// author_user_id='@ax/routines/defaults', and fire.ts:51 passes that to
// agents:resolve which rejects 'forbidden' (no concept of system actor).
// The PR #105 canary above mocks fire() with a spy, so the auth path
// was never exercised. This test wires a real HookBus with a stub
// agents:resolve that mimics the real ACL gate — passing materialize
// the per-agent owner makes the row's authorUserId resolvable, and
// the resulting fire records status='ok'.
describe('canary — default-sourced fire passes agents:resolve under real bus', () => {
  it('materialize writes per-agent owner; fire records ok, not forbidden', async () => {
    const store = createRoutinesStore(db);
    const bus = new HookBus();

    bus.registerService<{ agentId: string; userId: string }, { agent: unknown }>(
      'agents:resolve', '@ax/agents',
      async (_ctx, input) => {
        if (input.userId !== 'u_owner_of_agt_x') {
          throw new PluginError({
            code: 'forbidden',
            plugin: '@ax/agents',
            hookName: 'agents:resolve',
            message: `agent '${input.agentId}' not accessible to user '${input.userId}'`,
          });
        }
        return {
          agent: {
            id: input.agentId,
            ownerId: 'u_owner_of_agt_x',
            workspaceRef: null,
          },
        };
      },
    );
    bus.registerService<unknown, { conversation: { conversationId: string }; created: boolean }>(
      'conversations:find-or-create', '@ax/conversations',
      async () => ({ conversation: { conversationId: 'conv-real-bus' }, created: true }),
    );
    bus.registerService<unknown, unknown>('agent:invoke', '@ax/orchestrator', async () => ({}));

    const pending: PendingFires = new Map();
    const fire = createFireRoutine({ bus, pending });

    const t0 = new Date('2030-01-01T00:00:00Z');

    // 1) Materialize with the agent's real owner via the new
    // getAgents callback. The fix is: the materialize SQL writes
    // a.owner_user_id (not the literal '@ax/routines/defaults').
    await runTickOnce({
      store, fire, now: t0,
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgents: async () => [{ agentId: 'agt_x', ownerUserId: 'u_owner_of_agt_x' }],
    });

    const materialized = await db
      .selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agt_x')
      .where('definition_id', 'is not', null)
      .executeTakeFirstOrThrow();
    expect(materialized.author_user_id).toBe('u_owner_of_agt_x');

    // 2) Make the row due, then tick again to drive a real fire.
    await sql`
      UPDATE routines_v1_definitions
         SET created_at = ${new Date(t0.getTime() - 25 * 3600 * 1000)}
       WHERE agent_id = 'agt_x' AND definition_id IS NOT NULL
    `.execute(db);

    await runTickOnce({
      store, fire, now: t0,
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgents: async () => [{ agentId: 'agt_x', ownerUserId: 'u_owner_of_agt_x' }],
    });

    // 3) The fire row must record status='ok' with no error. On the
    // buggy main, fire.ts would catch the forbidden PluginError and
    // return status='error' with error='forbidden: agent ...'.
    const fires = await db
      .selectFrom('routines_v1_fires')
      .selectAll()
      .where('agent_id', '=', 'agt_x')
      .execute();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.status).toBe('ok');
    expect(fires[0]!.error).toBeNull();
  });

  it('materializeMissing on the store writes a.owner_user_id per row', async () => {
    // Store-level coverage for the same regression: two agents, two
    // owners, one row each — author_user_id matches each agent's owner.
    const store = createRoutinesStore(db);
    await store.materializeMissing({
      agents: [
        { agentId: 'agt_alice', ownerUserId: 'u_alice' },
        { agentId: 'agt_bob', ownerUserId: 'u_bob' },
      ],
      now: new Date(),
    });
    const rows = await db
      .selectFrom('routines_v1_definitions')
      .selectAll()
      .where('definition_id', 'is not', null)
      .execute();
    const byAgent = new Map(rows.map((r) => [r.agent_id, r.author_user_id]));
    expect(byAgent.get('agt_alice')).toBe('u_alice');
    expect(byAgent.get('agt_bob')).toBe('u_bob');
  });
});

