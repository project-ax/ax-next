/**
 * account-global-guard.test.ts — TASK-697.
 *
 * A connector's credential ref is `account:<connectorId>` (or
 * `account:<connectorId>:<SLOT>`). The connector id is chosen by the USER who
 * authors the connector, so `credentials:get`'s user -> agent -> global walk
 * used to hand a company-wide (global-scope) key to any user who created a
 * connector with the same id as a company-keyed one.
 *
 * The fix: for `account:` refs the GLOBAL step is taken only if a provider of
 * `credentials:authorize-global:account` says `{ allowed: true }` for this
 * (userId, ref). No provider, a denial, a throw, or a garbage answer all skip
 * the global step (fail closed). User and agent scopes are not gated, and every
 * other ref namespace never calls the hook.
 *
 * Each case below says whether it FAILS against the unfixed code (the bug
 * regression) or is a deliberate unchanged-behaviour pin.
 *
 * Harness mirrors vault.test.ts / scope-precedence.test.ts: in-memory storage +
 * the real credentials-store-db + the real credentials facade.
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

function authzProviderPlugin(stub: AuthzStub) {
  return {
    manifest: {
      name: 'authz-stub',
      version: '0.0.0',
      registers: [HOOK],
      calls: [],
      subscribes: [],
    },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService(HOOK, 'authz-stub', async (_ctx, input: unknown) => {
        stub.calls.push(input);
        return stub.respond(input);
      });
    },
  };
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

describe('credentials:get — account: refs gate the GLOBAL step (TASK-697)', () => {
  let savedKey: string | undefined;
  let savedFallback: string | undefined;

  beforeEach(() => {
    savedKey = process.env.AX_CREDENTIALS_KEY;
    savedFallback = process.env.ACCT_FALLBACK;
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
    if (savedFallback === undefined) delete process.env.ACCT_FALLBACK;
    else process.env.ACCT_FALLBACK = savedFallback;
  });

  async function makeBus(
    opts: { stub?: AuthzStub; envFallback?: Record<string, string> } = {},
  ): Promise<HookBus> {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        memStoragePlugin(),
        createCredentialsStoreDbPlugin(),
        ...(opts.stub !== undefined ? [authzProviderPlugin(opts.stub)] : []),
        createCredentialsPlugin(
          opts.envFallback !== undefined ? { envFallback: opts.envFallback } : {},
        ),
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

  async function tombstone(
    bus: HookBus,
    scope: 'global' | 'user' | 'agent',
    ownerId: string | null,
    ref: string,
  ): Promise<void> {
    const ctx = makeAgentContext({ sessionId: 'seed', agentId: 'seed', userId: 'admin' });
    await bus.call('credentials:delete', ctx, { scope, ownerId, ref });
  }

  const get = (bus: HookBus, ctx: AgentContext, ref: string, userId: string) =>
    bus.call<{ ref: string; userId: string }, string>('credentials:get', ctx, { ref, userId });

  // -------------------------------------------------------------------------
  // The bug: a user reaches a company key through a same-id connector.
  // -------------------------------------------------------------------------

  it('(a) FAILS UNFIXED: global account: row with NO provider registered is not readable (fail closed)', async () => {
    const bus = await makeBus();
    await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    const { ctx, lines } = recordingCtx({ userId: 'mallory' });

    const err: unknown = await get(bus, ctx, 'account:zendesk', 'mallory').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('credential-not-found');
    expect((err as PluginError).message).not.toContain('COMPANY-ZENDESK-KEY');
    expect(JSON.stringify(lines)).not.toContain('COMPANY-ZENDESK-KEY');
  });

  it('(b) FAILS UNFIXED: provider says {allowed:false} -> credential-not-found; provider saw exactly {userId, ref}', async () => {
    const stub = authzStub(() => ({ allowed: false }));
    const bus = await makeBus({ stub });
    await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    const { ctx, lines } = recordingCtx({ userId: 'mallory' });

    await expect(get(bus, ctx, 'account:zendesk', 'mallory')).rejects.toMatchObject({
      code: 'credential-not-found',
    });
    expect(stub.calls).toEqual([{ userId: 'mallory', ref: 'account:zendesk' }]);
    // The denial is logged (ref only, never a value).
    expect(lines).toContainEqual({
      level: 'info',
      msg: 'credentials_global_read_denied',
      bindings: { ref: 'account:zendesk' },
    });
    expect(JSON.stringify(lines)).not.toContain('COMPANY-ZENDESK-KEY');
  });

  it('(c) FAILS UNFIXED (provider never consulted there): provider says {allowed:true} -> the global value is returned', async () => {
    const stub = authzStub(() => ({ allowed: true }));
    const bus = await makeBus({ stub });
    await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    const { ctx } = recordingCtx({ userId: 'admin' });

    expect(await get(bus, ctx, 'account:zendesk', 'admin')).toBe('COMPANY-ZENDESK-KEY');
    expect(stub.calls).toEqual([{ userId: 'admin', ref: 'account:zendesk' }]);
  });

  it('(d) PIN: a user-scope row at the same ref wins and the provider is NEVER called', async () => {
    const stub = authzStub(() => ({ allowed: true }));
    const bus = await makeBus({ stub });
    await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    await seed(bus, 'user', 'alice', 'account:zendesk', 'ALICE-OWN-KEY');
    const { ctx } = recordingCtx({ userId: 'alice' });

    expect(await get(bus, ctx, 'account:zendesk', 'alice')).toBe('ALICE-OWN-KEY');
    expect(stub.calls).toEqual([]);
  });

  it('(e) PIN: an agent-scope row resolves and the provider is NEVER called (agent scope is not gated)', async () => {
    const stub = authzStub(() => ({ allowed: false }));
    const bus = await makeBus({ stub });
    await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    await seed(bus, 'agent', 'agent-7', 'account:zendesk', 'AGENT-KEY');
    const { ctx } = recordingCtx({ agentId: 'agent-7', userId: 'alice' });

    expect(await get(bus, ctx, 'account:zendesk', 'alice')).toBe('AGENT-KEY');
    expect(stub.calls).toEqual([]);
  });

  it('(f) FAILS UNFIXED: a provider that throws is a denial (credential-not-found, not a leak, not another code)', async () => {
    const stub = authzStub(() => {
      throw new Error('authz backend exploded');
    });
    const bus = await makeBus({ stub });
    await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    const { ctx, lines } = recordingCtx({ userId: 'mallory' });

    const err: unknown = await get(bus, ctx, 'account:zendesk', 'mallory').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('credential-not-found');
    expect(stub.calls).toHaveLength(1);
    // The failure is visible to an operator (warn), still without a secret.
    const warn = lines.find((l) => l.msg === 'credentials_global_guard_failed');
    expect(warn?.level).toBe('warn');
    expect(warn?.bindings).toMatchObject({ ref: 'account:zendesk' });
    expect(JSON.stringify(lines)).not.toContain('COMPANY-ZENDESK-KEY');
  });

  it.each([
    ['a non-boolean truthy value', { allowed: 'yes' }],
    ['a number', { allowed: 1 }],
    ['an object with no `allowed`', {}],
    ['null', null],
    ['undefined', undefined],
    ['a bare `true` (not the {allowed} shape)', true],
  ])('(g) FAILS UNFIXED: a garbage provider answer (%s) is a denial', async (_label, answer) => {
    const stub = authzStub(() => answer);
    const bus = await makeBus({ stub });
    await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    const { ctx } = recordingCtx({ userId: 'mallory' });

    await expect(get(bus, ctx, 'account:zendesk', 'mallory')).rejects.toMatchObject({
      code: 'credential-not-found',
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('(h) FAILS UNFIXED: a multi-slot ref account:<id>:<SLOT> is guarded the same way and the provider sees the FULL ref', async () => {
    const ref = 'account:zendesk:ZENDESK_API_TOKEN';
    const stub = authzStub(() => ({ allowed: false }));
    const bus = await makeBus({ stub });
    await seed(bus, 'global', null, ref, 'COMPANY-ZENDESK-TOKEN');
    const { ctx } = recordingCtx({ userId: 'mallory' });

    await expect(get(bus, ctx, ref, 'mallory')).rejects.toMatchObject({
      code: 'credential-not-found',
    });
    expect(stub.calls).toEqual([{ userId: 'mallory', ref }]);

    // ...and an allow on the same slot ref resolves it.
    stub.respond = () => ({ allowed: true });
    expect(await get(bus, ctx, ref, 'mallory')).toBe('COMPANY-ZENDESK-TOKEN');
    expect(stub.calls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Everything that is not an `account:` ref is untouched.
  // -------------------------------------------------------------------------

  it('(i) PIN: provider:/mcp:/skill:/routine: refs resolve from global with NO provider, and a registered provider is never called', async () => {
    const refs: Array<[string, string]> = [
      ['provider:anthropic', 'SK-ANTHROPIC'],
      ['mcp:srv:env:TOKEN', 'MCP-TOKEN'],
      ['mcp:srv:header:Authorization', 'MCP-HEADER'],
      ['skill:linear:LINEAR_API_KEY', 'SKILL-KEY'],
      ['routine:agent-1:daily:hmac', 'ROUTINE-HMAC'],
      ['plain-ref', 'PLAIN'],
    ];

    // No provider at all.
    const bare = await makeBus();
    for (const [ref, value] of refs) await seed(bare, 'global', null, ref, value);
    const { ctx } = recordingCtx({ userId: 'alice' });
    for (const [ref, value] of refs) {
      expect(await get(bare, ctx, ref, 'alice')).toBe(value);
    }

    // A provider that would deny everything is never consulted for them.
    const stub = authzStub(() => ({ allowed: false }));
    const withProvider = await makeBus({ stub });
    for (const [ref, value] of refs) await seed(withProvider, 'global', null, ref, value);
    for (const [ref, value] of refs) {
      expect(await get(withProvider, ctx, ref, 'alice')).toBe(value);
    }
    expect(stub.calls).toEqual([]);
  });

  it('(j) PIN: only the exact `account:` prefix is guarded (accounts:x, account-x, xaccount:x resolve from global with no provider)', async () => {
    const refs: Array<[string, string]> = [
      ['accounts:zendesk', 'PLURAL'],
      ['account-zendesk', 'DASH'],
      ['myaccount:zendesk', 'INFIX'],
      ['Account:zendesk', 'CASED'],
    ];
    const stub = authzStub(() => ({ allowed: false }));
    const bus = await makeBus({ stub });
    for (const [ref, value] of refs) await seed(bus, 'global', null, ref, value);
    const { ctx } = recordingCtx({ userId: 'alice' });
    for (const [ref, value] of refs) {
      expect(await get(bus, ctx, ref, 'alice')).toBe(value);
    }
    expect(stub.calls).toEqual([]);
  });

  it('(k) PIN + FAILS UNFIXED (deny half): a tombstoned user-scope row falls through to global exactly as before, and the global step is still gated', async () => {
    const allow = authzStub(() => ({ allowed: true }));
    const allowed = await makeBus({ stub: allow });
    await seed(allowed, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    await seed(allowed, 'user', 'alice', 'account:zendesk', 'ALICE-OWN-KEY');
    await tombstone(allowed, 'user', 'alice', 'account:zendesk');
    const { ctx } = recordingCtx({ userId: 'alice' });
    // Tombstone at user scope is skipped; the (allowed) global row is returned.
    expect(await get(allowed, ctx, 'account:zendesk', 'alice')).toBe('COMPANY-ZENDESK-KEY');
    expect(allow.calls).toEqual([{ userId: 'alice', ref: 'account:zendesk' }]);

    const deny = authzStub(() => ({ allowed: false }));
    const denied = await makeBus({ stub: deny });
    await seed(denied, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    await seed(denied, 'user', 'alice', 'account:zendesk', 'ALICE-OWN-KEY');
    await tombstone(denied, 'user', 'alice', 'account:zendesk');
    // Same tombstone, but the guard denies global -> not found (no leak).
    await expect(get(denied, ctx, 'account:zendesk', 'alice')).rejects.toMatchObject({
      code: 'credential-not-found',
    });
  });

  it('(l) FAILS UNFIXED (global answers before env): a denied global step still falls through to the operator-configured envFallback', async () => {
    process.env.ACCT_FALLBACK = 'FROM-ENV';
    const stub = authzStub(() => ({ allowed: false }));
    const bus = await makeBus({ stub, envFallback: { 'account:zendesk': 'ACCT_FALLBACK' } });
    await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    const { ctx } = recordingCtx({ userId: 'mallory' });

    expect(await get(bus, ctx, 'account:zendesk', 'mallory')).toBe('FROM-ENV');
  });

  // -------------------------------------------------------------------------
  // Boot: the provider will be @ax/connectors, which itself depends on
  // @ax/credentials (it optionally calls credentials:delete). Declaring the
  // guard hook on the credentials manifest must not turn that into a
  // plugin call-graph cycle, or no preset that loads both would boot.
  // -------------------------------------------------------------------------

  it('(m) PIN (passes unfixed; goes red if the hook is ever declared in the manifest): boots when the provider plugin itself depends on credentials:* (no call-graph cycle)', async () => {
    const provider = {
      manifest: {
        name: 'connectors-like-provider',
        version: '0.0.0',
        registers: [HOOK],
        calls: [],
        // Mirrors @ax/connectors: it soft-depends on credentials:delete.
        optionalCalls: [
          { hook: 'credentials:delete', degradation: 'test: stored key is left in the vault' },
        ],
        subscribes: [],
      },
      async init({ bus }: { bus: HookBus }) {
        bus.registerService(HOOK, 'connectors-like-provider', async () => ({ allowed: true }));
      },
    };
    const bus = new HookBus();
    await expect(
      bootstrap({
        bus,
        plugins: [
          memStoragePlugin(),
          createCredentialsStoreDbPlugin(),
          provider,
          createCredentialsPlugin(),
        ],
        config: {},
      }),
    ).resolves.toBeDefined();

    await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK-KEY');
    const { ctx } = recordingCtx({ userId: 'admin' });
    expect(await get(bus, ctx, 'account:zendesk', 'admin')).toBe('COMPANY-ZENDESK-KEY');
  });
});
