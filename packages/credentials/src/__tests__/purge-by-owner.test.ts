import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, bootstrap } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

function memStoragePlugin() {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: [
        'storage:get',
        'storage:set',
        'storage:list-prefix',
        'storage:delete-prefix',
      ],
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

const TEST_KEY_HEX = '42'.repeat(32);

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

async function makeHarness() {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
    config: {},
  });
  return { bus, ctx: ctx() };
}

describe('credentials:purge-by-owner', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });

  it('bulk-deletes all credentials for (scope=agent, ownerId)', async () => {
    const h = await makeHarness();
    const seed = async (ref: string) =>
      h.bus.call('credentials:set', h.ctx, {
        scope: 'agent',
        ownerId: 'agt-X',
        ref,
        kind: 'api-key',
        payload: new TextEncoder().encode('x'),
      });
    await seed('skill:s1:A');
    await seed('skill:s2:B');
    await h.bus.call('credentials:set', h.ctx, {
      scope: 'agent',
      ownerId: 'agt-Y',
      ref: 'skill:s1:A',
      kind: 'api-key',
      payload: new TextEncoder().encode('keep'),
    });

    const out = await h.bus.call<
      { scope: 'agent'; ownerId: string },
      { deleted: number }
    >('credentials:purge-by-owner', h.ctx, {
      scope: 'agent',
      ownerId: 'agt-X',
    });
    expect(out.deleted).toBe(2);

    const list = await h.bus.call('credentials:list', h.ctx, {
      scope: 'agent',
      ownerId: 'agt-X',
    });
    expect((list as { credentials: unknown[] }).credentials).toEqual([]);
  });

  it('rejects scope=global', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call('credentials:purge-by-owner', h.ctx, {
        scope: 'global' as unknown as 'user',
        ownerId: null as unknown as string,
      }),
    ).rejects.toThrow(/global/);
  });

  it('returns deleted=0 when nothing matches', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<
      { scope: 'user'; ownerId: string },
      { deleted: number }
    >('credentials:purge-by-owner', h.ctx, {
      scope: 'user',
      ownerId: 'never',
    });
    expect(out.deleted).toBe(0);
  });
});
