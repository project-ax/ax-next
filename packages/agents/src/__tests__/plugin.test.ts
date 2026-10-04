import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { createAgentsPlugin } from '../plugin.js';
import type {
  AgentInput,
  AgentsConfig,
  AgentsCreatedEvent,
  AgentsDeletedEvent,
  CreateInput,
  CreateOutput,
  DeleteInput,
  ListForUserInput,
  ListForUserOutput,
  ResolveInput,
  ResolveOutput,
  UpdateInput,
  UpdateOutput,
  AttachConnectorInput,
  AttachConnectorOutput,
  DetachConnectorInput,
  DetachConnectorOutput,
  CanManageConnectorsInput,
  CanManageConnectorsOutput,
  CanSetSharedCredentialInput,
  CanSetSharedCredentialOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(extras: {
  withTeams?: 'always-member' | 'never-member' | null;
  extraServices?: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>>;
  config?: AgentsConfig;
} = {}): Promise<TestHarness> {
  // The agents plugin declares `calls: ['database:get-instance',
  // 'http:register-route', 'auth:require-user']`. The bus tests below don't
  // exercise the HTTP surface — admin-routes.test.ts does that against a
  // real http-server. Stub the two HTTP-side calls so verifyCalls passes
  // and the plugin's init can register its admin routes against the no-op
  // mock without booting a TCP listener.
  const services: Record<
    string,
    (ctx: unknown, input: unknown) => Promise<unknown>
  > = {
    'http:register-route': async () => ({ unregister: () => {} }),
    'auth:require-user': async () => {
      // Tests that drive the bus directly never hit /admin/agents — this
      // mock is never exercised. Throw so a future test that DID call
      // through this stub catches the omission early.
      throw new Error(
        'auth:require-user mock not configured for plugin.test.ts',
      );
    },
    ...extras.extraServices,
  };
  if (extras.withTeams === 'always-member') {
    services['teams:is-member'] = async () => ({ member: true });
  } else if (extras.withTeams === 'never-member') {
    services['teams:is-member'] = async () => ({ member: false });
  }
  const h = await createTestHarness({
    services,
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createAgentsPlugin(extras.config),
    ],
  });
  harnesses.push(h);
  return h;
}

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    displayName: 'My Agent',
    allowedTools: ['bash.run'],
    mcpConfigIds: [],
    model: 'anthropic/claude-opus-4-7',
    visibility: 'personal',
    ...overrides,
  };
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // Drop the table between tests to keep cases isolated.
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/agents plugin manifest + lifecycle', () => {
  it('manifest matches the documented surface', async () => {
    // Construct without booting so we can inspect the manifest directly —
    // boot would require a live postgres which is fine here, but the
    // assertion is a static-shape one.
    const plugin = createAgentsPlugin();
    expect(plugin.manifest).toEqual({
      name: '@ax/agents',
      version: '0.0.0',
      registers: [
        'agents:resolve',
        'agents:list-for-user',
        'agents:create',
        'agents:update',
        'agents:delete',
        'agents:resolve-by-webhook-token',
        'agents:rotate-webhook-token',
        'agents:ensure-webhook-token',
        'agents:any-attached-to-skill',
        'agents:set-skill-attachments',
        'agents:attach-connector',
        'agents:detach-connector',
        'agents:can-manage-connectors',
        'agents:can-set-shared-credential',
        'agents:list-ids',
        'agents:list-personal-owners',
        'agents:list-authored-skills',
        'agents:resolve-authored-skills',
      ],
      // database:get-instance + http:register-route + auth:require-user are
      // hard. teams:is-member is graceful (handled inside checkAccess via
      // try/catch) and intentionally NOT declared in calls.
      calls: ['database:get-instance', 'http:register-route', 'auth:require-user'],
      // Soft deps for the authored-skill discovery hooks (TASK-74): they read
      // the @ax/skills DB store (skills:list-authored) — the .ax/draft-skills
      // workspace scan is retired, so workspace:list/read are no longer deps.
      optionalCalls: [
        {
          hook: 'teams:list-for-user',
          degradation:
            'team agents the user belongs to are omitted from GET /admin/agents (personal agents only)',
        },
        {
          hook: 'skills:list-authored',
          degradation: 'authored-skill discovery is skipped (no skills store)',
        },
        {
          hook: 'connectors:resolve',
          degradation:
            "the non-admin attachment guard can't verify a connector's keyMode, so attaching connectors/skills falls back to admin-only (fail-closed) — admins are unaffected; a newly attached connector also cannot copy its per-tool defaults",
        },
        {
          hook: 'tool-policy:snapshot-connector-for-agent',
          degradation:
            "a newly attached connector does not copy its per-tool defaults; the agent follows the connector's live defaults instead (a later loosening by the connector's editor then applies to it too)",
        },
        {
          // TASK-808 — transitional: the boot-time conversion of legacy
          // connector defaults into explicit attachments reads + clears the
          // retired flag through these two.
          hook: 'connectors:list-legacy-defaults',
          degradation:
            'legacy connector defaults are not converted into attachments (nothing to convert without @ax/connectors)',
        },
        {
          hook: 'connectors:clear-legacy-default',
          degradation:
            'a converted legacy connector default keeps its flag, so the (idempotent) conversion re-runs on the next boot',
        },
        {
          hook: 'models:get-policy',
          degradation:
            "the model allow-list, the Default model and the runner rule fall back to the built-in list (today's behaviour)",
        },
      ],
      subscribes: ['bootstrap:reset-cleanup'],
    });
  });

  // TASK-799 — the list-replace connector hook is retired: attach / detach are
  // the only write path for connectorAttachments.
  it('agents:set-connector-attachments is not registered; attach / detach are', async () => {
    expect(createAgentsPlugin().manifest.registers).not.toContain(
      'agents:set-connector-attachments',
    );
    const h = await makeHarness();
    expect(h.bus.hasService('agents:set-connector-attachments')).toBe(false);
    expect(h.bus.hasService('agents:attach-connector')).toBe(true);
    expect(h.bus.hasService('agents:detach-connector')).toBe(true);
  });

  it('init runs the migration so agents_v1_agents is reachable', async () => {
    const h = await makeHarness();
    const { sql } = await import('kysely');
    const { db } = await h.bus.call<unknown, { db: import('kysely').Kysely<unknown> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM agents_v1_agents
    `.execute(db);
    expect(result.rows[0]?.count).toBe('0');
  });

  it('bootstrap:reset-cleanup wipes every agent row so the wizard can re-seed', async () => {
    const h = await makeHarness();
    const ctx = h.ctx({ userId: 'u1' });
    await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput(),
    });
    await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput({ displayName: 'Second' }),
    });

    const { sql } = await import('kysely');
    const { db } = await h.bus.call<unknown, { db: import('kysely').Kysely<unknown> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    let count = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM agents_v1_agents
    `.execute(db);
    expect(count.rows[0]?.count).toBe('2');

    const fired = await h.bus.fire('bootstrap:reset-cleanup', h.ctx(), {});
    expect(fired.rejected).toBe(false);

    count = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM agents_v1_agents
    `.execute(db);
    expect(count.rows[0]?.count).toBe('0');
  });
});

describe('@ax/agents service hooks (round trip)', () => {
  it('create → resolve → list → update → delete', async () => {
    const h = await makeHarness();
    const ctx = h.ctx({ userId: 'u1' });

    const created = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      ctx,
      { actor: { userId: 'u1', isAdmin: false }, input: makeInput() },
    );
    expect(created.agent.ownerId).toBe('u1');
    expect(created.agent.ownerType).toBe('user');
    expect(created.agent.visibility).toBe('personal');

    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'agents:resolve',
      ctx,
      { agentId: created.agent.id, userId: 'u1' },
    );
    expect(resolved.agent.id).toBe(created.agent.id);

    const listed = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'agents:list-for-user',
      ctx,
      { userId: 'u1' },
    );
    expect(listed.agents.map((a) => a.id)).toEqual([created.agent.id]);

    const updated = await h.bus.call<UpdateInput, UpdateOutput>(
      'agents:update',
      ctx,
      {
        actor: { userId: 'u1', isAdmin: false },
        agentId: created.agent.id,
        patch: { displayName: 'Renamed' },
      },
    );
    expect(updated.agent.displayName).toBe('Renamed');

    await h.bus.call<DeleteInput, void>('agents:delete', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      agentId: created.agent.id,
    });

    const empty = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'agents:list-for-user',
      ctx,
      { userId: 'u1' },
    );
    expect(empty.agents).toEqual([]);
  });

  it('agents:resolve rejects with forbidden for someone else’s agent', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      h.ctx(),
      { actor: { userId: 'u1', isAdmin: false }, input: makeInput() },
    );
    let caught: unknown;
    try {
      await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', h.ctx(), {
        agentId: created.agent.id,
        userId: 'someone-else',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('forbidden');
  });

  it('fires agents:created after agents:create commits', async () => {
    const h = await makeHarness();
    const events: AgentsCreatedEvent[] = [];
    h.bus.subscribe<AgentsCreatedEvent>(
      'agents:created',
      'test-spy',
      async (_ctx, payload) => {
        events.push(payload);
        return undefined;
      },
    );
    const out = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      h.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, input: makeInput() },
    );
    expect(events).toEqual([
      { agentId: out.agent.id, ownerId: 'u1', ownerType: 'user' },
    ]);
  });

  // TASK-167 (§11 cleanup): agents:delete fires agents:deleted AFTER the row is
  // removed so subscribers (the sandbox provider's user-files cleanup) reclaim
  // per-agent state in other tiers. Payload mirrors agents:created — minimal +
  // storage-agnostic.
  it('fires agents:deleted after agents:delete removes the row', async () => {
    const h = await makeHarness();
    const ctx = h.ctx({ userId: 'u1' });
    const events: AgentsDeletedEvent[] = [];
    h.bus.subscribe<AgentsDeletedEvent>(
      'agents:deleted',
      'test-spy',
      async (_ctx, payload) => {
        events.push(payload);
        return undefined;
      },
    );
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      ctx,
      { actor: { userId: 'u1', isAdmin: false }, input: makeInput() },
    );
    await h.bus.call<DeleteInput, void>('agents:delete', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      agentId: created.agent.id,
    });
    expect(events).toEqual([
      { agentId: created.agent.id, ownerId: 'u1', ownerType: 'user' },
    ]);
  });

  // TASK-718: every data-owning plugin now reacts to agents:deleted, and the
  // k8s reclaim subscriber waits on a pod. `HookBus.fire` is unbounded by
  // default and runs subscribers one after another, so a subscriber that never
  // settles (an apiserver that stops answering) would hold the delete request
  // open AND keep every later subscriber -- the ones that delete conversations,
  // sessions and facts -- from ever running. A bound turns "never" into "late".
  it('a hung agents:deleted subscriber does not hold back the subscribers after it', async () => {
    const h = await makeHarness({ config: { deletedSubscriberTimeoutMs: 50 } });
    const ctx = h.ctx({ userId: 'u1' });
    h.bus.subscribe<AgentsDeletedEvent>('agents:deleted', 'test-hang', async () => {
      await new Promise<never>(() => {
        /* never settles */
      });
      return undefined;
    });
    const ran: string[] = [];
    h.bus.subscribe<AgentsDeletedEvent>('agents:deleted', 'test-after', async (_c, payload) => {
      ran.push(payload.agentId);
      return undefined;
    });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput(),
    });
    await h.bus.call<DeleteInput, void>('agents:delete', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      agentId: created.agent.id,
    });
    expect(ran).toEqual([created.agent.id]);
  }, 10_000);

  it('agents:delete succeeds even when an agents:deleted subscriber throws', async () => {
    const h = await makeHarness();
    const ctx = h.ctx({ userId: 'u1' });
    h.bus.subscribe<AgentsDeletedEvent>(
      'agents:deleted',
      'test-thrower',
      async () => {
        throw new Error('cleanup subscriber boom — must not block delete');
      },
    );
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      ctx,
      { actor: { userId: 'u1', isAdmin: false }, input: makeInput() },
    );
    // The delete must still complete + remove the row despite the throw.
    await h.bus.call<DeleteInput, void>('agents:delete', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      agentId: created.agent.id,
    });
    const empty = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'agents:list-for-user',
      ctx,
      { userId: 'u1' },
    );
    expect(empty.agents).toEqual([]);
  });

  it('does NOT fire agents:created when caller supplies a tx (caller-owns-commit contract)', async () => {
    const h = await makeHarness();
    const events: AgentsCreatedEvent[] = [];
    h.bus.subscribe<AgentsCreatedEvent>(
      'agents:created',
      'test-spy',
      async (_ctx, payload) => {
        events.push(payload);
        return undefined;
      },
    );
    // Fetch a real Kysely instance so the create can execute against the
    // postgres test container, then open a transaction and pass the
    // resulting `trx` to agents:create. This mirrors the shape the
    // onboarding wizard uses via db:transact (storage-postgres's run
    // callback hands its run({tx}) a Kysely Transaction the same way).
    const { db } = await h.bus.call<
      unknown,
      { db: import('kysely').Kysely<unknown> }
    >('database:get-instance', h.ctx(), {});
    await db.transaction().execute(async (trx) => {
      await h.bus.call<CreateInput, CreateOutput>(
        'agents:create',
        h.ctx({ userId: 'u1' }),
        {
          actor: { userId: 'u1', isAdmin: false },
          input: makeInput(),
          tx: trx as never,
        },
      );
    });
    // After the outer transaction commits, the agents plugin must NOT
    // have fired agents:created — that's the caller's responsibility.
    expect(events).toEqual([]);
  });

  it('agents:create succeeds even when an agents:created subscriber throws', async () => {
    const h = await makeHarness();
    h.bus.subscribe<AgentsCreatedEvent>(
      'agents:created',
      'test-thrower',
      async () => {
        throw new Error('subscriber boom — must not block create');
      },
    );
    const out = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      h.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, input: makeInput() },
    );
    expect(out.agent.id).toMatch(/^agt_/);
    expect(out.agent.ownerId).toBe('u1');
  });

  it('agents:resolve fires agents:resolved subscriber on success', async () => {
    const h = await makeHarness();
    const events: Array<{ agentId: string; userId: string; visibility: string }> = [];
    h.bus.subscribe<{
      agentId: string;
      userId: string;
      visibility: string;
    }>('agents:resolved', 'test', async (_c, payload) => {
      events.push(payload);
      return undefined;
    });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      h.ctx(),
      { actor: { userId: 'u1', isAdmin: false }, input: makeInput() },
    );
    await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', h.ctx(), {
      agentId: created.agent.id,
      userId: 'u1',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      agentId: created.agent.id,
      userId: 'u1',
      visibility: 'personal',
    });
    // No system_prompt leak — the event payload has only generic fields.
    expect(Object.keys(events[0]!).sort()).toEqual(
      ['agentId', 'userId', 'visibility'].sort(),
    );
  });

  it('agents:list-for-user only returns reachable agents', async () => {
    const h = await makeHarness();
    await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput({ displayName: 'A' }),
    });
    await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u2', isAdmin: false },
      input: makeInput({ displayName: 'B' }),
    });
    const list = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'agents:list-for-user',
      h.ctx(),
      { userId: 'u1' },
    );
    expect(list.agents.map((a) => a.displayName)).toEqual(['A']);
  });

  it("agents:create with visibility='team' requires teamId + membership", async () => {
    const h = await makeHarness({ withTeams: 'always-member' });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      h.ctx(),
      {
        actor: { userId: 'u1', isAdmin: false },
        input: makeInput({ visibility: 'team', teamId: 't1' }),
      },
    );
    expect(created.agent.ownerType).toBe('team');
    expect(created.agent.ownerId).toBe('t1');
    expect(created.agent.visibility).toBe('team');
  });

  it("agents:create with visibility='team' rejects when not a member", async () => {
    const h = await makeHarness({ withTeams: 'never-member' });
    let caught: unknown;
    try {
      await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
        actor: { userId: 'u1', isAdmin: false },
        input: makeInput({ visibility: 'team', teamId: 't1' }),
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('forbidden');
  });

  it("agents:create with visibility='team' rejects when @ax/teams isn't loaded", async () => {
    const h = await makeHarness({ withTeams: null });
    let caught: unknown;
    try {
      await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
        actor: { userId: 'u1', isAdmin: false },
        input: makeInput({ visibility: 'team', teamId: 't1' }),
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('forbidden');
  });

  it('agents:update rejects non-owner non-admin', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      h.ctx(),
      { actor: { userId: 'u1', isAdmin: false }, input: makeInput() },
    );
    let caught: unknown;
    try {
      await h.bus.call<UpdateInput, UpdateOutput>('agents:update', h.ctx(), {
        actor: { userId: 'u2', isAdmin: false },
        agentId: created.agent.id,
        patch: { displayName: 'Hacked' },
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('forbidden');
  });

  it('agents:update allows admin override on someone else’s agent', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      h.ctx(),
      { actor: { userId: 'u1', isAdmin: false }, input: makeInput() },
    );
    const updated = await h.bus.call<UpdateInput, UpdateOutput>(
      'agents:update',
      h.ctx(),
      {
        actor: { userId: 'admin-user', isAdmin: true },
        agentId: created.agent.id,
        patch: { displayName: 'Renamed by admin' },
      },
    );
    expect(updated.agent.displayName).toBe('Renamed by admin');
  });

  it('agents:resolve returns not-found for non-existent agent', async () => {
    const h = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', h.ctx(), {
        agentId: 'agt_does_not_exist',
        userId: 'u1',
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('not-found');
    // TASK-680 — @ax/routines prunes a deleted agent's routines only on a
    // not-found carrying THIS hookName (a not-found propagated from a hook
    // resolve calls must not prune a live agent). Drop it and deleted agents'
    // heartbeats fail forever again.
    expect((caught as PluginError).hookName).toBe('agents:resolve');
  });

  it('agents:any-attached-to-skill returns false when no agent has the skill', async () => {
    const h = await makeHarness();
    const r = await h.bus.call<{ skillId: string }, { attached: boolean }>(
      'agents:any-attached-to-skill',
      h.ctx(),
      { skillId: 'unattached-skill' },
    );
    expect(r).toEqual({ attached: false });
  });

  it('agents:any-attached-to-skill returns true when at least one agent has the skill', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput(),
    });
    // Seed skill_attachments directly — the dedicated PATCH route ships in Phase 1.4.3.
    const { db } = await h.bus.call<unknown, { db: import('kysely').Kysely<unknown> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const { sql } = await import('kysely');
    await sql`
      UPDATE agents_v1_agents
         SET skill_attachments = ${JSON.stringify([{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'cred-ref-1' } }])}::jsonb
       WHERE agent_id = ${created.agent.id}
    `.execute(db);

    const r = await h.bus.call<{ skillId: string }, { attached: boolean }>(
      'agents:any-attached-to-skill',
      h.ctx(),
      { skillId: 'github' },
    );
    expect(r).toEqual({ attached: true });
  });

  it('agents:list-ids returns every agent id (no ACL filtering, all owners)', async () => {
    const h = await makeHarness();
    // Empty state — must succeed and return an empty array.
    const empty = await h.bus.call<Record<string, never>, { agentIds: string[] }>(
      'agents:list-ids',
      h.ctx(),
      {},
    );
    expect(empty.agentIds).toEqual([]);

    // Create three agents across two distinct owners — no scope filtering
    // applies, the tick loop sees them all.
    const a = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput({ displayName: 'A' }),
    });
    const b = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput({ displayName: 'B' }),
    });
    const c = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u2', isAdmin: false },
      input: makeInput({ displayName: 'C' }),
    });

    const all = await h.bus.call<Record<string, never>, { agentIds: string[] }>(
      'agents:list-ids',
      h.ctx(),
      {},
    );
    expect(all.agentIds.sort()).toEqual(
      [a.agent.id, b.agent.id, c.agent.id].sort(),
    );
  });

  it('agents:list-personal-owners returns (agentId, ownerUserId) for personal agents only', async () => {
    // teams:is-member stub lets us create a team agent without loading
    // @ax/teams — it must be excluded from the result, since routing a
    // default routine fire under a team is a separate policy decision.
    const h = await makeHarness({ withTeams: 'always-member' });

    const personalA = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u_alice', isAdmin: false },
      input: makeInput({ displayName: 'A' }),
    });
    const personalB = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u_bob', isAdmin: false },
      input: makeInput({ displayName: 'B' }),
    });
    // Team-visibility agent — must NOT appear in the result.
    await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u_alice', isAdmin: false },
      input: makeInput({ displayName: 'T', visibility: 'team', teamId: 't1' }),
    });

    const r = await h.bus.call<
      Record<string, never>,
      { agents: Array<{ agentId: string; ownerUserId: string }> }
    >('agents:list-personal-owners', h.ctx(), {});
    expect(r.agents.sort((x, y) => x.agentId.localeCompare(y.agentId))).toEqual(
      [
        { agentId: personalA.agent.id, ownerUserId: 'u_alice' },
        { agentId: personalB.agent.id, ownerUserId: 'u_bob' },
      ].sort((x, y) => x.agentId.localeCompare(y.agentId)),
    );
  });

  it('agents:any-attached-to-skill returns false when an agent has a DIFFERENT skill attached', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput(),
    });
    // Attach 'github' — then query for 'openai'.
    const { db } = await h.bus.call<unknown, { db: import('kysely').Kysely<unknown> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const { sql } = await import('kysely');
    await sql`
      UPDATE agents_v1_agents
         SET skill_attachments = ${JSON.stringify([{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'cred-ref-1' } }])}::jsonb
       WHERE agent_id = ${created.agent.id}
    `.execute(db);

    const r = await h.bus.call<{ skillId: string }, { attached: boolean }>(
      'agents:any-attached-to-skill',
      h.ctx(),
      { skillId: 'openai' },
    );
    expect(r).toEqual({ attached: false });
  });
});

describe('@ax/agents credential purge on delete', () => {
  it('agents:delete calls credentials:purge-by-owner({ scope: agent }) exactly once', async () => {
    const purgeStub = vi.fn(async () => ({ deleted: 0 }));

    const h = await makeHarness({
      withTeams: undefined,
      extraServices: { 'credentials:purge-by-owner': purgeStub },
    });
    const ctx = h.ctx({ userId: 'u1' });

    // Create an agent.
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput(),
    });
    const agentId = created.agent.id;

    // Delete it — purge stub should fire exactly once with scope: 'agent'.
    await h.bus.call<DeleteInput, void>('agents:delete', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      agentId,
    });

    expect(purgeStub).toHaveBeenCalledTimes(1);
    expect(purgeStub).toHaveBeenCalledWith(
      expect.anything(),
      { scope: 'agent', ownerId: agentId },
    );

    // Agent row should be gone.
    const empty = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'agents:list-for-user',
      ctx,
      { userId: 'u1' },
    );
    expect(empty.agents).toEqual([]);
  });

  it('agents:delete continues and deletes agent even if credentials:purge-by-owner fails', async () => {
    const purgeStub = vi.fn(async () => {
      throw new Error('storage exploded');
    });

    const h = await makeHarness({
      withTeams: undefined,
      extraServices: { 'credentials:purge-by-owner': purgeStub },
    });
    const ctx = h.ctx({ userId: 'u1' });

    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput(),
    });

    // Delete should succeed even though purge throws.
    await expect(
      h.bus.call<DeleteInput, void>('agents:delete', ctx, {
        actor: { userId: 'u1', isAdmin: false },
        agentId: created.agent.id,
      }),
    ).resolves.toBeUndefined();

    // Agent should be gone.
    const empty = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'agents:list-for-user',
      ctx,
      { userId: 'u1' },
    );
    expect(empty.agents).toEqual([]);
  });

  it('agents:delete skips credentials:purge-by-owner when service is not loaded', async () => {
    // No extraServices — @ax/credentials not wired in (stripped preset simulation).
    const h = await makeHarness();
    const ctx = h.ctx({ userId: 'u1' });

    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, {
      actor: { userId: 'u1', isAdmin: false },
      input: makeInput(),
    });

    // Should complete without throwing even though credentials is absent.
    await expect(
      h.bus.call<DeleteInput, void>('agents:delete', ctx, {
        actor: { userId: 'u1', isAdmin: false },
        agentId: created.agent.id,
      }),
    ).resolves.toBeUndefined();

    // Confirm the agent row is actually gone (not a silent no-op).
    const { agents } = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'agents:list-for-user',
      ctx,
      { userId: 'u1' },
    );
    expect(agents.find((a) => a.id === created.agent.id)).toBeUndefined();
  });
});
describe('model policy (models:get-policy)', () => {
  const SONNET = 'anthropic/claude-sonnet-4-6';
  const OPUS = 'anthropic/claude-opus-4-7';
  const DEEPSEEK = 'openrouter/deepseek/deepseek-v4-pro'; // not in the built-in list

  function policyServices(state: { allowed: string[]; default: string }) {
    return {
      'models:get-policy': async () => ({
        allowed: state.allowed,
        default: state.default,
        source: 'admin',
        version: 1,
      }),
    };
  }
  const actor = { userId: 'u1', isAdmin: false };

  it('create accepts a model only the policy allows, and derives the aisdk runner for it', async () => {
    const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
    const h = await makeHarness({ extraServices: policyServices(state) });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId: 'u1' }), {
      actor,
      input: makeInput({ model: DEEPSEEK }),
    });
    expect(created.agent).toMatchObject({ model: DEEPSEEK, runner: 'aisdk' });
  });

  it('create rejects a model the policy removed even though the built-in list has it', async () => {
    const state = { allowed: [SONNET], default: SONNET };
    const h = await makeHarness({ extraServices: policyServices(state) });
    await expect(
      h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId: 'u1' }), {
        actor,
        input: makeInput({ model: OPUS }),
      }),
    ).rejects.toThrow(/not in the allow-list/);
  });

  it('update follows the policy live: a model allowed a moment ago is refused once removed', async () => {
    const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
    const h = await makeHarness({ extraServices: policyServices(state) });
    const ctx = h.ctx({ userId: 'u1' });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: SONNET }) });
    state.allowed = [SONNET];
    await expect(
      h.bus.call<UpdateInput, UpdateOutput>('agents:update', ctx, {
        actor,
        agentId: created.agent.id,
        patch: { model: DEEPSEEK },
      }),
    ).rejects.toThrow(/not in the allow-list/);
  });

  it('update re-derives the runner when the model changes', async () => {
    const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
    const h = await makeHarness({ extraServices: policyServices(state) });
    const ctx = h.ctx({ userId: 'u1' });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: SONNET }) });
    const updated = await h.bus.call<UpdateInput, UpdateOutput>('agents:update', ctx, {
      actor,
      agentId: created.agent.id,
      patch: { model: DEEPSEEK },
    });
    expect(updated.agent).toMatchObject({ model: DEEPSEEK, runner: 'aisdk' });
  });

  it('update refuses a runner-only change that contradicts the stored model', async () => {
    const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
    const h = await makeHarness({ extraServices: policyServices(state) });
    const ctx = h.ctx({ userId: 'u1' });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
    await expect(
      h.bus.call<UpdateInput, UpdateOutput>('agents:update', ctx, {
        actor,
        agentId: created.agent.id,
        patch: { runner: 'claude-sdk' },
      }),
    ).rejects.toThrow(/only run Anthropic models/);
  });

  it('keeps today\'s behaviour when @ax/model-policy is not loaded (built-in list)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId: 'u1' }), {
      actor,
      input: makeInput({ model: OPUS }),
    });
    expect(created.agent.model).toBe(OPUS);
  });
  describe('lazy swap in agents:resolve', () => {
    it('runs a no-longer-allowed agent on the Default, reports requestedModel, and leaves the stored row alone', async () => {
      const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
      const h = await makeHarness({ extraServices: policyServices(state) });
      const ctx = h.ctx({ userId: 'u1' });
      const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
      state.allowed = [SONNET]; // the admin removes DEEPSEEK

      const resolved = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctx, { agentId: created.agent.id, userId: 'u1' });
      expect(resolved.agent).toMatchObject({ model: SONNET, runner: 'claude-sdk', requestedModel: DEEPSEEK });

      const listed = await h.bus.call<ListForUserInput, ListForUserOutput>('agents:list-for-user', ctx, { userId: 'u1' });
      expect(listed.agents[0]).toMatchObject({ model: DEEPSEEK, runner: 'aisdk' });
      expect(listed.agents[0]!.requestedModel).toBeUndefined();
    });

    it('brings the agent back when the model is added again', async () => {
      const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
      const h = await makeHarness({ extraServices: policyServices(state) });
      const ctx = h.ctx({ userId: 'u1' });
      const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
      state.allowed = [SONNET];
      await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctx, { agentId: created.agent.id, userId: 'u1' });
      state.allowed = [SONNET, DEEPSEEK];
      const back = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctx, { agentId: created.agent.id, userId: 'u1' });
      expect(back.agent).toMatchObject({ model: DEEPSEEK, runner: 'aisdk' });
      expect(back.agent.requestedModel).toBeUndefined();
    });

    it('an update that does not touch the model never persists the swapped-in Default', async () => {
      const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
      const h = await makeHarness({ extraServices: policyServices(state) });
      const ctx = h.ctx({ userId: 'u1' });
      const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
      state.allowed = [SONNET];
      await h.bus.call<UpdateInput, UpdateOutput>('agents:update', ctx, {
        actor,
        agentId: created.agent.id,
        patch: { displayName: 'Renamed' },
      });
      const listed = await h.bus.call<ListForUserInput, ListForUserOutput>('agents:list-for-user', ctx, { userId: 'u1' });
      expect(listed.agents[0]).toMatchObject({ displayName: 'Renamed', model: DEEPSEEK, runner: 'aisdk' });
    });

    it("an explicit model choice on a swapped agent is saved as the owner's choice", async () => {
      const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
      const h = await makeHarness({ extraServices: policyServices(state) });
      const ctx = h.ctx({ userId: 'u1' });
      const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
      state.allowed = [SONNET];
      await h.bus.call<UpdateInput, UpdateOutput>('agents:update', ctx, {
        actor,
        agentId: created.agent.id,
        patch: { model: SONNET },
      });
      const resolved = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctx, { agentId: created.agent.id, userId: 'u1' });
      expect(resolved.agent).toMatchObject({ model: SONNET, runner: 'claude-sdk' });
      expect(resolved.agent.requestedModel).toBeUndefined();
    });

    it('heals an existing claude-sdk agent on a non-Anthropic model so it runs on aisdk', async () => {
      const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
      const h = await makeHarness({ extraServices: policyServices(state) });
      const ctx = h.ctx({ userId: 'u1' });
      const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
      // Recreate the broken combination that exists in production today.
      const { sql } = await import('kysely');
      const { db } = await h.bus.call<unknown, { db: import('kysely').Kysely<unknown> }>('database:get-instance', h.ctx(), {});
      await sql`UPDATE agents_v1_agents SET runner = 'claude-sdk' WHERE agent_id = ${created.agent.id}`.execute(db);

      const resolved = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctx, { agentId: created.agent.id, userId: 'u1' });
      expect(resolved.agent).toMatchObject({ model: DEEPSEEK, runner: 'aisdk' });
    });
  });

});

// ---------------------------------------------------------------------------
// TASK-739 — atomic per-connector attach / detach + the workspace-connector
// guard enforced in the hooks (every path, not just the admin route).
// ---------------------------------------------------------------------------
describe('agents:attach-connector / agents:detach-connector (TASK-739)', () => {
  // keyMode per connector id; anything else → connectors:resolve throws
  // not-found (a connector the actor doesn't own never resolves → no-op).
  const KEY_MODES: Record<string, 'personal' | 'workspace'> = {
    'personal-conn': 'personal',
    'workspace-conn': 'workspace',
  };
  const connectorsResolve = {
    'connectors:resolve': async (_ctx: unknown, input: unknown) => {
      const { connectorId } = input as { connectorId: string };
      const keyMode = KEY_MODES[connectorId];
      if (keyMode === undefined) {
        throw new PluginError({ code: 'not-found', plugin: 'stub', message: 'nope' });
      }
      return { keyMode };
    },
  };
  const owner = { userId: 'u1', isAdmin: false };
  const admin = { userId: 'admin', isAdmin: true };

  async function seed(withConnectors = true) {
    const h = await makeHarness(withConnectors ? { extraServices: connectorsResolve } : {});
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: owner,
      input: makeInput(),
    });
    return { h, agentId: created.agent.id };
  }

  function attach(h: TestHarness, input: AttachConnectorInput) {
    return h.bus.call<AttachConnectorInput, AttachConnectorOutput>(
      'agents:attach-connector',
      h.ctx(),
      input,
    );
  }
  function detach(h: TestHarness, input: DetachConnectorInput) {
    return h.bus.call<DetachConnectorInput, DetachConnectorOutput>(
      'agents:detach-connector',
      h.ctx(),
      input,
    );
  }
  async function current(h: TestHarness, agentId: string) {
    const out = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', h.ctx(), {
      agentId,
      userId: 'u1',
    });
    return out.agent;
  }

  it('attach adds, clears an exclusion, and is idempotent (changed:false)', async () => {
    const { h, agentId } = await seed();
    await detach(h, { actor: owner, agentId, connectorId: 'personal-conn', exclude: true });
    const first = await attach(h, { actor: owner, agentId, connectorId: 'personal-conn' });
    expect(first.changed).toBe(true);
    expect(first.agent.connectorAttachments).toEqual(['personal-conn']);
    expect(first.agent.connectorExclusions).toEqual([]);
    const second = await attach(h, { actor: owner, agentId, connectorId: 'personal-conn' });
    expect(second.changed).toBe(false);
    expect(second.agent.connectorAttachments).toEqual(['personal-conn']);
  });

  it('agents:resolve carries connectorExclusions (not stripped by the returns schema)', async () => {
    const { h, agentId } = await seed();
    await detach(h, { actor: owner, agentId, connectorId: 'legacy-conn', exclude: true });
    expect((await current(h, agentId)).connectorExclusions).toEqual(['legacy-conn']);
  });

  it('detach removes; detach with exclude records an exclusion', async () => {
    const { h, agentId } = await seed();
    await attach(h, { actor: owner, agentId, connectorId: 'personal-conn' });
    const removed = await detach(h, {
      actor: owner,
      agentId,
      connectorId: 'personal-conn',
      exclude: false,
    });
    expect(removed.changed).toBe(true);
    expect(removed.agent.connectorAttachments).toEqual([]);
    expect(removed.agent.connectorExclusions).toEqual([]);
    const excluded = await detach(h, {
      actor: owner,
      agentId,
      connectorId: 'some-default',
      exclude: true,
    });
    expect(excluded.changed).toBe(true);
    expect(excluded.agent.connectorExclusions).toEqual(['some-default']);
  });

  it('rejects a malformed connector id (invalid-payload)', async () => {
    const { h, agentId } = await seed();
    await expect(
      attach(h, { actor: owner, agentId, connectorId: 'Bad Id!' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(
      detach(h, { actor: owner, agentId, connectorId: '', exclude: false }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('not-found for a missing agent', async () => {
    const { h } = await seed();
    await expect(
      attach(h, { actor: owner, agentId: 'agt_missing', connectorId: 'personal-conn' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      detach(h, { actor: owner, agentId: 'agt_missing', connectorId: 'x', exclude: true }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it("SECURITY (IDOR): another non-admin user cannot attach/detach on someone else's personal agent", async () => {
    const { h, agentId } = await seed();
    await attach(h, { actor: owner, agentId, connectorId: 'personal-conn' });
    const intruder = { userId: 'u2', isAdmin: false };
    await expect(
      attach(h, { actor: intruder, agentId, connectorId: 'other-conn' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      detach(h, { actor: intruder, agentId, connectorId: 'personal-conn', exclude: true }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const after = await current(h, agentId);
    expect(after.connectorAttachments).toEqual(['personal-conn']);
    expect(after.connectorExclusions).toEqual([]);
  });

  it('SECURITY: a non-admin cannot attach a workspace connector; an admin can', async () => {
    const { h, agentId } = await seed();
    await expect(
      attach(h, { actor: owner, agentId, connectorId: 'workspace-conn' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      // TASK-799 — attach's documented error contract: the guard's refusal is
      // tagged apart from the ACL's, and names only the id the caller sent.
      diagnosis: { reason: 'workspace-connector' },
      message: expect.stringMatching(/'workspace-conn' is a workspace \(shared\) connector/),
    });
    expect((await current(h, agentId)).connectorAttachments).toEqual([]);
    const byAdmin = await attach(h, { actor: admin, agentId, connectorId: 'workspace-conn' });
    expect(byAdmin.agent.connectorAttachments).toEqual(['workspace-conn']);
  });

  it('SECURITY: fail-closed without connectors:resolve — non-admin attach is forbidden', async () => {
    const { h, agentId } = await seed(false);
    await expect(
      attach(h, { actor: owner, agentId, connectorId: 'personal-conn' }),
    ).rejects.toMatchObject({ code: 'forbidden', diagnosis: { reason: 'workspace-connector' } });
    // An admin is unaffected.
    await attach(h, { actor: admin, agentId, connectorId: 'personal-conn' });
    // detach never grants reach, so it is not guarded.
    const out = await detach(h, { actor: owner, agentId, connectorId: 'x', exclude: true });
    expect(out.agent.connectorExclusions).toEqual(['x']);
  });

  it('CONCURRENCY: 10 parallel hook attaches of distinct ids all land', async () => {
    const { h, agentId } = await seed();
    const ids = Array.from({ length: 10 }, (_, i) => `conn-${i}`);
    await Promise.all(ids.map((connectorId) => attach(h, { actor: admin, agentId, connectorId })));
    const after = await current(h, agentId);
    expect([...after.connectorAttachments].sort()).toEqual([...ids].sort());
  });

  it('CONCURRENCY: attach(A) racing detach(B, exclude) keeps both effects', async () => {
    const { h, agentId } = await seed();
    await attach(h, { actor: admin, agentId, connectorId: 'b' });
    await Promise.all([
      attach(h, { actor: admin, agentId, connectorId: 'a' }),
      detach(h, { actor: admin, agentId, connectorId: 'b', exclude: true }),
    ]);
    const after = await current(h, agentId);
    expect(after.connectorAttachments).toEqual(['a']);
    expect(after.connectorExclusions).toEqual(['b']);
  });
});

// TASK-765 / TASK-798 — whatever connector a team agent reaches, every member's
// runs reach (and a sign-in on it decides whose account they all act as). So a
// plain member may not change a team agent's connectors at all: attach, detach
// (with or without `exclude`). Only the agent's owner
// (personal) / a team admin (team) / a workspace admin may.
// `agents:can-manage-connectors` exposes the same answer to the route and to
// @ax/mcp-oauth, so nobody is offered a button the server would refuse.
describe('agents: only the owner or an admin may change a team agent connectors (TASK-765, TASK-798)', () => {
  const connectorsResolve = {
    'connectors:resolve': async (_ctx: unknown, input: unknown) => {
      const { connectorId } = input as { connectorId: string };
      if (connectorId === 'personal-conn' || connectorId === 'fresh-conn') {
        return { keyMode: 'personal' };
      }
      throw new PluginError({ code: 'not-found', plugin: 'stub', message: 'nope' });
    },
  };

  // Role-aware teams:is-member stub. After `okCalls` lookups it starts failing
  // with `failure` — that is how a test reaches the role check's own error
  // handling (the ownership ACL, which runs first, has already succeeded).
  const roles: Record<string, { member: boolean; role?: 'admin' | 'member' }> = {
    tmember: { member: true, role: 'member' },
    tadmin: { member: true, role: 'admin' },
  };
  let teamsCalls = 0;
  let okCalls = Infinity;
  let failure: 'no-service' | 'broken' = 'no-service';
  const teamsIsMember = {
    'teams:is-member': async (_ctx: unknown, input: unknown) => {
      if (teamsCalls++ >= okCalls) {
        if (failure === 'no-service') {
          throw new PluginError({
            code: 'no-service',
            plugin: 'stub',
            message: 'no service registered for teams:is-member',
          });
        }
        throw new Error('teams db is down');
      }
      const { userId } = input as { userId: string };
      return roles[userId] ?? { member: false };
    },
  };
  /** Let exactly `n` more lookups succeed, then fail with `how`. */
  function teamsFailsAfter(n: number, how: 'no-service' | 'broken') {
    teamsCalls = 0;
    okCalls = n;
    failure = how;
  }

  const member = { userId: 'tmember', isAdmin: false };
  const teamAdmin = { userId: 'tadmin', isAdmin: false };
  const workspaceAdmin = { userId: 'wsadmin', isAdmin: true };
  const outsider = { userId: 'outsider', isAdmin: false };
  const owner = { userId: 'u1', isAdmin: false };

  async function seedTeamAgent() {
    okCalls = Infinity;
    const h = await makeHarness({ extraServices: { ...connectorsResolve, ...teamsIsMember } });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: member,
      input: makeInput({ visibility: 'team', teamId: 't1' }),
    });
    return { h, agentId: created.agent.id };
  }
  async function seedPersonalAgent() {
    okCalls = Infinity;
    const h = await makeHarness({ extraServices: { ...connectorsResolve, ...teamsIsMember } });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: owner,
      input: makeInput(),
    });
    return { h, agentId: created.agent.id };
  }

  function attach(h: TestHarness, input: AttachConnectorInput) {
    return h.bus.call<AttachConnectorInput, AttachConnectorOutput>(
      'agents:attach-connector',
      h.ctx(),
      input,
    );
  }
  function detach(h: TestHarness, input: DetachConnectorInput) {
    return h.bus.call<DetachConnectorInput, DetachConnectorOutput>(
      'agents:detach-connector',
      h.ctx(),
      input,
    );
  }
  function canManage(h: TestHarness, input: CanManageConnectorsInput) {
    return h.bus.call<CanManageConnectorsInput, CanManageConnectorsOutput>(
      'agents:can-manage-connectors',
      h.ctx(),
      input,
    );
  }
  function canSetShared(h: TestHarness, input: CanSetSharedCredentialInput) {
    return h.bus.call<CanSetSharedCredentialInput, CanSetSharedCredentialOutput>(
      'agents:can-set-shared-credential',
      h.ctx(),
      input,
    );
  }
  async function stored(h: TestHarness, agentId: string) {
    const out = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', h.ctx(), {
      agentId,
      userId: 'tadmin',
    });
    return out.agent;
  }

  describe('agents:attach-connector', () => {
    // UNFIXED (TASK-798): any team member may attach -> test fails.
    it('SECURITY: a plain team member is forbidden, and nothing is written', async () => {
      const { h, agentId } = await seedTeamAgent();
      await expect(
        attach(h, { actor: member, agentId, connectorId: 'fresh-conn' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect((await stored(h, agentId)).connectorAttachments).toEqual([]);
    });

    // TASK-765's case, now through the one check: a member cannot undo the
    // owner's exclusion of a legacy-owned connector by attaching it.
    it('SECURITY: a plain member cannot re-attach an excluded id; the exclusion survives', async () => {
      const { h, agentId } = await seedTeamAgent();
      await detach(h, { actor: teamAdmin, agentId, connectorId: 'personal-conn', exclude: true });
      await expect(
        attach(h, { actor: member, agentId, connectorId: 'personal-conn' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      const after = await stored(h, agentId);
      expect(after.connectorExclusions).toEqual(['personal-conn']);
      expect(after.connectorAttachments).toEqual([]);
    });

    // Guards against over-blocking.
    it('a team admin may attach, and re-attaching an excluded id clears the exclusion', async () => {
      const { h, agentId } = await seedTeamAgent();
      await detach(h, { actor: teamAdmin, agentId, connectorId: 'personal-conn', exclude: true });
      const out = await attach(h, { actor: teamAdmin, agentId, connectorId: 'personal-conn' });
      expect(out.agent.connectorAttachments).toEqual(['personal-conn']);
      expect(out.agent.connectorExclusions).toEqual([]);
    });

    it('a workspace admin (no team role) may attach', async () => {
      const { h, agentId } = await seedTeamAgent();
      const out = await attach(h, { actor: workspaceAdmin, agentId, connectorId: 'fresh-conn' });
      expect(out.agent.connectorAttachments).toEqual(['fresh-conn']);
    });

    it('a non-member is forbidden by the ownership ACL', async () => {
      const { h, agentId } = await seedTeamAgent();
      await expect(
        attach(h, { actor: outsider, agentId, connectorId: 'fresh-conn' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    // UNFIXED: the role is never asked, the attach lands -> fails.
    it('SECURITY: fail-closed — a role lookup that finds no teams plugin is a refusal', async () => {
      const { h, agentId } = await seedTeamAgent();
      teamsFailsAfter(1, 'no-service'); // ownership ACL passes, role check cannot ask
      await expect(
        attach(h, { actor: teamAdmin, agentId, connectorId: 'fresh-conn' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      okCalls = Infinity;
      expect((await stored(h, agentId)).connectorAttachments).toEqual([]);
    });

    it('a role lookup failing for any OTHER reason propagates (never a quiet forbidden)', async () => {
      const { h, agentId } = await seedTeamAgent();
      teamsFailsAfter(1, 'broken');
      await expect(
        attach(h, { actor: member, agentId, connectorId: 'fresh-conn' }),
      ).rejects.toThrow('teams db is down');
    });

    it('a personal agent: the owner may attach (and re-attach an excluded id), a stranger may not', async () => {
      const { h, agentId } = await seedPersonalAgent();
      await detach(h, { actor: owner, agentId, connectorId: 'personal-conn', exclude: true });
      const out = await attach(h, { actor: owner, agentId, connectorId: 'personal-conn' });
      expect(out.agent.connectorExclusions).toEqual([]);
      await expect(
        attach(h, { actor: outsider, agentId, connectorId: 'fresh-conn' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  describe('agents:detach-connector', () => {
    async function seedAttached() {
      const s = await seedTeamAgent();
      await attach(s.h, { actor: teamAdmin, agentId: s.agentId, connectorId: 'personal-conn' });
      return s;
    }

    // UNFIXED (TASK-798): a member may detach an ATTACHED connector -> fails.
    it('SECURITY: a plain member cannot detach an attached connector (exclude:false)', async () => {
      const { h, agentId } = await seedAttached();
      await expect(
        detach(h, { actor: member, agentId, connectorId: 'personal-conn', exclude: false }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect((await stored(h, agentId)).connectorAttachments).toEqual(['personal-conn']);
    });

    // TASK-765's case, through the one check.
    it('SECURITY: a plain member cannot exclude a connector; nothing is recorded', async () => {
      const { h, agentId } = await seedTeamAgent();
      await expect(
        detach(h, { actor: member, agentId, connectorId: 'legacy-conn', exclude: true }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect((await stored(h, agentId)).connectorExclusions).toEqual([]);
    });

    it('a team admin may detach and exclude', async () => {
      const { h, agentId } = await seedAttached();
      const out = await detach(h, {
        actor: teamAdmin,
        agentId,
        connectorId: 'personal-conn',
        exclude: false,
      });
      expect(out.agent.connectorAttachments).toEqual([]);
      const ex = await detach(h, {
        actor: teamAdmin,
        agentId,
        connectorId: 'legacy-conn',
        exclude: true,
      });
      expect(ex.agent.connectorExclusions).toEqual(['legacy-conn']);
    });

    it('a workspace admin (not a team member) may exclude', async () => {
      const { h, agentId } = await seedTeamAgent();
      const out = await detach(h, {
        actor: workspaceAdmin,
        agentId,
        connectorId: 'legacy-conn',
        exclude: true,
      });
      expect(out.agent.connectorExclusions).toEqual(['legacy-conn']);
    });

    it('a non-member is forbidden by the ownership ACL', async () => {
      const { h, agentId } = await seedTeamAgent();
      await expect(
        detach(h, { actor: outsider, agentId, connectorId: 'legacy-conn', exclude: true }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('SECURITY: fail-closed — a role lookup that finds no teams plugin is a refusal', async () => {
      const { h, agentId } = await seedAttached();
      teamsFailsAfter(1, 'no-service');
      await expect(
        detach(h, { actor: teamAdmin, agentId, connectorId: 'personal-conn', exclude: false }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      okCalls = Infinity;
      expect((await stored(h, agentId)).connectorAttachments).toEqual(['personal-conn']);
    });

    it('a role lookup failing for any OTHER reason propagates (never a quiet forbidden)', async () => {
      const { h, agentId } = await seedTeamAgent();
      teamsFailsAfter(1, 'broken');
      await expect(
        detach(h, { actor: member, agentId, connectorId: 'legacy-conn', exclude: true }),
      ).rejects.toThrow('teams db is down');
      okCalls = Infinity;
      expect((await stored(h, agentId)).connectorExclusions).toEqual([]);
    });

    it('a personal agent: the owner may exclude, a stranger may not', async () => {
      const { h, agentId } = await seedPersonalAgent();
      const out = await detach(h, {
        actor: owner,
        agentId,
        connectorId: 'legacy-conn',
        exclude: true,
      });
      expect(out.agent.connectorExclusions).toEqual(['legacy-conn']);
      await expect(
        detach(h, { actor: outsider, agentId, connectorId: 'b-default', exclude: true }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  // UNFIXED: the hook is not registered -> every case fails with no-service.
  describe('agents:can-manage-connectors', () => {
    it('a plain team member: allowed:false', async () => {
      const { h, agentId } = await seedTeamAgent();
      expect(await canManage(h, { actor: member, agentId })).toEqual({ allowed: false });
    });

    it('a team admin: allowed:true', async () => {
      const { h, agentId } = await seedTeamAgent();
      expect(await canManage(h, { actor: teamAdmin, agentId })).toEqual({ allowed: true });
    });

    it('a workspace admin: allowed:true', async () => {
      const { h, agentId } = await seedTeamAgent();
      expect(await canManage(h, { actor: workspaceAdmin, agentId })).toEqual({ allowed: true });
    });

    it('a personal agent: the owner is allowed, a stranger is not', async () => {
      const { h, agentId } = await seedPersonalAgent();
      expect(await canManage(h, { actor: owner, agentId })).toEqual({ allowed: true });
      expect(await canManage(h, { actor: outsider, agentId })).toEqual({ allowed: false });
    });

    it('a user who cannot reach the team agent at all: allowed:false, not an error', async () => {
      const { h, agentId } = await seedTeamAgent();
      expect(await canManage(h, { actor: outsider, agentId })).toEqual({ allowed: false });
    });

    it('no teams plugin: a team member is not provably an admin -> allowed:false', async () => {
      const { h, agentId } = await seedTeamAgent();
      // Membership resolves once (ownership ACL), then the role check finds no service.
      teamsFailsAfter(1, 'no-service');
      expect(await canManage(h, { actor: teamAdmin, agentId })).toEqual({ allowed: false });
      // And with the service gone for good, the ownership ACL refuses first.
      teamsFailsAfter(0, 'no-service');
      expect(await canManage(h, { actor: teamAdmin, agentId })).toEqual({ allowed: false });
      // A workspace admin needs no team lookup at all.
      expect(await canManage(h, { actor: workspaceAdmin, agentId })).toEqual({ allowed: true });
    });

    it('a teams failure other than no-service propagates', async () => {
      const { h, agentId } = await seedTeamAgent();
      teamsFailsAfter(1, 'broken');
      await expect(canManage(h, { actor: member, agentId })).rejects.toThrow('teams db is down');
    });

    it('not-found for a missing agent', async () => {
      const { h } = await seedTeamAgent();
      await expect(
        canManage(h, { actor: workspaceAdmin, agentId: 'agt_missing' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  // TASK-813 — the sign-in or key stored ON a team agent is the account every
  // member's runs act as. Choosing it is the team's admins' call; a workspace
  // admin who is not a team admin gets no bypass here (unlike
  // agents:can-manage-connectors). A personal agent has no shared credential.
  describe('agents:can-set-shared-credential (TASK-813)', () => {
    const wsAdminPlainMember = { userId: 'tmember', isAdmin: true };

    it('a team admin: allowed:true', async () => {
      const { h, agentId } = await seedTeamAgent();
      expect(await canSetShared(h, { actor: teamAdmin, agentId })).toEqual({ allowed: true });
    });

    it('SECURITY: a workspace admin who is not on the team: allowed:false', async () => {
      const { h, agentId } = await seedTeamAgent();
      expect(await canSetShared(h, { actor: workspaceAdmin, agentId })).toEqual({
        allowed: false,
      });
    });

    it('SECURITY: a workspace admin who is a plain team member: allowed:false', async () => {
      const { h, agentId } = await seedTeamAgent();
      expect(await canSetShared(h, { actor: wsAdminPlainMember, agentId })).toEqual({
        allowed: false,
      });
    });

    it('a plain team member: allowed:false', async () => {
      const { h, agentId } = await seedTeamAgent();
      expect(await canSetShared(h, { actor: member, agentId })).toEqual({ allowed: false });
    });

    it('a user who cannot reach the team agent: allowed:false, not an error', async () => {
      const { h, agentId } = await seedTeamAgent();
      expect(await canSetShared(h, { actor: outsider, agentId })).toEqual({ allowed: false });
    });

    it('a personal agent: allowed:false for everyone, its owner and a workspace admin too', async () => {
      const { h, agentId } = await seedPersonalAgent();
      expect(await canSetShared(h, { actor: owner, agentId })).toEqual({ allowed: false });
      expect(await canSetShared(h, { actor: { userId: 'u1', isAdmin: true }, agentId })).toEqual({
        allowed: false,
      });
      expect(await canSetShared(h, { actor: workspaceAdmin, agentId })).toEqual({
        allowed: false,
      });
      expect(await canSetShared(h, { actor: outsider, agentId })).toEqual({ allowed: false });
    });

    it('no teams plugin: allowed:false', async () => {
      const { h, agentId } = await seedTeamAgent();
      // Membership resolves once (reach check), then the role check finds no service.
      teamsFailsAfter(1, 'no-service');
      expect(await canSetShared(h, { actor: teamAdmin, agentId })).toEqual({ allowed: false });
      // Gone for good: the reach check refuses first.
      teamsFailsAfter(0, 'no-service');
      expect(await canSetShared(h, { actor: teamAdmin, agentId })).toEqual({ allowed: false });
      // A workspace admin gets no free pass when the role cannot be read.
      teamsFailsAfter(0, 'no-service');
      expect(await canSetShared(h, { actor: workspaceAdmin, agentId })).toEqual({
        allowed: false,
      });
    });

    it('a teams failure other than no-service propagates', async () => {
      const { h, agentId } = await seedTeamAgent();
      teamsFailsAfter(1, 'broken');
      await expect(canSetShared(h, { actor: teamAdmin, agentId })).rejects.toThrow(
        'teams db is down',
      );
      // A workspace admin skips the reach lookup, so the role lookup is the one that fails.
      teamsFailsAfter(0, 'broken');
      await expect(canSetShared(h, { actor: workspaceAdmin, agentId })).rejects.toThrow(
        'teams db is down',
      );
    });

    it('not-found for a missing agent', async () => {
      const { h } = await seedTeamAgent();
      await expect(
        canSetShared(h, { actor: teamAdmin, agentId: 'agt_missing' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });
});
