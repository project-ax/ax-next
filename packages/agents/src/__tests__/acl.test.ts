import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { HookBus, PluginError, makeAgentContext, type Logger } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
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
import { checkAccess, isAgentOwner, isAxAccount } from '../acl.js';
import { createAgentsPlugin } from '../plugin.js';
import type {
  Agent,
  AgentInput,
  AudienceKind,
  CallerFacts,
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
    audience: 'just-me',
    shared: false,
    displayName: 'A',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'anthropic/claude-opus-4-7',
    runner: 'claude-sdk',
    skillAttachments: [],
    connectorAttachments: [],
    connectorExclusions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTeamAgent(overrides: Partial<Agent> = {}): Agent {
  // A team agent has no audience (its members use it), and is always shared.
  const { audience: _none, ...personal } = makePersonalAgent();
  return {
    ...personal,
    ownerType: 'team',
    visibility: 'team',
    ownerId: 't1',
    shared: true,
    ...overrides,
  };
}

function ctx() {
  return makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u1',
  });
}

/** A ctx whose logger keeps every warning, by message. */
function recordingCtx(): { ctx: ReturnType<typeof makeAgentContext>; warned: string[] } {
  const warned: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => warned.push(msg),
    error: () => {},
    child: () => logger,
  };
  return { ctx: makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1', logger }), warned };
}

/**
 * A fake `SharingStore.callerFacts`: fixed facts per user id (no row → both
 * false), and every question it was asked, as `[agentId, userId]`.
 */
function factsOf(byUser: Record<string, Partial<CallerFacts>> = {}): {
  callerFacts: (agentId: string, userId: string) => Promise<CallerFacts>;
  asked: Array<[string, string]>;
} {
  const asked: Array<[string, string]> = [];
  return {
    asked,
    callerFacts: async (agentId, userId) => {
      asked.push([agentId, userId]);
      return { owner: false, listed: false, ...byUser[userId] };
    },
  };
}

/**
 * A bus whose `auth:get-user` answers like @ax/auth-better: a user for an id
 * in `accounts`, null for anyone else. `asked` is every id it was asked about.
 */
function authBus(accounts: readonly string[]): { bus: HookBus; asked: string[] } {
  const bus = new HookBus();
  const asked: string[] = [];
  bus.registerService<{ userId: string }, unknown>('auth:get-user', 'mock', async (_c, { userId }) => {
    asked.push(userId);
    return accounts.includes(userId)
      ? { id: userId, email: `${userId}@example.com`, displayName: userId, isAdmin: false }
      : null;
  });
  return { bus, asked };
}

const OWNER = { allowed: true, owner: true };
const USER = { allowed: true, owner: false };
const FORBIDDEN = { allowed: false, reason: 'forbidden' };

describe('checkAccess', () => {
  // TASK-1246 — a personal agent: its owners, then its audience.

  it('personal: an owner row → allowed, owner true', async () => {
    // u2 is not the creator (u1) and the audience is just-me: the row alone admits them.
    const { callerFacts, asked } = factsOf({ u2: { owner: true } });
    const result = await checkAccess(makePersonalAgent(), 'u2', new HookBus(), ctx(), { callerFacts });
    expect(result).toEqual(OWNER);
    expect(asked).toEqual([['agt_x', 'u2']]);
  });

  it('personal: the creator with no owner row → forbidden', async () => {
    // The owners table is the one source of truth: `ownerId` alone admits nobody.
    const { callerFacts } = factsOf();
    const result = await checkAccess(makePersonalAgent({ ownerId: 'u1' }), 'u1', new HookBus(), ctx(), {
      callerFacts,
    });
    expect(result).toEqual(FORBIDDEN);
  });

  it('personal just-me: a non-owner → forbidden, and auth:get-user is never called', async () => {
    const { bus, asked } = authBus(['u2']);
    const { callerFacts } = factsOf();
    const result = await checkAccess(makePersonalAgent(), 'u2', bus, ctx(), { callerFacts });
    expect(result).toEqual(FORBIDDEN);
    expect(asked).toEqual([]);
  });

  it('personal just-me: a listed flag without the list audience → forbidden', async () => {
    // A member row that outlived its list (Review Focus 5) grants nothing.
    const { callerFacts } = factsOf({ u2: { listed: true } });
    const result = await checkAccess(makePersonalAgent({ audience: 'just-me' }), 'u2', new HookBus(), ctx(), {
      callerFacts,
    });
    expect(result).toEqual(FORBIDDEN);
  });

  it('personal list: listed → allowed owner false; not listed → forbidden', async () => {
    const agent = makePersonalAgent({ audience: 'list', shared: true });
    const { bus, asked } = authBus(['u2', 'u3']);
    const { callerFacts } = factsOf({ u2: { listed: true } });
    expect(await checkAccess(agent, 'u2', bus, ctx(), { callerFacts })).toEqual(USER);
    expect(await checkAccess(agent, 'u3', bus, ctx(), { callerFacts })).toEqual(FORBIDDEN);
    // A list names people; it never asks whether someone is an AX account.
    expect(asked).toEqual([]);
  });

  it("personal everyone: an AX account → allowed; auth:get-user null → forbidden; 'ownerless:s1' and '' → forbidden with no lookup; 'system' unknown to auth → forbidden", async () => {
    const agent = makePersonalAgent({ audience: 'everyone', shared: true });
    const { bus, asked } = authBus(['carol']);
    const { callerFacts, asked: factsAsked } = factsOf();
    expect(await checkAccess(agent, 'carol', bus, ctx(), { callerFacts })).toEqual(USER);
    expect(await checkAccess(agent, 'ghost', bus, ctx(), { callerFacts })).toEqual(FORBIDDEN);
    expect(await checkAccess(agent, 'ownerless:s1', bus, ctx(), { callerFacts })).toEqual(FORBIDDEN);
    expect(await checkAccess(agent, '', bus, ctx(), { callerFacts })).toEqual(FORBIDDEN);
    expect(await checkAccess(agent, 'system', bus, ctx(), { callerFacts })).toEqual(FORBIDDEN);
    // Neither stand-in is ever looked up; the empty id isn't even checked for owner rows.
    expect(asked).toEqual(['carol', 'ghost', 'system']);
    expect(factsAsked.map(([, u]) => u)).toEqual(['carol', 'ghost', 'ownerless:s1', 'system']);
  });

  it('personal everyone: an owner is allowed without an account lookup', async () => {
    const agent = makePersonalAgent({ audience: 'everyone', shared: true });
    const { bus, asked } = authBus(['u2']);
    const { callerFacts } = factsOf({ u2: { owner: true } });
    expect(await checkAccess(agent, 'u2', bus, ctx(), { callerFacts })).toEqual(OWNER);
    expect(asked).toEqual([]);
  });

  it('personal everyone: no auth:get-user → forbidden and warns once', async () => {
    const agent = makePersonalAgent({ audience: 'everyone', shared: true });
    const { ctx: c, warned } = recordingCtx();
    const { callerFacts } = factsOf({ owner1: { owner: true } });
    const accountWarnState = { warned: false };
    const bus = new HookBus();
    const r1 = await checkAccess(agent, 'carol', bus, c, { callerFacts, accountWarnState });
    const r2 = await checkAccess(agent, 'dave', bus, c, { callerFacts, accountWarnState });
    expect(r1).toEqual(FORBIDDEN);
    expect(r2).toEqual(FORBIDDEN);
    expect(accountWarnState.warned).toBe(true);
    expect(warned).toEqual(['agents_acl_account_check_unavailable']);
    // Its owners still use it.
    expect(await checkAccess(agent, 'owner1', bus, c, { callerFacts, accountWarnState })).toEqual(OWNER);
  });

  it('personal everyone: auth:get-user throws → rejects (not forbidden)', async () => {
    const agent = makePersonalAgent({ audience: 'everyone', shared: true });
    const bus = new HookBus();
    bus.registerService('auth:get-user', 'mock', async () => {
      throw new Error('auth database unreachable');
    });
    const { callerFacts } = factsOf();
    await expect(checkAccess(agent, 'carol', bus, ctx(), { callerFacts })).rejects.toThrow(
      /auth database unreachable/,
    );
  });

  it('an unknown audience: the owner is allowed, a non-owner is forbidden', async () => {
    const { bus, asked } = authBus(['u2', 'u3']);
    const { callerFacts } = factsOf({ u2: { owner: true }, u3: { listed: true } });
    for (const bogus of ['friends', 'EVERYONE', '', undefined]) {
      const agent = makePersonalAgent({ audience: bogus as unknown as AudienceKind });
      expect(await checkAccess(agent, 'u2', bus, ctx(), { callerFacts }), String(bogus)).toEqual(OWNER);
      expect(await checkAccess(agent, 'u3', bus, ctx(), { callerFacts }), String(bogus)).toEqual(FORBIDDEN);
    }
    expect(asked).toEqual([]);
  });

  it('personal: a malformed owner type → forbidden, even with an owner row', async () => {
    // The DB pairing CHECK makes this row impossible; deny it if it ever exists.
    const { callerFacts, asked } = factsOf({ u1: { owner: true } });
    const weird = makePersonalAgent({ ownerType: 'team' });
    expect(await checkAccess(weird, 'u1', new HookBus(), ctx(), { callerFacts })).toEqual(FORBIDDEN);
    expect(asked).toEqual([]);
  });

  it('team: teams:is-member returns true → allowed, owner false, without reading the sharing rows', async () => {
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
    const { callerFacts, asked } = factsOf({ u1: { owner: true } });
    const result = await checkAccess(makeTeamAgent(), 'u1', bus, ctx(), { callerFacts });
    expect(result).toEqual(USER);
    expect(asked).toEqual([]);
  });

  it('team: teams:is-member returns false → forbidden', async () => {
    const bus = new HookBus();
    bus.registerService<{ teamId: string; userId: string }, { member: boolean }>(
      'teams:is-member',
      'mock',
      async () => ({ member: false }),
    );
    const { callerFacts } = factsOf({ u1: { owner: true, listed: true } });
    const result = await checkAccess(makeTeamAgent(), 'u1', bus, ctx(), { callerFacts });
    expect(result).toEqual(FORBIDDEN);
  });

  it('team: NO teams:is-member registered → forbidden + warns once', async () => {
    const bus = new HookBus();
    const { ctx: c, warned } = recordingCtx();
    const { callerFacts } = factsOf();
    const warnState = { warned: false };
    const r1 = await checkAccess(makeTeamAgent(), 'u1', bus, c, { callerFacts, warnState });
    const r2 = await checkAccess(makeTeamAgent(), 'u1', bus, c, { callerFacts, warnState });
    expect(r1).toEqual(FORBIDDEN);
    expect(r2).toEqual(FORBIDDEN);
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
    const { callerFacts } = factsOf({ u1: { owner: true } });
    const result = await checkAccess(weird, 'u1', bus, ctx(), { callerFacts });
    expect(result).toEqual(FORBIDDEN);
  });
});

describe('isAxAccount', () => {
  it('is true only for an answer that is an object carrying the same id', async () => {
    const bus = new HookBus();
    const answers: Record<string, unknown> = {
      alice: { id: 'alice', email: 'alice@example.com', displayName: 'Alice', isAdmin: false },
      // An answer about someone else, or not an account at all, proves nothing.
      mallory: { id: 'alice' },
      noid: { email: 'noid@example.com' },
      text: 'text',
      yes: true,
    };
    bus.registerService<{ userId: string }, unknown>('auth:get-user', 'mock', async (_c, { userId }) =>
      userId in answers ? answers[userId] : null,
    );
    expect(await isAxAccount(bus, ctx(), 'alice')).toBe(true);
    for (const id of ['mallory', 'noid', 'text', 'yes', 'ghost']) {
      expect(await isAxAccount(bus, ctx(), id), id).toBe(false);
    }
  });

  it("refuses '' and an ownerless stand-in without asking", async () => {
    const { bus, asked } = authBus(['', 'ownerless:s1']);
    expect(await isAxAccount(bus, ctx(), '')).toBe(false);
    expect(await isAxAccount(bus, ctx(), 'ownerless:s1')).toBe(false);
    expect(asked).toEqual([]);
  });

  it('with no auth:get-user: false, warned once per warn state', async () => {
    const { ctx: c, warned } = recordingCtx();
    const warnState = { warned: false };
    expect(await isAxAccount(new HookBus(), c, 'carol', { warnState })).toBe(false);
    expect(await isAxAccount(new HookBus(), c, 'dave', { warnState })).toBe(false);
    expect(warned).toEqual(['agents_acl_account_check_unavailable']);
  });

  it('a no-service fault from deeper inside auth:get-user propagates', async () => {
    // Only auth:get-user itself being absent reads as "can't check". A broken
    // auth plugin is an outage, not a quiet deny.
    const bus = new HookBus();
    bus.registerService('auth:get-user', 'mock', async () => {
      throw new PluginError({ code: 'no-service', plugin: 'core', hookName: 'database:get-instance', message: 'gone' });
    });
    await expect(isAxAccount(bus, ctx(), 'carol')).rejects.toMatchObject({ code: 'no-service' });
  });
});

describe('isAgentOwner', () => {
  it('is true only for a personal agent with an owner row for a non-empty user id', async () => {
    const { callerFacts, asked } = factsOf({ u2: { owner: true }, u3: { listed: true }, '': { owner: true } });
    expect(await isAgentOwner(makePersonalAgent(), 'u2', callerFacts)).toBe(true);
    expect(await isAgentOwner(makePersonalAgent({ audience: 'list' }), 'u3', callerFacts)).toBe(false);
    // The creator with no owner row is not an owner.
    expect(await isAgentOwner(makePersonalAgent(), 'u1', callerFacts)).toBe(false);
    expect(await isAgentOwner(makePersonalAgent(), '', callerFacts)).toBe(false);
    // Always false on a team agent, whatever the rows say.
    expect(await isAgentOwner(makeTeamAgent(), 'u2', callerFacts)).toBe(false);
    expect(asked).toEqual([
      ['agt_x', 'u2'],
      ['agt_x', 'u3'],
      ['agt_x', 'u1'],
    ]);
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
    allowedTools: ['bash.run'],
    mcpConfigIds: [],
    model: 'anthropic/claude-opus-4-7',
    visibility: 'team',
    teamId: 'unset',
    ...overrides,
  };
}

describe('@ax/agents acl with @ax/teams loaded', () => {
  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = container.getConnectionUri();
  }, 120_000);

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
    if (container) await stopPostgresContainer(container);
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
