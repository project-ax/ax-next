import { describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type Logger } from '@ax/core';
import { readAgentSignIns } from '../sign-ins.js';

// Slice 4 — `mcp-oauth:status-batch`'s `signIns`: which account each of an
// agent's connectors is signed in as, read from the vault's envelope metadata
// through `credentials:list` (which never resolves or refreshes a token). No
// Docker: a bare bus with a stand-in `credentials:list`. The real-vault case
// (two agents, one owner) is in e2e.test.ts.

const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-A', userId: 'u1' });

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
  };
  return l as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

interface Row {
  scope?: string;
  ownerId?: string | null;
  ref: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

function busWith(rowsByOwner: Record<string, Row[]>, calls: unknown[] = []): HookBus {
  const bus = new HookBus();
  bus.registerService('credentials:list', 'credentials', async (_c, i: unknown) => {
    calls.push(i);
    const { ownerId } = i as { ownerId: string };
    return {
      credentials: (rowsByOwner[ownerId] ?? []).map((r) => ({
        scope: 'agent',
        ownerId,
        kind: 'mcp-oauth',
        createdAt: '2026-10-07T00:00:00.000Z',
        ...r,
      })),
    };
  });
  return bus;
}

const signIn = {
  account: 'bob@example.com',
  signedInBy: 'bob',
  signedInAt: '2026-10-07T09:30:00.000Z',
};

describe('readAgentSignIns', () => {
  it('reads each requested connector sign-in identity from its agent-scope row, in ONE list call', async () => {
    const calls: unknown[] = [];
    const bus = busWith(
      {
        'agent-A': [
          { ref: 'account:gmail', metadata: signIn },
          { ref: 'account:slack', metadata: { ...signIn, account: 'team@slack.example' } },
        ],
      },
      calls,
    );
    const out = await readAgentSignIns({ bus, ctx, logger: fakeLogger(), agentId: 'agent-A', connectorIds: ['gmail', 'slack', 'figma'] });
    expect(out).toEqual({
      gmail: signIn,
      slack: { ...signIn, account: 'team@slack.example' },
    });
    expect(calls).toEqual([{ scope: 'agent', ownerId: 'agent-A' }]);
  });

  it("excludes key slots (account:<id>:<slot>), unrequested ids, other refs and other agents' rows", async () => {
    const bus = busWith({
      'agent-A': [
        { ref: 'account:gmail:MCP_OAUTH', metadata: signIn },
        { ref: 'account:gmail:OAUTH_CLIENT_SECRET', metadata: signIn },
        { ref: 'account:unrequested', metadata: signIn },
        { ref: 'provider:gmail', metadata: signIn },
        { ref: 'mcp:gmail', metadata: signIn },
      ],
      'agent-B': [{ ref: 'account:gmail', metadata: { ...signIn, account: 'someone-else@example.com' } }],
    });
    expect(
      await readAgentSignIns({ bus, ctx, logger: fakeLogger(), agentId: 'agent-A', connectorIds: ['gmail'] }),
    ).toEqual({});
    // Asking for the slot by name does not reach it either.
    expect(
      await readAgentSignIns({ bus, ctx, logger: fakeLogger(), agentId: 'agent-A', connectorIds: ['gmail:MCP_OAUTH'] }),
    ).toEqual({});
  });

  it('a defensive filter: a row the vault says is another scope or owner is ignored', async () => {
    const bus = new HookBus();
    bus.registerService('credentials:list', 'credentials', async () => ({
      credentials: [
        { scope: 'user', ownerId: 'agent-A', ref: 'account:gmail', kind: 'mcp-oauth', createdAt: 'x', metadata: signIn },
        { scope: 'agent', ownerId: 'agent-B', ref: 'account:gmail', kind: 'mcp-oauth', createdAt: 'x', metadata: signIn },
      ],
    }));
    expect(
      await readAgentSignIns({ bus, ctx, logger: fakeLogger(), agentId: 'agent-A', connectorIds: ['gmail'] }),
    ).toEqual({});
  });

  it("only an OAuth sign-in counts: a single-slot connector's agent KEY at the bare ref is not a sign-in", async () => {
    const bus = busWith({ 'agent-A': [{ ref: 'account:linear', kind: 'api-key' }] });
    expect(
      await readAgentSignIns({ bus, ctx, logger: fakeLogger(), agentId: 'agent-A', connectorIds: ['linear'] }),
    ).toEqual({});
  });

  it('a sign-in row without metadata (from before slice 4) is still keyed, all null', async () => {
    const bus = busWith({ 'agent-A': [{ ref: 'account:gmail' }] });
    expect(
      await readAgentSignIns({ bus, ctx, logger: fakeLogger(), agentId: 'agent-A', connectorIds: ['gmail'] }),
    ).toEqual({ gmail: { account: null, signedInBy: null, signedInAt: null } });
  });

  it('reads the metadata defensively: non-strings are null, and the account is re-sanitized', async () => {
    const bus = busWith({
      'agent-A': [
        { ref: 'account:gmail', metadata: { account: 42, signedInBy: { id: 'x' }, signedInAt: ['2026'] } },
        {
          ref: 'account:slack',
          metadata: { account: `  evil\u202Emoc.x@y\n${'a'.repeat(400)}`, signedInBy: '', signedInAt: 7 },
        },
      ],
    });
    const out = await readAgentSignIns({ bus, ctx, logger: fakeLogger(), agentId: 'agent-A', connectorIds: ['gmail', 'slack'] });
    expect(out.gmail).toEqual({ account: null, signedInBy: null, signedInAt: null });
    const slack = out.slack!;
    expect(slack.account!.startsWith('evilmoc.x@y')).toBe(true);
    expect(slack.account).not.toMatch(/[\u202E\n]/);
    expect([...slack.account!]).toHaveLength(254);
    expect(slack.signedInBy).toBeNull();
    expect(slack.signedInAt).toBeNull();
  });

  it('no credentials:list → {} without a call or a log', async () => {
    const logger = fakeLogger();
    expect(
      await readAgentSignIns({ bus: new HookBus(), ctx, logger, agentId: 'agent-A', connectorIds: ['gmail'] }),
    ).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a throwing credentials:list → {} and ONE warn with the error CODE, never a value', async () => {
    const bus = new HookBus();
    bus.registerService('credentials:list', 'credentials', async () => {
      throw new TypeError('bob@example.com is in this message');
    });
    const logger = fakeLogger();
    expect(
      await readAgentSignIns({ bus, ctx, logger, agentId: 'agent-A', connectorIds: ['gmail'] }),
    ).toEqual({});
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [msg, fields] = logger.warn.mock.calls[0]!;
    expect(msg).toBe('mcp_oauth_sign_in_identity_read_failed');
    // The bus wraps a foreign throw as PluginError{code:'unknown'}: the code
    // is the wrapper's, and the error's name and message go nowhere.
    expect(fields).toEqual({ agentId: 'agent-A', code: 'unknown' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('bob@example.com');
  });

  it("a PluginError from the vault → its own code is logged (the operator's signal)", async () => {
    const bus = new HookBus();
    bus.registerService('credentials:list', 'credentials', async () => {
      throw new PluginError({ code: 'storage-unavailable', plugin: '@ax/credentials', message: 'carol@example.com' });
    });
    const logger = fakeLogger();
    await readAgentSignIns({ bus, ctx, logger, agentId: 'agent-A', connectorIds: ['gmail'] });
    expect(logger.warn.mock.calls[0]![1]).toEqual({ agentId: 'agent-A', code: 'storage-unavailable' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('carol@example.com');
  });

  it('a malformed list reply → {} (never a throw)', async () => {
    for (const reply of [null, {}, { credentials: 'nope' }, { credentials: [null, 7, { ref: 3 }] }]) {
      const bus = new HookBus();
      bus.registerService('credentials:list', 'credentials', async () => reply);
      expect(
        await readAgentSignIns({ bus, ctx, logger: fakeLogger(), agentId: 'agent-A', connectorIds: ['gmail'] }),
      ).toEqual({});
    }
  });

  it('no connector ids → {} without a call', async () => {
    const calls: unknown[] = [];
    const bus = busWith({ 'agent-A': [{ ref: 'account:gmail', metadata: signIn }] }, calls);
    expect(
      await readAgentSignIns({ bus, ctx, logger: fakeLogger(), agentId: 'agent-A', connectorIds: [] }),
    ).toEqual({});
    expect(calls).toEqual([]);
  });
});
