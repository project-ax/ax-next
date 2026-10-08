/**
 * no-person-connector-credentials.test.ts — agent-owned sign-ins, slice 5.
 *
 * The core guarantee of the epic: an agent never acts as the person chatting
 * with it. So a connector credential (`account:` ref) resolves only from the
 * agent the session runs as, then the global scope — never from the person's
 * own (user) scope — and nothing can write one at user scope any more.
 *
 * Every other ref namespace (`provider:`, `skill:`, `routine:`, a retired
 * `mcp:` row) keeps the full user -> agent -> global walk.
 *
 * Person-level `account:` rows are planted through the store-blob seam
 * (legacy-rows.ts), the way a vault written before this slice holds them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type AgentContext,
} from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';
import { putLegacyRow } from './legacy-rows.js';

const GLOBAL_HOOK = 'credentials:authorize-global:account';
const AGENT_HOOK = 'credentials:authorize-agent:account';
const TEST_KEY_HEX = '42'.repeat(32);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const REFUSAL =
  "connector credentials ('account:' refs) can't be stored per person; store them on the agent or globally";

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

function authzProvider(hook: string, calls: unknown[] = []) {
  const name = hook === AGENT_HOOK ? 'agent-authz-stub' : 'global-authz-stub';
  return {
    manifest: { name, version: '0.0.0', registers: [hook], calls: [], subscribes: [] },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService(hook, name, async (_ctx, input: unknown) => {
        calls.push(input);
        return { allowed: true };
      });
    },
  };
}

/** A refreshing `credentials:resolve:mcp-oauth`: every read rotates the stored payload. */
function refreshingResolver(calls: unknown[]) {
  return {
    manifest: {
      name: 'mcp-oauth-resolver-spy',
      version: '0.0.0',
      registers: ['credentials:resolve:mcp-oauth'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService('credentials:resolve:mcp-oauth', 'mcp-oauth-resolver-spy', async (_ctx, input: unknown) => {
        calls.push(input);
        return { value: 'ACCESS-TOKEN', refreshed: { payload: enc('ROTATED-PAYLOAD') } };
      });
    },
  };
}

describe('connector credentials never resolve from, or write to, the person\'s own scope', () => {
  let savedKey: string | undefined;
  let savedFallback: string | undefined;

  beforeEach(() => {
    savedKey = process.env.AX_CREDENTIALS_KEY;
    savedFallback = process.env.NPCC_FALLBACK;
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
    delete process.env.NPCC_FALLBACK;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
    if (savedFallback === undefined) delete process.env.NPCC_FALLBACK;
    else process.env.NPCC_FALLBACK = savedFallback;
  });

  async function makeBus(
    opts: {
      agentCalls?: unknown[];
      globalCalls?: unknown[];
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
        authzProvider(AGENT_HOOK, opts.agentCalls),
        authzProvider(GLOBAL_HOOK, opts.globalCalls),
        ...((opts.extra ?? []) as never[]),
        createCredentialsPlugin(opts.envFallback !== undefined ? { envFallback: opts.envFallback } : {}),
      ],
      config: {},
    });
    return bus;
  }

  const adminCtx = () => makeAgentContext({ sessionId: 'seed', agentId: 'seed', userId: 'admin' });
  const sessionCtx = (agentId: string, userId: string) =>
    makeAgentContext({ sessionId: 's', agentId, userId });

  const set = (bus: HookBus, scope: 'user' | 'agent' | 'global', ownerId: string | null, ref: string, value: string) =>
    bus.call('credentials:set', adminCtx(), { scope, ownerId, ref, kind: 'api-key', payload: enc(value) });

  const get = (bus: HookBus, ctx: AgentContext, ref: string, userId: string) =>
    bus.call<{ ref: string; userId: string }, string>('credentials:get', ctx, { ref, userId });

  const has = (bus: HookBus, ctx: AgentContext, ref: string, userId: string) =>
    bus.call<{ ref: string; userId: string }, { present: boolean }>('credentials:has', ctx, { ref, userId });

  const blobAt = async (bus: HookBus, scope: 'user' | 'agent' | 'global', ownerId: string | null, ref: string) =>
    (
      await bus.call<object, { blob: Uint8Array | undefined }>('credentials:store-blob:get', adminCtx(), {
        scope,
        ownerId,
        ref,
      })
    ).blob;

  describe('lookup: agent -> global only for account: refs', () => {
    it('a person\'s own account: row loses to the agent\'s row', async () => {
      const agentCalls: unknown[] = [];
      const bus = await makeBus({ agentCalls });
      await putLegacyRow(bus, 'user', 'bob', 'account:linear', 'BOB-OWN');
      await set(bus, 'agent', 'team-agent', 'account:linear', 'AGENT-TOKEN');
      const ctx = sessionCtx('team-agent', 'bob');

      expect(await get(bus, ctx, 'account:linear', 'bob')).toBe('AGENT-TOKEN');
      expect(await has(bus, ctx, 'account:linear', 'bob')).toEqual({ present: true });
      // The agent gate was actually consulted — the user step didn't short-circuit it.
      expect(agentCalls).toHaveLength(2);
    });

    it('with only the person\'s own row, the ref is not found (get) and not present (has)', async () => {
      const bus = await makeBus();
      await putLegacyRow(bus, 'user', 'bob', 'account:linear', 'BOB-OWN');
      await putLegacyRow(bus, 'user', 'bob', 'account:linear:API_TOKEN', 'BOB-SLOT');
      const ctx = sessionCtx('team-agent', 'bob');

      for (const ref of ['account:linear', 'account:linear:API_TOKEN']) {
        const err = await get(bus, ctx, ref, 'bob').then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(PluginError);
        expect((err as PluginError).code).toBe('credential-not-found');
        expect((err as PluginError).message).not.toContain('BOB-');
        expect(await has(bus, ctx, ref, 'bob')).toEqual({ present: false });
      }
    });

    it('with no agent on the session, a person\'s own row loses to the global row', async () => {
      const bus = await makeBus();
      await putLegacyRow(bus, 'user', 'alice', 'account:zendesk', 'ALICE-OWN');
      await set(bus, 'global', null, 'account:zendesk', 'COMPANY-KEY');
      const ctx = sessionCtx('', 'alice');

      expect(await get(bus, ctx, 'account:zendesk', 'alice')).toBe('COMPANY-KEY');
      expect(await has(bus, ctx, 'account:zendesk', 'alice')).toEqual({ present: true });
    });

    it('the operator env fallback is unchanged: a person\'s own row does not mask it', async () => {
      process.env.NPCC_FALLBACK = 'FROM-ENV';
      const bus = await makeBus({ envFallback: { 'account:zendesk': 'NPCC_FALLBACK' } });
      await putLegacyRow(bus, 'user', 'alice', 'account:zendesk', 'ALICE-OWN');
      const ctx = sessionCtx('team-agent', 'alice');

      expect(await get(bus, ctx, 'account:zendesk', 'alice')).toBe('FROM-ENV');
      expect(await has(bus, ctx, 'account:zendesk', 'alice')).toEqual({ present: true });
    });

    it('provider:, skill:, routine: and mcp: refs still resolve from the person\'s own scope first', async () => {
      const bus = await makeBus();
      const refs = ['provider:anthropic', 'skill:s1:API_KEY', 'routine:r1:TOKEN', 'mcp:legacy'];
      for (const ref of refs) {
        await set(bus, 'user', 'bob', ref, `BOB:${ref}`);
        await set(bus, 'agent', 'team-agent', ref, `AGENT:${ref}`);
      }
      const ctx = sessionCtx('team-agent', 'bob');
      for (const ref of refs) {
        expect(await get(bus, ctx, ref, 'bob')).toBe(`BOB:${ref}`);
        expect(await has(bus, ctx, ref, 'bob')).toEqual({ present: true });
      }
    });
  });

  describe('write: credentials:set refuses account: at user scope', () => {
    it.each(['account:linear', 'account:linear:API_TOKEN'])(
      'refuses %s at user scope and writes nothing',
      async (ref) => {
        const bus = await makeBus();
        const err = await set(bus, 'user', 'bob', ref, 'BOB-OWN').then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(PluginError);
        expect((err as PluginError).code).toBe('invalid-payload');
        expect((err as PluginError).message).toBe(REFUSAL);
        expect(await blobAt(bus, 'user', 'bob', ref)).toBeUndefined();
      },
    );

    it('accepts account: at agent and global scope', async () => {
      const bus = await makeBus();
      await set(bus, 'agent', 'team-agent', 'account:linear', 'AGENT-TOKEN');
      await set(bus, 'global', null, 'account:zendesk', 'COMPANY-KEY');
      expect(await blobAt(bus, 'agent', 'team-agent', 'account:linear')).toBeInstanceOf(Uint8Array);
      expect(await blobAt(bus, 'global', null, 'account:zendesk')).toBeInstanceOf(Uint8Array);
    });

    it('accepts every other namespace at user scope', async () => {
      const bus = await makeBus();
      for (const ref of ['provider:anthropic', 'skill:s1:API_KEY', 'routine:r1:TOKEN']) {
        await set(bus, 'user', 'bob', ref, 'v');
        expect(await blobAt(bus, 'user', 'bob', ref)).toBeInstanceOf(Uint8Array);
      }
    });

    it('credentials:delete still tombstones an old user-scope account: row', async () => {
      const bus = await makeBus();
      await putLegacyRow(bus, 'user', 'bob', 'account:linear', 'BOB-OWN');
      await bus.call('credentials:delete', adminCtx(), { scope: 'user', ownerId: 'bob', ref: 'account:linear' });
      const out = await bus.call<object, { credentials: Array<{ ref: string }> }>('credentials:list', adminCtx(), {
        scope: 'user',
        ownerId: 'bob',
      });
      expect(out.credentials).toEqual([]);
    });
  });

  describe('refresh', () => {
    it('a refreshed agent-scope account: token re-stores at agent scope without tripping the refusal', async () => {
      const resolverCalls: unknown[] = [];
      const bus = await makeBus({ extra: [refreshingResolver(resolverCalls)] });
      await bus.call('credentials:set', adminCtx(), {
        scope: 'agent',
        ownerId: 'team-agent',
        ref: 'account:linear',
        kind: 'mcp-oauth',
        payload: enc('REFRESH-TOKEN'),
      });
      const before = await blobAt(bus, 'agent', 'team-agent', 'account:linear');

      expect(await get(bus, sessionCtx('team-agent', 'bob'), 'account:linear', 'bob')).toBe('ACCESS-TOKEN');
      expect(resolverCalls).toEqual([
        expect.objectContaining({ scope: 'agent', ownerId: 'team-agent', ref: 'account:linear' }),
      ]);
      const after = await blobAt(bus, 'agent', 'team-agent', 'account:linear');
      expect(Buffer.from(after!).equals(Buffer.from(before!))).toBe(false);
      // Nothing landed at the person's scope.
      expect(await blobAt(bus, 'user', 'bob', 'account:linear')).toBeUndefined();
    });

    it('a person\'s own OAuth row is never handed to the resolver', async () => {
      const resolverCalls: unknown[] = [];
      const bus = await makeBus({ extra: [refreshingResolver(resolverCalls)] });
      await putLegacyRow(bus, 'user', 'bob', 'account:linear', 'BOB-REFRESH', 'mcp-oauth');

      await expect(get(bus, sessionCtx('team-agent', 'bob'), 'account:linear', 'bob')).rejects.toMatchObject({
        code: 'credential-not-found',
      });
      expect(resolverCalls).toEqual([]);
    });
  });
});
