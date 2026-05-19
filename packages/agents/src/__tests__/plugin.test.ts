import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { createAgentsPlugin } from '../plugin.js';
import type {
  AgentInput,
  AgentsCreatedEvent,
  CreateInput,
  CreateOutput,
  DeleteInput,
  ListForUserInput,
  ListForUserOutput,
  ResolveInput,
  ResolveOutput,
  UpdateInput,
  UpdateOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(extras: {
  withTeams?: 'always-member' | 'never-member' | null;
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
      createAgentsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    displayName: 'My Agent',
    systemPrompt: 'You are helpful.',
    allowedTools: ['bash.run'],
    mcpConfigIds: [],
    model: 'claude-opus-4-7',
    visibility: 'personal',
    ...overrides,
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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
  if (container) await container.stop();
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
        'agents:list-ids',
        'agents:list-personal-owners',
      ],
      // database:get-instance + http:register-route + auth:require-user are
      // hard. teams:is-member is graceful (handled inside checkAccess via
      // try/catch) and intentionally NOT declared in calls.
      calls: ['database:get-instance', 'http:register-route', 'auth:require-user'],
      subscribes: ['bootstrap:reset-cleanup'],
    });
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
