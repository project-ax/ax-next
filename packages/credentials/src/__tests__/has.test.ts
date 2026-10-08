/**
 * has.test.ts — `credentials:has`, the NON-RESOLVING presence check.
 *
 * `credentials:has` answers "would `credentials:get` find a credential for this
 * (ctx, userId, ref)?" without ever resolving it. The pin that matters most is
 * case 5: a row of a refreshing kind (mcp-oauth) reports present WITHOUT its
 * `credentials:resolve:<kind>` service being called — so asking "is this
 * connected?" can never refresh a token, hit the network, or re-store a row.
 *
 * Everything else pins that `has` walks the SAME chain as `get`: user -> agent
 * -> global, tombstones skipped, the TASK-697 / TASK-711 `account:` gates, and
 * the operator-configured envFallback.
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

const GLOBAL_HOOK = 'credentials:authorize-global:account';
const AGENT_HOOK = 'credentials:authorize-agent:account';
const TEST_KEY_HEX = '42'.repeat(32);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Minimal in-memory storage plugin (mirrors account-agent-guard.test.ts).
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

/** A stand-in for an `account:` authorize provider; `respond` decides allow/deny. */
function authzProvider(hook: string, respond: (input: unknown) => unknown, calls: unknown[] = []) {
  const name = hook === AGENT_HOOK ? 'agent-authz-stub' : 'global-authz-stub';
  return {
    manifest: { name, version: '0.0.0', registers: [hook], calls: [], subscribes: [] },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService(hook, name, async (_ctx, input: unknown) => {
        calls.push(input);
        return respond(input);
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

describe('credentials:has — non-resolving presence check', () => {
  let savedKey: string | undefined;
  let savedFallback: string | undefined;

  beforeEach(() => {
    savedKey = process.env.AX_CREDENTIALS_KEY;
    savedFallback = process.env.HAS_TEST_FALLBACK;
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
    delete process.env.HAS_TEST_FALLBACK;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
    if (savedFallback === undefined) delete process.env.HAS_TEST_FALLBACK;
    else process.env.HAS_TEST_FALLBACK = savedFallback;
  });

  async function makeBus(
    opts: {
      agentAllows?: boolean;
      globalAllows?: boolean;
      envFallback?: Record<string, string>;
      extra?: unknown[];
    } = {},
  ): Promise<HookBus> {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        memStoragePlugin(),
        createCredentialsStoreDbPlugin(),
        ...(opts.agentAllows !== undefined
          ? [authzProvider(AGENT_HOOK, () => ({ allowed: opts.agentAllows }))]
          : []),
        ...(opts.globalAllows !== undefined
          ? [authzProvider(GLOBAL_HOOK, () => ({ allowed: opts.globalAllows }))]
          : []),
        ...((opts.extra ?? []) as never[]),
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
    kind = 'api-key',
  ): Promise<void> {
    const ctx = makeAgentContext({ sessionId: 'seed', agentId: 'seed', userId: 'admin' });
    await bus.call('credentials:set', ctx, { scope, ownerId, ref, kind, payload: enc(value) });
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

  const has = (bus: HookBus, ctx: AgentContext, ref: string, userId: string) =>
    bus.call<{ ref: string; userId: string }, { present: boolean }>('credentials:has', ctx, {
      ref,
      userId,
    });

  const get = (bus: HookBus, ctx: AgentContext, ref: string, userId: string) =>
    bus.call<{ ref: string; userId: string }, string>('credentials:get', ctx, { ref, userId });

  // ---------------------------------------------------------------- 1. present

  describe('present when credentials:get would find a row', () => {
    it('a user-scope row', async () => {
      const bus = await makeBus();
      await seed(bus, 'user', 'bob', 'provider:anthropic', 'BOB-KEY');
      const { ctx } = recordingCtx({ userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: true });
    });

    it('an agent-scope row (ctx.agentId set)', async () => {
      const bus = await makeBus();
      await seed(bus, 'agent', 'team-agent', 'provider:anthropic', 'AGENT-KEY');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: true });
    });

    it('an agent-scope account: row when the agent authorize hook allows', async () => {
      const bus = await makeBus({ agentAllows: true });
      await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });
      expect(await has(bus, ctx, 'account:linear', 'bob')).toEqual({ present: true });
    });

    it('a global row', async () => {
      const bus = await makeBus();
      await seed(bus, 'global', null, 'provider:anthropic', 'GLOBAL-KEY');
      const { ctx } = recordingCtx({ userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: true });
    });

    it('a global account: row when the global authorize hook allows', async () => {
      const bus = await makeBus({ globalAllows: true });
      await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-KEY');
      const { ctx } = recordingCtx({ userId: 'bob' });
      expect(await has(bus, ctx, 'account:zendesk', 'bob')).toEqual({ present: true });
    });

    it('agrees with credentials:get on every positive case above (same walk)', async () => {
      const bus = await makeBus({ agentAllows: true, globalAllows: true });
      await seed(bus, 'user', 'bob', 'k-user', 'U');
      await seed(bus, 'agent', 'team-agent', 'account:k-agent', 'A');
      await seed(bus, 'global', null, 'account:k-global', 'G');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });
      for (const ref of ['k-user', 'account:k-agent', 'account:k-global']) {
        expect(await get(bus, ctx, ref, 'bob')).toBeTypeOf('string');
        expect(await has(bus, ctx, ref, 'bob')).toEqual({ present: true });
      }
    });
  });

  // ------------------------------------------------------------ 2. not present

  describe('not present when credentials:get would not find a row', () => {
    it('an agent row on a DIFFERENT agent than ctx.agentId', async () => {
      const bus = await makeBus();
      await seed(bus, 'agent', 'other-agent', 'provider:anthropic', 'OTHER-AGENT-KEY');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: false });
      await expect(get(bus, ctx, 'provider:anthropic', 'bob')).rejects.toMatchObject({
        code: 'credential-not-found',
      });
    });

    it('an agent row when ctx carries no agent at all', async () => {
      const bus = await makeBus();
      await seed(bus, 'agent', 'team-agent', 'provider:anthropic', 'AGENT-KEY');
      const { ctx } = recordingCtx({ userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: false });
    });

    it("another user's user-scope row", async () => {
      const bus = await makeBus();
      await seed(bus, 'user', 'alice', 'provider:anthropic', 'ALICE-KEY');
      const { ctx } = recordingCtx({ userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: false });
    });

    it('an account: agent row when the agent authorize hook denies', async () => {
      const bus = await makeBus({ agentAllows: false });
      await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'mallory' });
      expect(await has(bus, ctx, 'account:linear', 'mallory')).toEqual({ present: false });
    });

    it('an account: agent row when NO agent authorize hook is registered (fail closed)', async () => {
      const bus = await makeBus();
      await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'mallory' });
      expect(await has(bus, ctx, 'account:linear', 'mallory')).toEqual({ present: false });
    });

    it('an account: agent row when the agent authorize hook throws (fail closed)', async () => {
      const bus = new HookBus();
      await bootstrap({
        bus,
        plugins: [
          memStoragePlugin(),
          createCredentialsStoreDbPlugin(),
          authzProvider(AGENT_HOOK, () => {
            throw new Error('authz backend exploded');
          }),
          createCredentialsPlugin({}),
        ],
        config: {},
      });
      await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'mallory' });
      expect(await has(bus, ctx, 'account:linear', 'mallory')).toEqual({ present: false });
    });

    it('a global account: row when the global authorize hook denies', async () => {
      const bus = await makeBus({ globalAllows: false });
      await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-KEY');
      const { ctx } = recordingCtx({ userId: 'mallory' });
      expect(await has(bus, ctx, 'account:zendesk', 'mallory')).toEqual({ present: false });
    });

    it('a global account: row when NO global authorize hook is registered (fail closed)', async () => {
      const bus = await makeBus();
      await seed(bus, 'global', null, 'account:zendesk', 'COMPANY-KEY');
      const { ctx } = recordingCtx({ userId: 'mallory' });
      expect(await has(bus, ctx, 'account:zendesk', 'mallory')).toEqual({ present: false });
    });

    it('a denied agent step falls through to an allowed global step (same walk as get)', async () => {
      const bus = await makeBus({ agentAllows: false, globalAllows: true });
      await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
      await seed(bus, 'global', null, 'account:linear', 'COMPANY-KEY');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'admin' });
      expect(await has(bus, ctx, 'account:linear', 'admin')).toEqual({ present: true });
    });

    it('non-account refs never consult the authorize hooks', async () => {
      const agentCalls: unknown[] = [];
      const globalCalls: unknown[] = [];
      const bus = await makeBus({
        extra: [
          authzProvider(AGENT_HOOK, () => ({ allowed: false }), agentCalls),
          authzProvider(GLOBAL_HOOK, () => ({ allowed: false }), globalCalls),
        ],
      });
      await seed(bus, 'agent', 'team-agent', 'provider:anthropic', 'AGENT-KEY');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: true });
      expect(agentCalls).toEqual([]);
      expect(globalCalls).toEqual([]);
    });

    it('the gate runs BEFORE the read: a denied account: step is asked with {userId, agentId, ref}', async () => {
      const agentCalls: unknown[] = [];
      const bus = await makeBus({
        extra: [authzProvider(AGENT_HOOK, () => ({ allowed: false }), agentCalls)],
      });
      await seed(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-TOKEN');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'mallory' });
      expect(await has(bus, ctx, 'account:linear', 'mallory')).toEqual({ present: false });
      expect(agentCalls).toEqual([
        { userId: 'mallory', agentId: 'team-agent', ref: 'account:linear' },
      ]);
    });
  });

  // ------------------------------------------------------------- 3. tombstones

  describe('tombstones', () => {
    it('a tombstoned (deleted) row is not present', async () => {
      const bus = await makeBus();
      await seed(bus, 'user', 'bob', 'provider:anthropic', 'BOB-KEY');
      expect(
        await has(bus, recordingCtx({ userId: 'bob' }).ctx, 'provider:anthropic', 'bob'),
      ).toEqual({ present: true });
      await tombstone(bus, 'user', 'bob', 'provider:anthropic');
      expect(
        await has(bus, recordingCtx({ userId: 'bob' }).ctx, 'provider:anthropic', 'bob'),
      ).toEqual({ present: false });
    });

    it('a user-scope tombstone falls through to a lower scope that has a row', async () => {
      const bus = await makeBus();
      await seed(bus, 'user', 'bob', 'provider:anthropic', 'BOB-KEY');
      await tombstone(bus, 'user', 'bob', 'provider:anthropic');
      await seed(bus, 'agent', 'team-agent', 'provider:anthropic', 'AGENT-KEY');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: true });
    });

    it('tombstones at every scope -> not present', async () => {
      const bus = await makeBus();
      for (const [scope, ownerId] of [
        ['user', 'bob'],
        ['agent', 'team-agent'],
        ['global', null],
      ] as const) {
        await seed(bus, scope, ownerId, 'provider:anthropic', 'K');
        await tombstone(bus, scope, ownerId, 'provider:anthropic');
      }
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: false });
    });
  });

  // ----------------------------------------------------------- 4. env fallback

  describe('envFallback', () => {
    it('present when envFallback maps the ref to a set env var and no row exists', async () => {
      process.env.HAS_TEST_FALLBACK = 'ENV-SECRET';
      const bus = await makeBus({ envFallback: { 'provider:anthropic': 'HAS_TEST_FALLBACK' } });
      const { ctx, lines } = recordingCtx({ userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: true });
      // The value is never returned or logged.
      expect(JSON.stringify(lines)).not.toContain('ENV-SECRET');
    });

    it('present via envFallback even when every scope is tombstoned (same as get)', async () => {
      process.env.HAS_TEST_FALLBACK = 'ENV-SECRET';
      const bus = await makeBus({ envFallback: { 'provider:anthropic': 'HAS_TEST_FALLBACK' } });
      await seed(bus, 'user', 'bob', 'provider:anthropic', 'K');
      await tombstone(bus, 'user', 'bob', 'provider:anthropic');
      const { ctx } = recordingCtx({ userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: true });
    });

    it('not present when the mapped env var is unset or empty', async () => {
      const bus = await makeBus({ envFallback: { 'provider:anthropic': 'HAS_TEST_FALLBACK' } });
      const { ctx } = recordingCtx({ userId: 'bob' });
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: false });
      process.env.HAS_TEST_FALLBACK = '';
      expect(await has(bus, ctx, 'provider:anthropic', 'bob')).toEqual({ present: false });
    });

    it('absent everywhere resolves to { present: false } — it does NOT throw', async () => {
      const bus = await makeBus();
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });
      await expect(has(bus, ctx, 'provider:nope', 'bob')).resolves.toEqual({ present: false });
      // ... where get would have thrown.
      await expect(get(bus, ctx, 'provider:nope', 'bob')).rejects.toMatchObject({
        code: 'credential-not-found',
      });
    });
  });

  // --------------------------------------------------- 5. never resolves a row

  describe('never resolves (the point of the hook)', () => {
    function mcpOauthResolverPlugin(calls: unknown[]) {
      return {
        manifest: {
          name: 'mcp-oauth-resolver-spy',
          version: '0.0.0',
          registers: ['credentials:resolve:mcp-oauth'],
          calls: [],
          subscribes: [],
        },
        async init({ bus }: { bus: HookBus }) {
          bus.registerService(
            'credentials:resolve:mcp-oauth',
            'mcp-oauth-resolver-spy',
            async (_ctx, input: unknown) => {
              calls.push(input);
              // A refreshing resolver: it asks the facade to re-store the row.
              return { value: 'ACCESS-TOKEN', refreshed: { payload: enc('ROTATED-PAYLOAD') } };
            },
          );
        },
      };
    }

    // Connector credentials live on the agent (slice 5), so these rows are agent-scope.
    async function blobOf(bus: HookBus, ownerId: string, ref: string): Promise<Uint8Array> {
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'seed', userId: 'admin' });
      const out = await bus.call<
        { scope: 'agent'; ownerId: string; ref: string },
        { blob: Uint8Array | undefined }
      >('credentials:store-blob:get', ctx, { scope: 'agent', ownerId, ref });
      if (out.blob === undefined) throw new Error('row missing');
      return out.blob;
    }

    it('an mcp-oauth row is present with ZERO resolver calls and no re-store; get DOES call it', async () => {
      const resolverCalls: unknown[] = [];
      const bus = await makeBus({ agentAllows: true, extra: [mcpOauthResolverPlugin(resolverCalls)] });
      await seed(bus, 'agent', 'team-agent', 'account:linear', 'REFRESH-TOKEN-PAYLOAD', 'mcp-oauth');
      const before = await blobOf(bus, 'team-agent', 'account:linear');
      const { ctx, lines } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });

      // has: present, resolver untouched, stored row byte-identical (no credentials:set).
      expect(await has(bus, ctx, 'account:linear', 'bob')).toEqual({ present: true });
      expect(resolverCalls).toHaveLength(0);
      expect(Buffer.from(await blobOf(bus, 'team-agent', 'account:linear')).equals(Buffer.from(before))).toBe(
        true,
      );
      const logged = JSON.stringify(lines);
      expect(logged).not.toContain('REFRESH-TOKEN-PAYLOAD');
      expect(logged).not.toContain('ACCESS-TOKEN');

      // Contrast (so the zero above is not vacuous): get calls the resolver,
      // returns its value, and re-stores the refreshed payload.
      expect(await get(bus, ctx, 'account:linear', 'bob')).toBe('ACCESS-TOKEN');
      expect(resolverCalls).toHaveLength(1);
      expect(
        Buffer.from(await blobOf(bus, 'team-agent', 'account:linear')).equals(Buffer.from(before)),
      ).toBe(false);
    });

    it('a row of a kind with NO resolver loaded is still present (presence, not usability)', async () => {
      const bus = await makeBus({ agentAllows: true });
      await seed(bus, 'agent', 'team-agent', 'account:linear', 'X', 'mcp-oauth');
      const { ctx } = recordingCtx({ agentId: 'team-agent', userId: 'bob' });
      expect(await has(bus, ctx, 'account:linear', 'bob')).toEqual({ present: true });
      // get fails closed on the same row — has is deliberately weaker.
      await expect(get(bus, ctx, 'account:linear', 'bob')).rejects.toMatchObject({
        code: 'unsupported-credential-kind',
      });
    });

    it('never returns the secret: the output is exactly { present }', async () => {
      const bus = await makeBus();
      await seed(bus, 'user', 'bob', 'provider:anthropic', 'SUPER-SECRET');
      const { ctx } = recordingCtx({ userId: 'bob' });
      const out = await has(bus, ctx, 'provider:anthropic', 'bob');
      expect(Object.keys(out)).toEqual(['present']);
      expect(JSON.stringify(out)).not.toContain('SUPER-SECRET');
    });
  });

  // ------------------------------------------------------------- 6. validation

  describe('input validation (same as credentials:get)', () => {
    it.each([
      ['empty ref', '', 'bob'],
      ['ref with a space', 'bad ref', 'bob'],
      ['ref starting with a separator', ':nope', 'bob'],
      ['ref over 192 chars', 'a'.repeat(193), 'bob'],
      ['empty userId', 'provider:anthropic', ''],
      ['userId with a slash', 'provider:anthropic', 'bob/../alice'],
      ['userId over 128 chars', 'provider:anthropic', 'u'.repeat(129)],
    ])('rejects %s with invalid-payload, exactly like get', async (_label, ref, userId) => {
      const bus = await makeBus();
      const { ctx } = recordingCtx({ userId: 'bob' });
      const hasErr = await has(bus, ctx, ref, userId).then(
        () => undefined,
        (e: unknown) => e,
      );
      const getErr = await get(bus, ctx, ref, userId).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(hasErr).toBeInstanceOf(PluginError);
      expect((hasErr as PluginError).code).toBe('invalid-payload');
      expect((getErr as PluginError).code).toBe('invalid-payload');
    });

    it('rejects non-string ref / userId', async () => {
      const bus = await makeBus();
      const { ctx } = recordingCtx({ userId: 'bob' });
      await expect(
        bus.call('credentials:has', ctx, { ref: 42, userId: 'bob' }),
      ).rejects.toMatchObject({ code: 'invalid-payload' });
      await expect(
        bus.call('credentials:has', ctx, { ref: 'provider:anthropic', userId: undefined }),
      ).rejects.toMatchObject({ code: 'invalid-payload' });
    });
  });
});
