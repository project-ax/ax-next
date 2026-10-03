/**
 * account-agent-guard.test.ts — TASK-711.
 *
 * A team agent's shared sign-in is stored at vault scope `agent` under
 * `account:<connectorId>`. Connector ids are unique per OWNER, so a member can
 * author their own connector named after the team's one, point it at their own
 * server, and the user -> agent -> global walk used to hand them the team's
 * token at the agent step.
 *
 * The fix: for `account:` refs the AGENT step is taken only if a provider of
 * `credentials:authorize-agent:account` says `{ allowed: true }` for this
 * (userId, agentId, ref). No provider, a denial, a throw, or a garbage answer
 * skip the agent step (fail closed). Every case says whether it FAILS against
 * the unfixed code or pins unchanged behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Logger,
} from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

const HOOK = 'credentials:authorize-global:account';
const AGENT_HOOK = 'credentials:authorize-agent:account';
const TEST_KEY_HEX = '42'.repeat(32);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Minimal in-memory storage plugin (mirrors vault.test.ts).
function memStoragePlugin() {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: ['storage:get', 'storage:set', 'storage:list-prefix', 'storage:delete-prefix'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService('storage:get', 'mem-storage', async (_ctx, { key }: { key: string }) => ({
        value: store.get(key),
      }));
      bus.registerService(
        'storage:set',
        'mem-storage',
        async (_ctx, { key, value }: { key: string; value: Uint8Array }) => {
          store.set(key, value);
        },
      );
      bus.registerService(
        'storage:list-prefix',
        'mem-storage',
        async (_ctx, { prefix }: { prefix: string }) => {
          const entries: Array<{ key: string; value: Uint8Array }> = [];
          for (const [k, v] of store.entries()) {
            if (k.startsWith(prefix)) entries.push({ key: k, value: v });
          }
          return { entries };
        },
      );
      bus.registerService(
        'storage:delete-prefix',
        'mem-storage',
        async (_ctx, { prefix }: { prefix: string }) => {
          let deleted = 0;
          for (const k of [...store.keys()]) {
            if (k.startsWith(prefix)) {
              store.delete(k);
              deleted++;
            }
          }
          return { deleted };
        },
      );
    },
  };
}

/** A configurable stand-in for the `credentials:authorize-global:account` provider. */
interface AuthzStub {
  /** Every input the hook received, in order. */
  readonly calls: unknown[];
  /** What the hook does. Return a value or throw. */
  respond: (input: unknown) => unknown;
}

function authzStub(respond: (input: unknown) => unknown): AuthzStub {
  return { calls: [], respond };
}

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

/** A ctx whose logger records every line, so we can assert nothing secret leaks. */
function recordingCtx(opts: { agentId?: string; userId: string }): {
  ctx: AgentContext;
  lines: LogLine[];
} {
  const lines: LogLine[] = [];
  const logger: Logger = {
    debug: (msg, bindings) => void lines.push({ level: 'debug', msg, bindings }),
    info: (msg, bindings) => void lines.push({ level: 'info', msg, bindings }),
    warn: (msg, bindings) => void lines.push({ level: 'warn', msg, bindings }),
    error: (msg, bindings) => void lines.push({ level: 'error', msg, bindings }),
    child: () => logger,
  };
  const ctx = makeAgentContext({
    sessionId: 's',
    agentId: opts.agentId ?? '',
    userId: opts.userId,
    logger,
  });
  return { ctx, lines };
}

describe('credentials:get — account: refs gate the AGENT step (TASK-711)', () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
  });

  async function makeBus(opts: { agent?: AuthzStub; global?: AuthzStub } = {}): Promise<HookBus> {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        memStoragePlugin(),
        createCredentialsStoreDbPlugin(),
        ...(opts.agent !== undefined ? [providerPlugin(AGENT_HOOK, opts.agent)] : []),
        ...(opts.global !== undefined ? [providerPlugin(HOOK, opts.global)] : []),
        createCredentialsPlugin({}),
      ],
      config: {},
    });
    return bus;
  }

  async function seed(
    bus: HookBus,
    scope: 'global' | 'user' | 'agent',
    ownerId: string | null,
    ref: string,
    value: string,
  ): Promise<void> {
    const ctx = makeAgentContext({ sessionId: 'seed', agentId: 'seed', userId: 'admin' });
    await bus.call('credentials:set', ctx, {
      scope,
      ownerId,
      ref,
      kind: 'api-key',
      payload: enc(value),
    });
  }

  const get = (bus: HookBus, ctx: AgentContext, ref: string, userId: string) =>
    bus.call<{ ref: string; userId: string }, string>('credentials:get', ctx, { ref, userId });

  const failure = (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => undefined,
      (e: unknown) => e,
    );

  it('(a) FAILS UNFIXED: an agent-scope account: row with NO provider registered is not readable', async () => {
    const bus = await makeBus();
    await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
    const { ctx, lines } = recordingCtx({ agentId: 'team-agent', userId: 'mallory' });

    const err = await failure(get(bus, ctx, 'account:linear', 'mallory'));
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('credential-not-found');
    expect((err as PluginError).message).not.toContain('TEAM-TOKEN');
    expect(JSON.stringify(lines)).not.toContain('TEAM-TOKEN');
  });

  it('(b) FAILS UNFIXED: provider says {allowed:false} -> credential-not-found; provider saw exactly {userId, agentId, ref}', async () => {
    const agent = authzStub(() => ({ allowed: false }));
    const bus = await makeBus({ agent });
    await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
    const { ctx, lines } = recordingCtx({ agentId: 'team-agent', userId: 'mallory' });

    await expect(get(bus, ctx, 'account:linear', 'mallory')).rejects.toMatchObject({
      code: 'credential-not-found',
    });
    expect(agent.calls).toEqual([
      { userId: 'mallory', agentId: 'team-agent', ref: 'account:linear' },
    ]);
    expect(lines).toContainEqual({
      level: 'info',
      msg: 'credentials_agent_read_denied',
      bindings: { ref: 'account:linear' },
    });
    expect(JSON.stringify(lines)).not.toContain('TEAM-TOKEN');
  });

  it('(c) positive control + FAILS UNFIXED (provider never consulted there): {allowed:true} -> the agent value is returned', async () => {
    const agent = authzStub(() => ({ allowed: true }));
    const bus = await makeBus({ agent });
    await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
    const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });

    expect(await get(bus, ctx, 'account:linear', 'bob')).toBe('TEAM-TOKEN');
    expect(agent.calls).toEqual([{ userId: 'bob', agentId: 'team-agent', ref: 'account:linear' }]);
  });

  it('(d) FAILS UNFIXED: a provider that throws is a denial, logged without the value', async () => {
    const agent = authzStub(() => {
      throw new Error('authz backend exploded');
    });
    const bus = await makeBus({ agent });
    await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
    const { ctx, lines } = recordingCtx({ agentId: 'team-agent', userId: 'mallory' });

    await expect(get(bus, ctx, 'account:linear', 'mallory')).rejects.toMatchObject({
      code: 'credential-not-found',
    });
    expect(lines.some((l) => l.msg === 'credentials_agent_guard_failed')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('TEAM-TOKEN');
  });

  it('(e) FAILS UNFIXED: a truthy-but-not-true answer is a denial', async () => {
    const agent = authzStub(() => ({ allowed: 'yes' }));
    const bus = await makeBus({ agent });
    await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
    const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'mallory' });

    const err = await failure(get(bus, ctx, 'account:linear', 'mallory'));
    expect((err as PluginError).code).toBe('credential-not-found');
  });

  it('(f) FAILS UNFIXED: a multi-slot ref account:<id>:<SLOT> is gated the same way', async () => {
    const agent = authzStub(() => ({ allowed: false }));
    const bus = await makeBus({ agent });
    await seed(bus, 'agent', 'team-agent', 'account:linear:API_TOKEN', 'TEAM-SLOT');
    const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'mallory' });

    await expect(get(bus, ctx, 'account:linear:API_TOKEN', 'mallory')).rejects.toMatchObject({
      code: 'credential-not-found',
    });
    expect(agent.calls).toEqual([
      { userId: 'mallory', agentId: 'team-agent', ref: 'account:linear:API_TOKEN' },
    ]);
  });

  it('(g) PIN: a user-scope row wins and the agent provider is NEVER called', async () => {
    const agent = authzStub(() => ({ allowed: true }));
    const bus = await makeBus({ agent });
    await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
    await seed(bus, 'user', 'bob', 'account:linear', 'BOB-OWN');
    const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });

    expect(await get(bus, ctx, 'account:linear', 'bob')).toBe('BOB-OWN');
    expect(agent.calls).toEqual([]);
  });

  it('(h) PIN: non-account refs at agent scope resolve with NO provider and never call it', async () => {
    const agent = authzStub(() => ({ allowed: false }));
    const bus = await makeBus({ agent });
    await seed(bus, 'agent', 'team-agent', 'provider:anthropic', 'AGENT-PROVIDER-KEY');
    const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });

    expect(await get(bus, ctx, 'provider:anthropic', 'bob')).toBe('AGENT-PROVIDER-KEY');
    expect(agent.calls).toEqual([]);
  });

  it('(i) PIN: a denied agent step walks on to the (separately gated) global step', async () => {
    const agent = authzStub(() => ({ allowed: false }));
    const global = authzStub(() => ({ allowed: true }));
    const bus = await makeBus({ agent, global });
    await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
    await seed(bus, 'global', null, 'account:linear', 'COMPANY-KEY');
    const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'admin' });

    expect(await get(bus, ctx, 'account:linear', 'admin')).toBe('COMPANY-KEY');
    expect(agent.calls).toHaveLength(1);
    expect(global.calls).toHaveLength(1);
  });

  it('(j) PIN: no agent in ctx -> no agent step, so the agent provider is never called', async () => {
    const agent = authzStub(() => ({ allowed: true }));
    const bus = await makeBus({ agent });
    await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
    const { ctx } = recordingCtx({ userId: 'bob' });

    await expect(get(bus, ctx, 'account:linear', 'bob')).rejects.toMatchObject({
      code: 'credential-not-found',
    });
    expect(agent.calls).toEqual([]);
  });

  it('(k) PIN (goes red if the hook is ever declared in the credentials manifest): boots beside a provider that depends on credentials:*', async () => {
    const provider = {
      manifest: {
        name: 'connectors-shaped',
        version: '0.0.0',
        registers: [AGENT_HOOK],
        calls: [],
        optionalCalls: [{ hook: 'credentials:delete', degradation: 'test' }],
        subscribes: [],
      },
      async init({ bus }: { bus: HookBus }) {
        bus.registerService(AGENT_HOOK, 'connectors-shaped', async () => ({ allowed: true }));
      },
    };
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        memStoragePlugin(),
        createCredentialsStoreDbPlugin(),
        provider,
        createCredentialsPlugin({}),
      ],
      config: {},
    });
    await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
    const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });
    expect(await get(bus, ctx, 'account:linear', 'bob')).toBe('TEAM-TOKEN');
  });
});

function providerPlugin(hook: string, stub: AuthzStub) {
  const name = hook === AGENT_HOOK ? 'agent-authz-stub' : 'global-authz-stub';
  return {
    manifest: { name, version: '0.0.0', registers: [hook], calls: [], subscribes: [] },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService(hook, name, async (_ctx, input: unknown) => {
        stub.calls.push(input);
        return stub.respond(input);
      });
    },
  };
}
