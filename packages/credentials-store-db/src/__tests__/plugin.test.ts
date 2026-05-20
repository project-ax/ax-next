import { describe, it, expect } from 'vitest';
import { HookBus, bootstrap, makeAgentContext, type Plugin } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '../plugin.js';

// Minimal in-memory storage:get / storage:set / storage:list-prefix plugin.
// Mirrors the helper in @ax/credentials's tests; lets us assert the underlying
// KV layout directly without standing up sqlite.
function memStoragePlugin(store?: Map<string, Uint8Array>): Plugin {
  const kv = store ?? new Map<string, Uint8Array>();
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

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

async function bootstrapWithMemStore(): Promise<HookBus> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin()],
    config: {},
  });
  return bus;
}

describe('@ax/credentials-store-db plugin', () => {
  it('registers credentials:store-blob:put / :get / :list', async () => {
    const bus = await bootstrapWithMemStore();
    expect(bus.hasService('credentials:store-blob:put')).toBe(true);
    expect(bus.hasService('credentials:store-blob:get')).toBe(true);
    expect(bus.hasService('credentials:store-blob:list')).toBe(true);
  });

  it('manifest declares storage:get / storage:set / storage:list-prefix as calls', () => {
    const p = createCredentialsStoreDbPlugin();
    expect(p.manifest.name).toBe('@ax/credentials-store-db');
    expect(p.manifest.registers).toContain('credentials:store-blob:put');
    expect(p.manifest.registers).toContain('credentials:store-blob:get');
    expect(p.manifest.registers).toContain('credentials:store-blob:list');
    expect(p.manifest.calls).toContain('storage:get');
    expect(p.manifest.calls).toContain('storage:set');
    expect(p.manifest.calls).toContain('storage:list-prefix');
    // Wired in for bootstrap:reset-cleanup; both storage backends
    // (storage-postgres + storage-sqlite) register this hook.
    expect(p.manifest.calls).toContain('storage:delete-prefix');
    expect(p.manifest.subscribes).toContain('bootstrap:reset-cleanup');
  });

  it('put then get round-trips a blob (scope=user)', async () => {
    const bus = await bootstrapWithMemStore();
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'user',
      ownerId: 'u',
      ref: 'r1',
      blob,
    });
    const got = await bus.call<
      { scope: string; ownerId: string | null; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { scope: 'user', ownerId: 'u', ref: 'r1' });
    expect(got.blob).toBeDefined();
    expect(Array.from(got.blob!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('get returns { blob: undefined } for missing (scope, ownerId, ref)', async () => {
    const bus = await bootstrapWithMemStore();
    const got = await bus.call<
      { scope: string; ownerId: string | null; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { scope: 'user', ownerId: 'u', ref: 'nope' });
    expect(got.blob).toBeUndefined();
  });

  it('put overwrites existing value at the same (scope, ownerId, ref)', async () => {
    const bus = await bootstrapWithMemStore();
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'user',
      ownerId: 'u',
      ref: 'r1',
      blob: new Uint8Array([1, 1]),
    });
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'user',
      ownerId: 'u',
      ref: 'r1',
      blob: new Uint8Array([9, 9, 9]),
    });
    const got = await bus.call<
      { scope: string; ownerId: string | null; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { scope: 'user', ownerId: 'u', ref: 'r1' });
    expect(Array.from(got.blob!)).toEqual([9, 9, 9]);
  });

  it('uses the "credential:v2:" key prefix when reading/writing storage', async () => {
    // Verify the seam through the storage:* layer directly. A vault-backed
    // sibling impl wouldn't go through storage at all, but the default
    // store-db's contract is exactly that it owns the `credential:v2:` prefix.
    const bus = await bootstrapWithMemStore();
    const blob = new Uint8Array([42, 42, 42]);
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'user',
      ownerId: 'u',
      ref: 'gh-token',
      blob,
    });
    const directly = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx(),
      { key: 'credential:v2:user:u:gh-token' },
    );
    expect(directly.value).toBeDefined();
    expect(Array.from(directly.value!)).toEqual([42, 42, 42]);
    // And the inverse: storage rows under any other prefix are invisible to
    // store-blob:get — the prefix isolates this plugin's namespace.
    await bus.call('storage:set', ctx(), {
      key: 'gh-token',
      value: new Uint8Array([1]),
    });
    const got = await bus.call<
      { scope: string; ownerId: string | null; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { scope: 'user', ownerId: 'u', ref: 'gh-token' });
    expect(Array.from(got.blob!)).toEqual([42, 42, 42]);
  });

  it('different ownerIds do not collide on the same ref', async () => {
    // (scope, ownerId, ref) is the unique key, not ref alone.
    const bus = await bootstrapWithMemStore();
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'user',
      ownerId: 'alice',
      ref: 'shared',
      blob: new Uint8Array([0xa1]),
    });
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'user',
      ownerId: 'bob',
      ref: 'shared',
      blob: new Uint8Array([0xb0]),
    });
    const a = await bus.call<
      { scope: string; ownerId: string | null; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { scope: 'user', ownerId: 'alice', ref: 'shared' });
    const b = await bus.call<
      { scope: string; ownerId: string | null; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { scope: 'user', ownerId: 'bob', ref: 'shared' });
    expect(Array.from(a.blob!)).toEqual([0xa1]);
    expect(Array.from(b.blob!)).toEqual([0xb0]);
  });

  it('rejects credentials:store-blob:put with an invalid ref', async () => {
    const bus = await bootstrapWithMemStore();
    await expect(
      bus.call('credentials:store-blob:put', ctx(), {
        scope: 'user',
        ownerId: 'u',
        ref: 'has space',
        blob: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects credentials:store-blob:put with an invalid ownerId', async () => {
    const bus = await bootstrapWithMemStore();
    await expect(
      bus.call('credentials:store-blob:put', ctx(), {
        scope: 'user',
        ownerId: 'has space',
        ref: 'r1',
        blob: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects credentials:store-blob:put with a non-Uint8Array blob', async () => {
    const bus = await bootstrapWithMemStore();
    await expect(
      bus.call('credentials:store-blob:put', ctx(), {
        scope: 'user',
        ownerId: 'u',
        ref: 'r1',
        blob: 'not bytes' as unknown as Uint8Array,
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects credentials:store-blob:get with an invalid ref', async () => {
    const bus = await bootstrapWithMemStore();
    await expect(
      bus.call('credentials:store-blob:get', ctx(), {
        scope: 'user',
        ownerId: 'u',
        ref: 'has space',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('round-trips through @ax/storage-sqlite end-to-end', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: ':memory:' }),
        createCredentialsStoreDbPlugin(),
      ],
      config: {},
    });
    const blob = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'user',
      ownerId: 'u',
      ref: 'r1',
      blob,
    });
    const got = await bus.call<
      { scope: string; ownerId: string | null; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { scope: 'user', ownerId: 'u', ref: 'r1' });
    expect(Array.from(got.blob!)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('bootstrap:reset-cleanup wipes every credential row (v1 + v2 prefixes)', async () => {
    const store = new Map<string, Uint8Array>();
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(store), createCredentialsStoreDbPlugin()],
      config: {},
    });
    // Seed three rows: a v2 user-scoped, a v2 global-scoped, and a v1
    // legacy row (different prefix shape).
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'user',
      ownerId: 'u',
      ref: 'provider:anthropic',
      blob: new Uint8Array([1, 2, 3]),
    });
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'global',
      ownerId: null,
      ref: 'provider:anthropic',
      blob: new Uint8Array([4, 5, 6]),
    });
    // Direct write to simulate a v1 row left over from before the v2 cutover.
    store.set('credential:legacy-user:legacy-ref', new Uint8Array([7, 8, 9]));
    // Neutral key that must survive — guards against an accidental
    // widening of the prefix sweep beyond `credential:*`.
    store.set('settings:fast-model', new Uint8Array([0]));
    expect(store.size).toBe(4);

    const fired = await bus.fire('bootstrap:reset-cleanup', ctx(), {});
    expect(fired.rejected).toBe(false);

    // All credential keys gone; the neutral key survives.
    for (const k of store.keys()) {
      expect(k.startsWith('credential:')).toBe(false);
    }
    expect(store.has('settings:fast-model')).toBe(true);
    expect(store.size).toBe(1);
  });
});
