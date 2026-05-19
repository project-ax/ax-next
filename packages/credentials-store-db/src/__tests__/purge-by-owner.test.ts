import { describe, it, expect } from 'vitest';
import { HookBus, bootstrap, makeAgentContext, type Plugin } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '../plugin.js';

// Minimal in-memory storage plugin — matches the shape in plugin.test.ts.
function memStoragePlugin(): Plugin {
  const kv = new Map<string, Uint8Array>();
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
    async init({ bus }) {
      bus.registerService('storage:get', 'mem-storage', async (_ctx, { key }: { key: string }) => ({
        value: kv.get(key),
      }));
      bus.registerService(
        'storage:set',
        'mem-storage',
        async (_ctx, { key, value }: { key: string; value: Uint8Array }) => {
          kv.set(key, value);
        },
      );
      bus.registerService(
        'storage:list-prefix',
        'mem-storage',
        async (_ctx, { prefix }: { prefix: string }) => {
          const entries: Array<{ key: string; value: Uint8Array }> = [];
          for (const [k, v] of kv.entries()) {
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
          for (const k of [...kv.keys()]) {
            if (k.startsWith(prefix)) {
              kv.delete(k);
              deleted++;
            }
          }
          return { deleted };
        },
      );
    },
  };
}

async function setupHarness() {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin()],
    config: {},
  });
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  return { bus, ctx };
}

describe('credentials:store-blob:purge-by-owner', () => {
  it('deletes every blob under (scope, ownerId) and returns the count', async () => {
    const h = await setupHarness();
    // Seed 3 agent-scope rows for agt-X, 1 row for agt-Y, 1 global row.
    for (const ref of ['a', 'b', 'c']) {
      await h.bus.call('credentials:store-blob:put', h.ctx, {
        scope: 'agent', ownerId: 'agt-X', ref, blob: new Uint8Array([1]),
      });
    }
    await h.bus.call('credentials:store-blob:put', h.ctx, {
      scope: 'agent', ownerId: 'agt-Y', ref: 'a', blob: new Uint8Array([1]),
    });
    await h.bus.call('credentials:store-blob:put', h.ctx, {
      scope: 'global', ownerId: null, ref: 'g', blob: new Uint8Array([1]),
    });

    const out = await h.bus.call<
      { scope: 'agent'; ownerId: string },
      { deleted: number }
    >('credentials:store-blob:purge-by-owner', h.ctx, {
      scope: 'agent', ownerId: 'agt-X',
    });
    expect(out.deleted).toBe(3);

    // Other rows survive.
    const list = await h.bus.call('credentials:store-blob:list', h.ctx, {});
    const refs = (list as { entries: Array<{ scope: string; ownerId: string | null; ref: string }> }).entries.map(
      (e) => `${e.scope}:${e.ownerId}:${e.ref}`,
    );
    expect(refs.sort()).toEqual(['agent:agt-Y:a', 'global:null:g'].sort());
  });

  it('rejects scope=global', async () => {
    const h = await setupHarness();
    await expect(
      h.bus.call('credentials:store-blob:purge-by-owner', h.ctx, {
        scope: 'global', ownerId: null,
      }),
    ).rejects.toThrow(/global/);
  });

  it('returns deleted=0 when no rows match', async () => {
    const h = await setupHarness();
    const out = await h.bus.call('credentials:store-blob:purge-by-owner', h.ctx, {
      scope: 'agent', ownerId: 'never-seeded',
    });
    expect((out as { deleted: number }).deleted).toBe(0);
  });
});
