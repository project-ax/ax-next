import { describe, expect, it, vi } from 'vitest';
import { createLogger, HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import {
  AUDIENCE_MEMBERS_MAX,
  OWNERS_MAX,
  createSharingService,
  type SharingService,
} from '../sharing/service.js';
import type { SharingStore } from '../sharing/store.js';
import type { Actor, Agent, AgentAudience } from '../types.js';

// ---------------------------------------------------------------------------
// TASK-1246 — the sharing service on its own, over an in-memory store and a
// bare hook bus. No Docker. admin-routes-sharing.test.ts drives the same rules
// through the real HTTP stack; this file covers what that stack can't reach:
// a missing or failing `auth:get-user`, a delete that races a write, the log
// lines, and the settings view's names when a lookup fails.
// ---------------------------------------------------------------------------

const ACCOUNTS: Record<string, { displayName: string; email: string }> = {
  alice: { displayName: 'Alice', email: 'alice@example.com' },
  bob: { displayName: 'Bob', email: 'bob@example.com' },
  carol: { displayName: 'Carol', email: 'carol@example.com' },
};

const alice: Actor = { userId: 'alice', isAdmin: false };
const bob: Actor = { userId: 'bob', isAdmin: false };
const admin: Actor = { userId: 'wsadmin', isAdmin: true };

function personalAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agt_1',
    ownerId: 'alice',
    ownerType: 'user',
    visibility: 'personal',
    audience: 'just-me',
    shared: false,
    displayName: 'Fern',
    allowedTools: ['bash.run'],
    mcpConfigIds: [],
    model: 'anthropic/claude-opus-4-7',
    runner: 'claude-sdk',
    skillAttachments: [],
    connectorAttachments: [],
    connectorExclusions: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** `agent` with no audience at all, as a team agent reads. */
function withoutAudience(agent: Agent): Agent {
  const { audience: _audience, ...rest } = agent;
  return rest;
}

/** One agent's sharing rows, in memory, with the same contract as the real store. */
function memoryStore(agent: Agent, owners: string[] = [agent.ownerId]) {
  const state = { agent: agent as Agent | null, owners: [...owners], members: [] as string[], writes: 0 };
  const sharing: SharingStore = {
    async callerFacts(agentId, userId) {
      const here = state.agent !== null && agentId === state.agent.id;
      return { owner: here && state.owners.includes(userId), listed: here && state.members.includes(userId) };
    },
    async listOwners() {
      return [...state.owners];
    },
    async listMembers() {
      return state.members.map((id) => ({ type: 'user' as const, id }));
    },
    async setAudience(_agentId, audience: AgentAudience) {
      state.writes += 1;
      state.agent = { ...state.agent!, audience: audience.kind, shared: audience.kind !== 'just-me' };
      state.members = audience.kind === 'list' ? audience.members.map((m) => m.id) : [];
    },
    async setOwners(_agentId, userIds) {
      state.writes += 1;
      state.owners = [...userIds];
    },
  };
  const agents = { getById: async (id: string) => (state.agent?.id === id ? state.agent : null) };
  return { state, sharing, agents };
}

/** A bus whose `auth:get-user` knows ACCOUNTS, unless `getUser` replaces it (null: no hook). */
function busWith(
  getUser: ((userId: string) => Promise<unknown>) | null = async (userId) =>
    ACCOUNTS[userId] !== undefined ? { id: userId, isAdmin: false, ...ACCOUNTS[userId] } : null,
) {
  const bus = new HookBus();
  const asked: string[] = [];
  if (getUser !== null) {
    bus.registerService<{ userId: string }, unknown>('auth:get-user', 'test', async (_ctx, input) => {
      asked.push(input.userId);
      return getUser(input.userId);
    });
  }
  return { bus, asked };
}

function ctxWithLog(): { ctx: AgentContext; lines: () => Array<Record<string, unknown>> } {
  const raw: string[] = [];
  const ctx = makeAgentContext({
    sessionId: 'agents-admin',
    agentId: '@ax/agents',
    userId: 'admin',
    logger: createLogger({ reqId: 'req-test', writer: (line) => raw.push(line) }),
  });
  return { ctx, lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function service(bus: HookBus, store: ReturnType<typeof memoryStore>): SharingService {
  return createSharingService({ bus, agents: store.agents, sharing: store.sharing });
}

describe('sharing service', () => {
  it('caps a list at 50 people and the owners at 10', () => {
    expect(AUDIENCE_MEMBERS_MAX).toBe(50);
    expect(OWNERS_MAX).toBe(10);
  });

  it('a write that names a person answers 503 accounts-unavailable without auth:get-user, and writes nothing', async () => {
    const store = memoryStore(personalAgent());
    const svc = service(busWith(null).bus, store);
    const { ctx } = ctxWithLog();

    expect(
      await svc.setAudience(ctx, alice, 'agt_1', { kind: 'list', members: [{ type: 'user', id: 'bob' }] }),
    ).toEqual({ status: 503, error: 'accounts-unavailable' });
    expect(await svc.setOwners(ctx, alice, 'agt_1', { userIds: ['alice', 'bob'] })).toEqual({
      status: 503,
      error: 'accounts-unavailable',
    });
    expect(store.state.writes).toBe(0);
  });

  it('a write that names nobody but the creator needs no auth:get-user', async () => {
    const store = memoryStore(personalAgent(), ['alice', 'bob']);
    const svc = service(busWith(null).bus, store);
    const { ctx } = ctxWithLog();

    expect((await svc.setAudience(ctx, alice, 'agt_1', { kind: 'everyone' })).status).toBe(200);
    expect(
      (await svc.setAudience(ctx, alice, 'agt_1', { kind: 'list', members: [{ type: 'user', id: 'alice' }] }))
        .status,
    ).toBe(200);
    expect((await svc.setOwners(ctx, alice, 'agt_1', { userIds: ['alice'] })).status).toBe(200);
    expect(store.state.owners).toEqual(['alice']);
  });

  it('an auth:get-user that throws propagates: never a 400 or a 503, and nothing is written', async () => {
    const store = memoryStore(personalAgent());
    const svc = service(busWith(async () => Promise.reject(new Error('auth store down'))).bus, store);
    const { ctx } = ctxWithLog();
    // The bus wraps a handler's plain throw; what matters is that it arrives.
    const outage = { name: 'PluginError', hookName: 'auth:get-user', message: expect.stringContaining('auth store down') };

    await expect(
      svc.setAudience(ctx, alice, 'agt_1', { kind: 'list', members: [{ type: 'user', id: 'bob' }] }),
    ).rejects.toMatchObject(outage);
    await expect(svc.setOwners(ctx, alice, 'agt_1', { userIds: ['alice', 'bob'] })).rejects.toMatchObject(outage);
    expect(store.state.writes).toBe(0);
  });

  it('an owner-less id is unknown-person without a lookup; the first unknown id is named', async () => {
    const store = memoryStore(personalAgent());
    const { bus, asked } = busWith();
    const svc = service(bus, store);
    const { ctx } = ctxWithLog();

    expect(
      await svc.setAudience(ctx, alice, 'agt_1', {
        kind: 'list',
        members: [
          { type: 'user', id: 'bob' },
          { type: 'user', id: 'ownerless:s1' },
          { type: 'user', id: 'ghost' },
        ],
      }),
    ).toEqual({ status: 400, error: 'unknown-person', id: 'ownerless:s1' });
    expect(asked).toEqual(['bob']);
    expect(await svc.setOwners(ctx, alice, 'agt_1', { userIds: ['alice', 'ghost', 'carol'] })).toEqual({
      status: 400,
      error: 'unknown-person',
      id: 'ghost',
    });
    expect(store.state.writes).toBe(0);
  });

  it('the owner check comes before the body: a non-owner, a workspace admin among them, gets 403 whatever they send', async () => {
    const store = memoryStore(personalAgent({ audience: 'everyone', shared: true }));
    const { bus, asked } = busWith();
    const svc = service(bus, store);
    const { ctx } = ctxWithLog();

    for (const actor of [bob, admin]) {
      for (const body of [{ kind: 'everyone' }, { kind: 'friends' }, null]) {
        expect(await svc.setAudience(ctx, actor, 'agt_1', body)).toEqual({ status: 403, error: 'forbidden' });
      }
      for (const body of [{ userIds: ['alice', actor.userId] }, { userIds: [] }, 'x']) {
        expect(await svc.setOwners(ctx, actor, 'agt_1', body)).toEqual({ status: 403, error: 'forbidden' });
      }
    }
    expect(asked).toEqual([]);
    expect(store.state.writes).toBe(0);
  });

  it('a team agent: 403 team-agent for a member, 403 forbidden for anyone else; nothing is written', async () => {
    const store = memoryStore(
      withoutAudience(personalAgent({ ownerId: 'team-1', ownerType: 'team', visibility: 'team', shared: true })),
      [],
    );
    const { bus } = busWith();
    bus.registerService('teams:is-member', 'test', async (_ctx, input: unknown) => ({
      member: (input as { userId: string }).userId === 'bob',
    }));
    const svc = service(bus, store);
    const { ctx } = ctxWithLog();

    expect(await svc.setAudience(ctx, bob, 'agt_1', { kind: 'everyone' })).toEqual({ status: 403, error: 'team-agent' });
    expect(await svc.setOwners(ctx, bob, 'agt_1', { userIds: ['bob'] })).toEqual({ status: 403, error: 'team-agent' });
    expect(await svc.setAudience(ctx, admin, 'agt_1', { kind: 'everyone' })).toEqual({ status: 403, error: 'forbidden' });
    expect(store.state.writes).toBe(0);
  });

  it('an unknown agent, or one deleted before the write lands, answers 404 not-found', async () => {
    const store = memoryStore(personalAgent());
    const svc = service(busWith().bus, store);
    const { ctx } = ctxWithLog();
    expect(await svc.setAudience(ctx, alice, 'agt_nope', { kind: 'everyone' })).toEqual({
      status: 404,
      error: 'not-found',
    });

    const gone = () =>
      Promise.reject(new PluginError({ code: 'not-found', plugin: '@ax/agents', message: "agent 'agt_1' not found" }));
    store.sharing.setAudience = vi.fn(gone);
    store.sharing.setOwners = vi.fn(gone);
    expect(await svc.setAudience(ctx, alice, 'agt_1', { kind: 'everyone' })).toEqual({ status: 404, error: 'not-found' });
    expect(await svc.setOwners(ctx, alice, 'agt_1', { userIds: ['alice', 'bob'] })).toEqual({
      status: 404,
      error: 'not-found',
    });
  });

  it('any other store failure propagates', async () => {
    const store = memoryStore(personalAgent());
    const broken = new Error('connection reset');
    store.sharing.setAudience = vi.fn(() => Promise.reject(broken));
    const svc = service(busWith().bus, store);
    const { ctx } = ctxWithLog();
    await expect(svc.setAudience(ctx, alice, 'agt_1', { kind: 'everyone' })).rejects.toBe(broken);
  });

  it('a write logs counts and who wrote it, never the people it names', async () => {
    const store = memoryStore(personalAgent());
    const svc = service(busWith().bus, store);
    const { ctx, lines } = ctxWithLog();

    await svc.setAudience(ctx, alice, 'agt_1', {
      kind: 'list',
      members: [
        { type: 'user', id: 'bob' },
        { type: 'user', id: 'carol' },
      ],
    });
    await svc.setOwners(ctx, alice, 'agt_1', { userIds: ['alice', 'bob'] });

    const audienceSet = lines().find((l) => l.msg === 'agents_sharing_audience_set');
    expect(audienceSet).toMatchObject({ agentId: 'agt_1', kind: 'list', members: 2, by: 'alice' });
    const ownersSet = lines().find((l) => l.msg === 'agents_sharing_owners_set');
    expect(ownersSet).toMatchObject({ agentId: 'agt_1', owners: 2, by: 'alice' });
    for (const line of [audienceSet, ownersSet]) {
      const text = JSON.stringify(line);
      for (const leak of ['bob', 'carol', '@example.com', 'Bob', 'Carol']) expect(text).not.toContain(leak);
    }
  });

  it('a write answers the settings as they now read, creator first', async () => {
    const store = memoryStore(personalAgent());
    const svc = service(busWith().bus, store);
    const { ctx } = ctxWithLog();

    expect(await svc.setOwners(ctx, alice, 'agt_1', { userIds: ['bob', 'alice'] })).toEqual({
      status: 200,
      sharing: {
        audience: { kind: 'just-me' },
        owners: [
          { id: 'alice', displayName: 'Alice', email: 'alice@example.com', creator: true },
          { id: 'bob', displayName: 'Bob', email: 'bob@example.com', creator: false },
        ],
      },
    });
    expect(
      await svc.setAudience(ctx, bob, 'agt_1', { kind: 'list', members: [{ type: 'user', id: 'carol' }] }),
    ).toEqual({
      status: 200,
      sharing: {
        audience: {
          kind: 'list',
          members: [{ type: 'user', id: 'carol', displayName: 'Carol', email: 'carol@example.com' }],
        },
        owners: [
          { id: 'alice', displayName: 'Alice', email: 'alice@example.com', creator: true },
          { id: 'bob', displayName: 'Bob', email: 'bob@example.com', creator: false },
        ],
      },
    });
  });

  describe('view', () => {
    it.each([
      ['a null answer', async () => null],
      ['an answer for someone else', async () => ({ id: 'mallory', displayName: 'M', email: 'm@example.com' })],
      ['a throw', async () => Promise.reject(new Error('timeout talking to bob@example.com'))],
    ])('reads %s as null names and never fails', async (_label, answer) => {
      const store = memoryStore(personalAgent({ audience: 'list', shared: true }), ['alice', 'bob']);
      store.state.members = ['bob'];
      const svc = service(busWith(answer).bus, store);
      const { ctx } = ctxWithLog();

      expect(await svc.view(ctx, store.state.agent!)).toEqual({
        audience: { kind: 'list', members: [{ type: 'user', id: 'bob', displayName: null, email: null }] },
        owners: [
          { id: 'alice', displayName: null, email: null, creator: true },
          { id: 'bob', displayName: null, email: null, creator: false },
        ],
      });
    });

    it('without auth:get-user, reads every name as null and warns once per read by error name and code only', async () => {
      const store = memoryStore(personalAgent(), ['alice', 'bob']);
      const svc = service(busWith(null).bus, store);
      const { ctx, lines } = ctxWithLog();

      const sharing = await svc.view(ctx, store.state.agent!);
      expect(sharing.owners.map((o) => [o.id, o.displayName, o.email])).toEqual([
        ['alice', null, null],
        ['bob', null, null],
      ]);
      const warns = lines().filter((l) => l.msg === 'agents_sharing_names_unavailable');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({ agentId: 'agt_1', failed: 2, errors: ['PluginError:no-service'] });
    });

    it("a lookup's error message never reaches the log", async () => {
      const store = memoryStore(personalAgent(), ['alice', 'bob']);
      const svc = service(busWith(async () => Promise.reject(new Error('lookup of bob@example.com failed'))).bus, store);
      const { ctx, lines } = ctxWithLog();

      await svc.view(ctx, store.state.agent!);
      const text = JSON.stringify(lines());
      expect(text).toContain('agents_sharing_names_unavailable');
      expect(text).not.toContain('bob@example.com');
    });

    it('puts the creator first whatever order the rows come back in, and looks each person up once', async () => {
      const store = memoryStore(personalAgent({ audience: 'list', shared: true }), ['bob', 'alice']);
      store.state.members = ['bob', 'carol'];
      const { bus, asked } = busWith();
      const svc = service(bus, store);
      const { ctx } = ctxWithLog();

      const sharing = await svc.view(ctx, store.state.agent!);
      expect(sharing.owners.map((o) => [o.id, o.creator])).toEqual([
        ['alice', true],
        ['bob', false],
      ]);
      expect([...asked].sort()).toEqual(['alice', 'bob', 'carol']);
    });

    it('fails closed on an agent with no audience its owners can set', async () => {
      const store = memoryStore(personalAgent());
      const svc = service(busWith().bus, store);
      const { ctx } = ctxWithLog();
      for (const agent of [
        personalAgent({ audience: 'friends' as never }),
        withoutAudience(personalAgent()),
        withoutAudience(personalAgent({ ownerType: 'team', visibility: 'team' })),
      ]) {
        await expect(svc.view(ctx, agent)).rejects.toMatchObject({ code: 'corrupt-row' });
      }
    });
  });
});
