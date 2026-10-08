/**
 * request_capability's `haveExisting` against the REAL vault (agent-owned
 * sign-ins, slice 5).
 *
 * The approval card offers "use your existing key" when the session can
 * already resolve the connector's `account:` ref. Since slice 5 that means
 * the session's AGENT holds it (or a shared global key) — a person-level
 * row is never read for an `account:` ref, so it must not light up the card
 * either. A user-scope `credentials:list` would still list such a row until
 * the boot purge removes it, which is why the broker asks `credentials:has`
 * under the session ctx instead.
 *
 * Test-only peer imports (@ax/credentials, @ax/credentials-store-db) are how
 * this file reaches the real vault; the plugin itself talks to it over the bus.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HookBus, bootstrap, makeAgentContext, type AgentContext } from '@ax/core';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createSkillBrokerPlugin } from '../plugin.js';

const TEST_KEY_HEX = '17'.repeat(32);
const REF = 'account:linear';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

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
      bus.registerService('storage:set', 'mem-storage', async (_ctx, { key, value }: { key: string; value: Uint8Array }) => {
        store.set(key, value);
      });
      bus.registerService('storage:list-prefix', 'mem-storage', async (_ctx, { prefix }: { prefix: string }) => ({
        entries: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }));
      bus.registerService('storage:delete-prefix', 'mem-storage', async (_ctx, { prefix }: { prefix: string }) => {
        let deleted = 0;
        for (const k of [...store.keys()]) {
          if (k.startsWith(prefix)) {
            store.delete(k);
            deleted++;
          }
        }
        return { deleted };
      });
    },
  };
}

/** @ax/connectors' role in production: allow the agent / global step for this ref. */
function authzAllow(hook: string) {
  const name = `${hook}-stub`;
  return {
    manifest: { name, version: '0.0.0', registers: [hook], calls: [], subscribes: [] },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService(hook, name, async () => ({ allowed: true }));
    },
  };
}

/** The catalog + connector stubs the broker reads to build the card. */
function catalogStubs() {
  return {
    manifest: {
      name: 'catalog-stubs',
      version: '0.0.0',
      registers: ['tool:register', 'skills:search-catalog', 'skills:get', 'connectors:resolve'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService('tool:register', 'catalog-stubs', async () => ({ ok: true }));
      bus.registerService('skills:search-catalog', 'catalog-stubs', async () => ({ skills: [] }));
      bus.registerService('skills:get', 'catalog-stubs', async () => ({
        id: 'linear',
        description: 'Read your Linear issues',
        version: 1,
        connectors: ['linear'],
      }));
      bus.registerService('connectors:resolve', 'catalog-stubs', async () => ({
        id: 'linear',
        keyMode: 'personal',
        capabilities: {
          allowedHosts: ['api.linear.app'],
          credentials: [{ slot: 'LINEAR_TOKEN', kind: 'api-key' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }));
    },
  };
}

describe('request_capability haveExisting — the real vault', () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
  });

  async function boot(): Promise<HookBus> {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        memStoragePlugin(),
        createCredentialsStoreDbPlugin(),
        authzAllow('credentials:authorize-agent:account'),
        authzAllow('credentials:authorize-global:account'),
        createCredentialsPlugin(),
        catalogStubs(),
        createSkillBrokerPlugin(),
      ],
      config: {},
    });
    return bus;
  }

  const adminCtx = () => makeAgentContext({ sessionId: 'seed', agentId: 'seed', userId: 'admin' });
  const sessionCtx = (): AgentContext =>
    makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'bob', conversationId: 'cnv_1' });

  async function haveExisting(bus: HookBus): Promise<unknown> {
    const cards: Array<{ slots: Array<{ haveExisting?: boolean }> }> = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });
    await bus.call('tool:execute:request_capability', sessionCtx(), {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    expect(cards).toHaveLength(1);
    return cards[0]!.slots[0]!.haveExisting;
  }

  it('is true when the session\'s agent has the key', async () => {
    const bus = await boot();
    await bus.call('credentials:set', adminCtx(), {
      scope: 'agent',
      ownerId: 'agent-1',
      ref: REF,
      kind: 'api-key',
      payload: enc('AGENT-KEY'),
    });
    expect(await haveExisting(bus)).toBe(true);
  });

  it('is false when only a person-level row exists (it is never read for an account: ref)', async () => {
    const bus = await boot();
    // Plant bob's old person-level row the way a pre-slice-5 vault holds it:
    // `credentials:set` refuses the write now, so copy a valid sealed blob
    // into user scope through the store seam.
    await bus.call('credentials:set', adminCtx(), {
      scope: 'agent',
      ownerId: 'scratch',
      ref: REF,
      kind: 'api-key',
      payload: enc('BOB-PERSONAL-KEY'),
    });
    const { blob } = await bus.call<object, { blob: Uint8Array | undefined }>(
      'credentials:store-blob:get',
      adminCtx(),
      { scope: 'agent', ownerId: 'scratch', ref: REF },
    );
    await bus.call('credentials:store-blob:put', adminCtx(), { scope: 'user', ownerId: 'bob', ref: REF, blob });
    await bus.call('credentials:delete', adminCtx(), { scope: 'agent', ownerId: 'scratch', ref: REF });

    // The row is there (a user-scope listing still shows it)...
    const listed = await bus.call<object, { credentials: Array<{ ref: string }> }>(
      'credentials:list',
      adminCtx(),
      { scope: 'user', ownerId: 'bob' },
    );
    expect(listed.credentials.map((c) => c.ref)).toContain(REF);
    // ...but it does not count: the agent has no key, so the card prompts.
    expect(await haveExisting(bus)).toBe(false);
  });

  // SIGNINS-7 — another agent's key is that agent's alone. The authz stub
  // allows every agent here, so the only thing keeping it out is the vault
  // reading the SESSION's agent row and no other.
  it("is false when only another agent has the key", async () => {
    const bus = await boot();
    await bus.call('credentials:set', adminCtx(), {
      scope: 'agent',
      ownerId: 'agent-2',
      ref: REF,
      kind: 'api-key',
      payload: enc('OTHER-AGENT-KEY'),
    });
    expect(await haveExisting(bus)).toBe(false);
  });

  it('is false with an empty vault', async () => {
    const bus = await boot();
    expect(await haveExisting(bus)).toBe(false);
  });
});
