import { describe, it, expect } from 'vitest';
import { makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { authorizeAgentAccountRead } from '../credential-authz.js';
import type { AvailableConnector, ConnectorStore } from '../store.js';

// ---------------------------------------------------------------------------
// TASK-711 — the `credentials:authorize-agent:account` provider, as a pure
// function over a fake store (no database). The store's own selection rule
// (`getSoleSharedById`) is tested against real postgres in store.test.ts;
// this file pins what the provider does with the store's answer and with
// malformed input. Every case says what it does against an always-allow
// provider: the deny cases fail there, the allow case is the positive control.
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

const SHARED: AvailableConnector = {
  ownerUserId: 'owner',
  connector: { id: 'linear' } as unknown as AvailableConnector['connector'],
};

/** A store whose only live method is getSoleSharedById; every other call fails the test. */
function fakeStore(
  answer: (userId: string, connectorId: string) => Promise<AvailableConnector | null>,
): { store: ConnectorStore; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const fail = (): never => {
    throw new Error('unexpected store call');
  };
  const store = {
    listForUser: fail,
    listDefaults: fail,
    getByIdNotDeleted: fail,
    listAvailable: fail,
    getAvailableById: fail,
    upsert: fail,
    softDelete: fail,
    async getSoleSharedById(userId: string, connectorId: string) {
      calls.push([userId, connectorId]);
      return answer(userId, connectorId);
    },
  } as unknown as ConnectorStore;
  return { store, calls };
}

describe('authorizeAgentAccountRead (TASK-711)', () => {
  it('ALLOWS (positive control) when the user resolves the one shared definition; asks about the id, not the slot', async () => {
    const { store, calls } = fakeStore(async () => SHARED);
    const { ctx } = ctxWithLog();
    expect(
      await authorizeAgentAccountRead(store, ctx, { userId: 'bob', agentId: 'team-agent', ref: 'account:linear' }),
    ).toEqual({ allowed: true });
    expect(
      await authorizeAgentAccountRead(store, ctx, { userId: 'bob', agentId: 'team-agent', ref: 'account:linear:API_TOKEN' }),
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
      await authorizeAgentAccountRead(store, ctx, { userId: 'mallory', agentId: 'team-agent', ref: 'account:linear' }),
    ).toEqual({ allowed: false });
    expect(calls).toEqual([['mallory', 'linear']]);
    expect(lines).toContainEqual({
      msg: 'connectors_agent_credential_denied',
      bindings: { reason: 'not-the-shared-connector', ref: 'account:linear' },
    });
  });

  it('DENIES (fail closed) when the store throws', async () => {
    const { store } = fakeStore(async () => {
      throw new Error('db down');
    });
    const { ctx, lines } = ctxWithLog();
    expect(
      await authorizeAgentAccountRead(store, ctx, { userId: 'bob', agentId: 'team-agent', ref: 'account:linear' }),
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
      await authorizeAgentAccountRead(store, ctx, input as unknown as Parameters<typeof authorizeAgentAccountRead>[2]),
    ).toEqual({ allowed: false });
    expect(calls).toEqual([]);
  });
});
