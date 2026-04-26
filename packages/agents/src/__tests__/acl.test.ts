import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { HookBus, PluginError, makeChatContext } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createTeamsPlugin } from '@ax/teams';
import type {
  AddMemberInput,
  AddMemberOutput,
  CreateTeamInput,
  CreateTeamOutput,
  RemoveMemberInput,
  RemoveMemberOutput,
} from '@ax/teams';
import { checkAccess } from '../acl.js';
import { createAgentsPlugin } from '../plugin.js';
import type {
  Agent,
  AgentInput,
  CreateInput,
  CreateOutput,
  ResolveInput,
  ResolveOutput,
} from '../types.js';

function makePersonalAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agt_x',
    ownerId: 'u1',
    ownerType: 'user',
    visibility: 'personal',
    displayName: 'A',
    systemPrompt: '',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'claude-opus-4-7',
    workspaceRef: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTeamAgent(overrides: Partial<Agent> = {}): Agent {
  return makePersonalAgent({
    ownerType: 'team',
    visibility: 'team',
    ownerId: 't1',
    ...overrides,
  });
}

function ctx() {
  return makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u1',
  });
}

describe('checkAccess', () => {
  it('personal: owner matches → allowed', async () => {
    const bus = new HookBus();
    const result = await checkAccess(makePersonalAgent(), 'u1', bus, ctx());
    expect(result).toEqual({ allowed: true });
  });

  it('personal: owner mismatch → forbidden', async () => {
    const bus = new HookBus();
    const result = await checkAccess(makePersonalAgent(), 'someone-else', bus, ctx());
    expect(result).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('team: teams:is-member returns true → allowed', async () => {
    const bus = new HookBus();
    bus.registerService<{ teamId: string; userId: string }, { member: boolean }>(
      'teams:is-member',
      'mock',
      async (_c, { teamId, userId }) => {
        expect(teamId).toBe('t1');
        expect(userId).toBe('u1');
        return { member: true };
      },
    );
    const result = await checkAccess(makeTeamAgent(), 'u1', bus, ctx());
    expect(result).toEqual({ allowed: true });
  });

  it('team: teams:is-member returns false → forbidden', async () => {
    const bus = new HookBus();
    bus.registerService<{ teamId: string; userId: string }, { member: boolean }>(
      'teams:is-member',
      'mock',
      async () => ({ member: false }),
    );
    const result = await checkAccess(makeTeamAgent(), 'u1', bus, ctx());
    expect(result).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('team: NO teams:is-member registered → forbidden + warns once', async () => {
    const bus = new HookBus();
    const warned: string[] = [];
    const c = makeChatContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u1',
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg) => warned.push(msg),
        error: () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => undefined as any }) as any,
      },
    });
    const warnState = { warned: false };
    const r1 = await checkAccess(makeTeamAgent(), 'u1', bus, c, { warnState });
    const r2 = await checkAccess(makeTeamAgent(), 'u1', bus, c, { warnState });
    expect(r1).toEqual({ allowed: false, reason: 'forbidden' });
    expect(r2).toEqual({ allowed: false, reason: 'forbidden' });
    // warnState exists to assert exactly-once warning behavior even across
    // multiple calls within the same test.
    expect(warnState.warned).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toBe('agents_acl_team_check_unavailable');
  });

  it('schema-illegal: owner_type=user with visibility=team → forbidden', async () => {
    const bus = new HookBus();
    // The DB CHECK constraint should make this row impossible, but if it
    // ever reaches runtime (raw SQL bypass), we deny defensively.
    const weird = makePersonalAgent({ visibility: 'team' });
    const result = await checkAccess(weird, 'u1', bus, ctx());
    expect(result).toEqual({ allowed: false, reason: 'forbidden' });
  });
});

// ---------------------------------------------------------------------------
// Team-agent ACL with a REAL @ax/teams plugin
//
// Task 5's checkAccess call to `teams:is-member` was previously stubbed —
// the unit tests above mock the hook directly. Task 14 closes the loop:
// we boot @ax/teams + @ax/agents + @ax/database-postgres against a
// testcontainer postgres and exercise the team branch end-to-end.
//
// We deliberately go through the agents:resolve service hook (not the
// raw checkAccess function) because that's the path real callers take —
// and because @ax/agents owns its own membership lookup inside resolve.
// If we tested checkAccess directly with the real teams plugin, we'd
// duplicate the resolve test instead of exercising the production path.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeIntegrationHarness(): Promise<TestHarness> {
  // The agents plugin declares HTTP-side calls (http:register-route +
  // auth:require-user) for its admin routes. These tests don't exercise
  // the HTTP surface, so stub them to satisfy verifyCalls without booting
  // a TCP listener. (Same approach as plugin.test.ts.)
  const h = await createTestHarness({
    services: {
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => {
        throw new Error('auth:require-user mock not configured for acl.test.ts');
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createTeamsPlugin(),
      createAgentsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

function teamAgentInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    displayName: 'Team Agent',
    systemPrompt: 'For the team.',
    allowedTools: ['bash.run'],
    mcpConfigIds: [],
    model: 'claude-opus-4-7',
    visibility: 'team',
    teamId: 'unset',
    ...overrides,
  };
}

describe('@ax/agents acl with @ax/teams loaded', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    connectionString = container.getConnectionUri();
  });

  afterEach(async () => {
    while (harnesses.length > 0) {
      const h = harnesses.pop()!;
      await h.close({ onError: () => {} });
    }
    // Drop tables between tests to keep cases isolated. Order matters
    // only for documentation — we have no FKs (Invariant I4), but the
    // logical ownership is memberships → teams.
    const cleanup = new (await import('pg')).default.Client({ connectionString });
    await cleanup.connect();
    try {
      await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
      await cleanup.query('DROP TABLE IF EXISTS teams_v1_memberships');
      await cleanup.query('DROP TABLE IF EXISTS teams_v1_teams');
    } finally {
      await cleanup.end().catch(() => {});
    }
  });

  afterAll(async () => {
    if (container) await container.stop();
  });

  it('resolves a team agent for a team member', async () => {
    const h = await makeIntegrationHarness();
    // userA creates the team → becomes admin → adds userB as member.
    const { team } = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'userA' }, displayName: 'Squad' },
    );
    await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      {
        actor: { userId: 'userA' },
        teamId: team.id,
        userId: 'userB',
        role: 'member',
      },
    );

    // userA (team admin, hence a member) creates a team-visibility agent.
    const { agent } = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      h.ctx({ userId: 'userA' }),
      {
        actor: { userId: 'userA', isAdmin: false },
        input: teamAgentInput({ teamId: team.id }),
      },
    );
    expect(agent.ownerType).toBe('team');
    expect(agent.ownerId).toBe(team.id);

    // userB resolves it via the real team-membership branch.
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'agents:resolve',
      h.ctx({ userId: 'userB' }),
      { agentId: agent.id, userId: 'userB' },
    );
    expect(resolved.agent.id).toBe(agent.id);
    expect(resolved.agent.visibility).toBe('team');
  });

  it('forbids a team agent for a non-member', async () => {
    const h = await makeIntegrationHarness();
    const { team } = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'userA' }, displayName: 'Squad' },
    );
    const { agent } = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      h.ctx({ userId: 'userA' }),
      {
        actor: { userId: 'userA', isAdmin: false },
        input: teamAgentInput({ teamId: team.id }),
      },
    );

    // userC was never added — team membership lookup returns false →
    // resolve denies with 'forbidden'.
    let caught: unknown;
    try {
      await h.bus.call<ResolveInput, ResolveOutput>(
        'agents:resolve',
        h.ctx({ userId: 'userC' }),
        { agentId: agent.id, userId: 'userC' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('forbidden');
  });

  it('forbids a team agent after the user is removed from the team', async () => {
    const h = await makeIntegrationHarness();
    const { team } = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'userA' }, displayName: 'Squad' },
    );
    await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      {
        actor: { userId: 'userA' },
        teamId: team.id,
        userId: 'userB',
        role: 'member',
      },
    );
    const { agent } = await h.bus.call<CreateInput, CreateOutput>(
      'agents:create',
      h.ctx({ userId: 'userA' }),
      {
        actor: { userId: 'userA', isAdmin: false },
        input: teamAgentInput({ teamId: team.id }),
      },
    );

    // Sanity: while userB is a member, resolve succeeds.
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'agents:resolve',
      h.ctx({ userId: 'userB' }),
      { agentId: agent.id, userId: 'userB' },
    );
    expect(resolved.agent.id).toBe(agent.id);

    // Remove userB; resolve must now deny. This is the test the cached-
    // membership-bug regression would fail: if checkAccess kept any state
    // beyond the per-call bus.call, removed users could keep reading
    // team agents.
    await h.bus.call<RemoveMemberInput, RemoveMemberOutput>(
      'teams:remove-member',
      h.ctx(),
      { actor: { userId: 'userA' }, teamId: team.id, userId: 'userB' },
    );

    let caught: unknown;
    try {
      await h.bus.call<ResolveInput, ResolveOutput>(
        'agents:resolve',
        h.ctx({ userId: 'userB' }),
        { agentId: agent.id, userId: 'userB' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('forbidden');
  });
});
