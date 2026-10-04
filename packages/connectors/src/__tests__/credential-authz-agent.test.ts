import { describe, it, expect } from 'vitest';
import { makeAgentContext, PluginError, type AgentContext, type HookBus, type Logger } from '@ax/core';
import { authorizeAgentAccountRead } from '../credential-authz.js';
import type { AvailableConnector, ConnectorStore } from '../store.js';

// ---------------------------------------------------------------------------
// TASK-711 — the `credentials:authorize-agent:account` provider, as a pure
// function over a fake store (no database). The store's own selection rule
// (`getSoleSharedById`) is tested against real postgres in store.test.ts;
// this file pins what the provider does with the store's answer and with
// malformed input. Every case says what it does against an always-allow
// provider: the deny cases fail there, the allow case is the positive control.
//
// TASK-788 — a READ also requires the connector to be effective on the agent
// for this user (attached, or the user's own legacy row, minus exclusions),
// read through `agents:resolve`. Against the TASK-711 provider (shared check
// only) every `DENIES` case in the TASK-788 block below fails: it allowed any
// sole-shared connector whatever the agent carried. The end-to-end version,
// through the real vault and real postgres, is agent-credential-attachment.test.ts.
// ---------------------------------------------------------------------------

interface LogLine {
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function ctxWithLog(): { ctx: AgentContext; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger: Logger = {
    debug: (msg, bindings) => void lines.push({ msg, bindings }),
    info: (msg, bindings) => void lines.push({ msg, bindings }),
    warn: (msg, bindings) => void lines.push({ msg, bindings }),
    error: (msg, bindings) => void lines.push({ msg, bindings }),
    child: () => logger,
  };
  return {
    ctx: makeAgentContext({ sessionId: 's', agentId: 'team-agent', userId: 'u', logger }),
    lines,
  };
}

function row(
  id: string,
  ownerUserId: string,
  opts: { canEdit: boolean; requiresAttachment?: boolean },
): AvailableConnector {
  return {
    ownerUserId,
    connector: {
      id,
      name: id,
      description: '',
      usageNote: '',
      keyMode: 'personal',
      visibility: 'shared',
      capabilities: { allowedHosts: [], credentials: [], mcpServers: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      canEdit: opts.canEdit,
      ...(opts.requiresAttachment !== undefined ? { requiresAttachment: opts.requiresAttachment } : {}),
    } as unknown as AvailableConnector['connector'],
  };
}

/** The team's shared `linear`, owned by someone else, created after explicit attachment. */
const SHARED = row('linear', 'owner', { canEdit: false, requiresAttachment: true });

/**
 * A store with the reads the provider uses. `available` is what this user
 * resolves (`getAvailableById` / `listAvailable`); `sole` answers
 * `getSoleSharedById`. Every other call fails the test.
 */
function fakeStore(
  answer: (userId: string, connectorId: string) => Promise<AvailableConnector | null>,
  available: AvailableConnector[] = [SHARED],
): { store: ConnectorStore; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const fail = (): never => {
    throw new Error('unexpected store call');
  };
  const store = {
    listForUser: fail,
    getByIdNotDeleted: fail,
    upsert: fail,
    softDelete: fail,
    async getAvailableById(_userId: string, connectorId: string) {
      return available.find((a) => a.connector.id === connectorId) ?? null;
    },
    async listAvailable() {
      return available;
    },
    async getSoleSharedById(userId: string, connectorId: string) {
      calls.push([userId, connectorId]);
      return answer(userId, connectorId);
    },
  } as unknown as ConnectorStore;
  return { store, calls };
}

interface AgentFixture {
  connectorAttachments?: unknown;
  connectorExclusions?: unknown;
}

/** A bus whose only service is `agents:resolve` (or none). */
function fakeBus(
  resolve: ((input: { agentId: string; userId: string }) => unknown) | null,
): { bus: HookBus; resolveCalls: Array<{ agentId: string; userId: string }> } {
  const resolveCalls: Array<{ agentId: string; userId: string }> = [];
  const bus = {
    hasService: (name: string) => name === 'agents:resolve' && resolve !== null,
    async call(name: string, _ctx: AgentContext, input: { agentId: string; userId: string }) {
      if (name !== 'agents:resolve' || resolve === null) throw new Error(`unexpected call ${name}`);
      resolveCalls.push(input);
      return resolve(input);
    },
  } as unknown as HookBus;
  return { bus, resolveCalls };
}

const agentWith = (agent: AgentFixture) => fakeBus(() => ({ agent }));
const ATTACHED = agentWith({ connectorAttachments: ['linear'], connectorExclusions: [] });

describe('authorizeAgentAccountRead (TASK-711)', () => {
  it('ALLOWS (positive control) when the user resolves the one shared definition; asks about the id, not the slot', async () => {
    const { store, calls } = fakeStore(async () => SHARED);
    const { ctx } = ctxWithLog();
    expect(
      await authorizeAgentAccountRead(store, ATTACHED.bus, ctx, { userId: 'bob', agentId: 'team-agent', ref: 'account:linear' }),
    ).toEqual({ allowed: true });
    expect(
      await authorizeAgentAccountRead(store, ATTACHED.bus, ctx, { userId: 'bob', agentId: 'team-agent', ref: 'account:linear:API_TOKEN' }),
    ).toEqual({ allowed: true });
    expect(calls).toEqual([
      ['bob', 'linear'],
      ['bob', 'linear'],
    ]);
  });

  it('DENIES when the store says this user does not resolve the shared definition (shadowed, ambiguous or absent)', async () => {
    const { store, calls } = fakeStore(async () => null);
    const { ctx, lines } = ctxWithLog();
    expect(
      await authorizeAgentAccountRead(store, ATTACHED.bus, ctx, { userId: 'mallory', agentId: 'team-agent', ref: 'account:linear' }),
    ).toEqual({ allowed: false });
    expect(calls).toEqual([['mallory', 'linear']]);
    expect(lines).toContainEqual({
      msg: 'connectors_agent_credential_denied',
      bindings: { reason: 'not-the-shared-connector', ref: 'account:linear' },
    });
  });

  it('DENIES the store-purpose question too when the user does not resolve the shared definition', async () => {
    const { store } = fakeStore(async () => null);
    const { ctx } = ctxWithLog();
    expect(
      await authorizeAgentAccountRead(store, ATTACHED.bus, ctx, {
        userId: 'mallory',
        agentId: 'team-agent',
        ref: 'account:linear',
        purpose: 'store',
      }),
    ).toEqual({ allowed: false });
  });

  it('DENIES (fail closed) when the store throws', async () => {
    const { store } = fakeStore(async () => {
      throw new Error('db down');
    });
    const { ctx, lines } = ctxWithLog();
    expect(
      await authorizeAgentAccountRead(store, ATTACHED.bus, ctx, { userId: 'bob', agentId: 'team-agent', ref: 'account:linear' }),
    ).toEqual({ allowed: false });
    expect(lines.some((l) => l.msg === 'connectors_agent_credential_check_failed')).toBe(true);
  });

  it.each([
    ['not an account ref', { userId: 'bob', agentId: 'a', ref: 'provider:anthropic' }],
    ['three-part account ref', { userId: 'bob', agentId: 'a', ref: 'account:linear:A:B' }],
    ['bad connector id', { userId: 'bob', agentId: 'a', ref: 'account:Linear' }],
    ['empty id', { userId: 'bob', agentId: 'a', ref: 'account:' }],
    ['empty user', { userId: '', agentId: 'a', ref: 'account:linear' }],
    ['non-string user', { userId: 7, agentId: 'a', ref: 'account:linear' }],
    ['empty agent', { userId: 'bob', agentId: '', ref: 'account:linear' }],
    ['non-string agent', { userId: 'bob', agentId: null, ref: 'account:linear' }],
    ['non-string ref', { userId: 'bob', agentId: 'a', ref: 42 }],
  ])('DENIES without touching the store: %s', async (_label, input) => {
    const { store, calls } = fakeStore(async () => SHARED);
    const { ctx } = ctxWithLog();
    expect(
      await authorizeAgentAccountRead(
        store,
        ATTACHED.bus,
        ctx,
        input as unknown as Parameters<typeof authorizeAgentAccountRead>[3],
      ),
    ).toEqual({ allowed: false });
    expect(calls).toEqual([]);
  });
});

describe('authorizeAgentAccountRead — the connector must be on the agent (TASK-788)', () => {
  const read = { userId: 'bob', agentId: 'team-agent', ref: 'account:linear' } as const;

  async function decide(
    bus: HookBus,
    input: Parameters<typeof authorizeAgentAccountRead>[3] = read,
    available: AvailableConnector[] = [SHARED],
  ): Promise<{ allowed: boolean; reasons: unknown[] }> {
    const { store } = fakeStore(async () => available.find((a) => a.connector.id === 'linear') ?? null, available);
    const { ctx, lines } = ctxWithLog();
    const out = await authorizeAgentAccountRead(store, bus, ctx, input);
    return {
      allowed: out.allowed,
      reasons: lines.filter((l) => l.msg === 'connectors_agent_credential_denied').map((l) => l.bindings?.reason),
    };
  }

  it('ALLOWS (positive control) an ATTACHED shared connector, and asks agents:resolve as the reader', async () => {
    const { bus, resolveCalls } = agentWith({ connectorAttachments: ['linear'], connectorExclusions: [] });
    expect((await decide(bus)).allowed).toBe(true);
    expect(resolveCalls).toEqual([{ agentId: 'team-agent', userId: 'bob' }]);
  });

  it('ALLOWS an attached connector even when an exclusion names it (an explicit attachment wins, as in the session union)', async () => {
    const { bus } = agentWith({ connectorAttachments: ['linear'], connectorExclusions: ['linear'] });
    expect((await decide(bus)).allowed).toBe(true);
  });

  it("ALLOWS the user's OWN legacy row with no attachment (it reaches every agent of theirs implicitly)", async () => {
    const own = row('linear', 'bob', { canEdit: true });
    const { bus } = agentWith({ connectorAttachments: [], connectorExclusions: [] });
    expect((await decide(bus, read, [own])).allowed).toBe(true);
  });

  it('DENIES a shared connector that was NEVER attached to the agent', async () => {
    const { bus } = agentWith({ connectorAttachments: [], connectorExclusions: [] });
    expect(await decide(bus)).toEqual({ allowed: false, reasons: ['not-effective-on-agent'] });
  });

  it('DENIES a shared connector once DETACHED, while another one stays attached', async () => {
    const { bus } = agentWith({ connectorAttachments: ['github'], connectorExclusions: [] });
    const github = row('github', 'owner', { canEdit: false, requiresAttachment: true });
    expect(await decide(bus, read, [SHARED, github])).toEqual({
      allowed: false,
      reasons: ['not-effective-on-agent'],
    });
  });

  it("DENIES the user's own legacy row when the agent EXCLUDES it", async () => {
    const own = row('linear', 'bob', { canEdit: true });
    const { bus } = agentWith({ connectorAttachments: [], connectorExclusions: ['linear'] });
    expect(await decide(bus, read, [own])).toEqual({ allowed: false, reasons: ['not-effective-on-agent'] });
  });

  it('DENIES a shared row the user can EDIT but that requires attachment, when not attached', async () => {
    const mine = row('linear', 'bob', { canEdit: true, requiresAttachment: true });
    const { bus } = agentWith({ connectorAttachments: [], connectorExclusions: [] });
    expect(await decide(bus, read, [mine])).toEqual({ allowed: false, reasons: ['not-effective-on-agent'] });
  });

  it('DENIES (fail closed) when no agents:resolve provider is loaded', async () => {
    const { bus } = fakeBus(null);
    expect(await decide(bus)).toEqual({ allowed: false, reasons: ['no-agents-provider'] });
  });

  it('DENIES when agents:resolve refuses this user (not a member) or the agent is gone', async () => {
    for (const code of ['forbidden', 'not-found'] as const) {
      const { bus } = fakeBus(() => {
        throw new PluginError({ code, plugin: '@ax/agents', hookName: 'agents:resolve', message: code });
      });
      expect(await decide(bus)).toEqual({ allowed: false, reasons: ['agent-not-resolvable'] });
    }
  });

  it.each([
    ['attachments not an array', { connectorAttachments: 'linear', connectorExclusions: [] }],
    ['attachments hold a non-string', { connectorAttachments: ['linear', 7], connectorExclusions: [] }],
    ['exclusions not an array', { connectorAttachments: ['linear'], connectorExclusions: { linear: true } }],
  ])('DENIES (fail closed) when the agent record is malformed: %s', async (_label, agent) => {
    const { bus } = agentWith(agent);
    expect(await decide(bus)).toEqual({ allowed: false, reasons: ['agent-lists-malformed'] });
  });

  it('DENIES (fail closed) when agents:resolve answers no agent at all', async () => {
    const { bus } = fakeBus(() => ({}));
    expect(await decide(bus)).toEqual({ allowed: false, reasons: ['agent-not-resolvable'] });
  });

  it("purpose 'store' ALLOWS an unattached shared connector without asking agents:resolve (sign-in precedes attach)", async () => {
    const { bus, resolveCalls } = agentWith({ connectorAttachments: [], connectorExclusions: [] });
    expect((await decide(bus, { ...read, purpose: 'store' })).allowed).toBe(true);
    expect(resolveCalls).toEqual([]);
  });

  it("any purpose other than exactly 'store' is a READ (fail closed)", async () => {
    const { bus } = agentWith({ connectorAttachments: [], connectorExclusions: [] });
    for (const purpose of ['read', 'STORE', 'write', '']) {
      expect(
        await decide(bus, { ...read, purpose } as unknown as Parameters<typeof authorizeAgentAccountRead>[3]),
      ).toEqual({ allowed: false, reasons: ['not-effective-on-agent'] });
    }
  });
});
