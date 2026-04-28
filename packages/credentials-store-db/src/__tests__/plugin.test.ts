import { describe, it, expect } from 'vitest';
import { HookBus, bootstrap, makeAgentContext, type Plugin } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '../plugin.js';

// Minimal in-memory storage:get / storage:set plugin. Mirrors the helper
// in @ax/credentials's tests; lets us assert the underlying KV layout
// directly without standing up sqlite.
function memStoragePlugin(): Plugin {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: ['storage:get', 'storage:set'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
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
  it('registers credentials:store-blob:put and credentials:store-blob:get', async () => {
    const bus = await bootstrapWithMemStore();
    expect(bus.hasService('credentials:store-blob:put')).toBe(true);
    expect(bus.hasService('credentials:store-blob:get')).toBe(true);
  });

  it('manifest declares storage:get / storage:set as calls', () => {
    const p = createCredentialsStoreDbPlugin();
    expect(p.manifest.name).toBe('@ax/credentials-store-db');
    expect(p.manifest.registers).toContain('credentials:store-blob:put');
    expect(p.manifest.registers).toContain('credentials:store-blob:get');
    expect(p.manifest.calls).toContain('storage:get');
    expect(p.manifest.calls).toContain('storage:set');
  });

  it('put then get round-trips a blob', async () => {
    const bus = await bootstrapWithMemStore();
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    await bus.call('credentials:store-blob:put', ctx(), { userId: 'u', ref: 'r1', blob });
    const got = await bus.call<
      { userId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { userId: 'u', ref: 'r1' });
    expect(got.blob).toBeDefined();
    expect(Array.from(got.blob!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('get returns { blob: undefined } for missing (userId, ref)', async () => {
    const bus = await bootstrapWithMemStore();
    const got = await bus.call<
      { userId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { userId: 'u', ref: 'nope' });
    expect(got.blob).toBeUndefined();
  });

  it('put overwrites existing value at the same (userId, ref)', async () => {
    const bus = await bootstrapWithMemStore();
    await bus.call('credentials:store-blob:put', ctx(), {
      userId: 'u',
      ref: 'r1',
      blob: new Uint8Array([1, 1]),
    });
    await bus.call('credentials:store-blob:put', ctx(), {
      userId: 'u',
      ref: 'r1',
      blob: new Uint8Array([9, 9, 9]),
    });
    const got = await bus.call<
      { userId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { userId: 'u', ref: 'r1' });
    expect(Array.from(got.blob!)).toEqual([9, 9, 9]);
  });

  it('uses the "credential:<userId>:" key prefix when reading/writing storage', async () => {
    // Verify the seam through the storage:* layer directly. A vault-backed
    // sibling impl wouldn't go through storage at all, but the default
    // store-db's contract is exactly that it owns the `credential:` prefix.
    const bus = await bootstrapWithMemStore();
    const blob = new Uint8Array([42, 42, 42]);
    await bus.call('credentials:store-blob:put', ctx(), {
      userId: 'u',
      ref: 'gh-token',
      blob,
    });
    const directly = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx(),
      { key: 'credential:u:gh-token' },
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
      { userId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { userId: 'u', ref: 'gh-token' });
    expect(Array.from(got.blob!)).toEqual([42, 42, 42]);
  });

  it('different userIds do not collide on the same ref', async () => {
    // I14: (userId, ref) is the unique key, not ref alone.
    const bus = await bootstrapWithMemStore();
    await bus.call('credentials:store-blob:put', ctx(), {
      userId: 'alice',
      ref: 'shared',
      blob: new Uint8Array([0xa1]),
    });
    await bus.call('credentials:store-blob:put', ctx(), {
      userId: 'bob',
      ref: 'shared',
      blob: new Uint8Array([0xb0]),
    });
    const a = await bus.call<
      { userId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { userId: 'alice', ref: 'shared' });
    const b = await bus.call<
      { userId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { userId: 'bob', ref: 'shared' });
    expect(Array.from(a.blob!)).toEqual([0xa1]);
    expect(Array.from(b.blob!)).toEqual([0xb0]);
  });

  it('rejects credentials:store-blob:put with an invalid ref', async () => {
    const bus = await bootstrapWithMemStore();
    await expect(
      bus.call('credentials:store-blob:put', ctx(), {
        userId: 'u',
        ref: 'has space',
        blob: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects credentials:store-blob:put with an invalid userId', async () => {
    const bus = await bootstrapWithMemStore();
    await expect(
      bus.call('credentials:store-blob:put', ctx(), {
        userId: 'has space',
        ref: 'r1',
        blob: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects credentials:store-blob:put with a non-Uint8Array blob', async () => {
    const bus = await bootstrapWithMemStore();
    await expect(
      bus.call('credentials:store-blob:put', ctx(), {
        userId: 'u',
        ref: 'r1',
        blob: 'not bytes' as unknown as Uint8Array,
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects credentials:store-blob:get with an invalid ref', async () => {
    const bus = await bootstrapWithMemStore();
    await expect(
      bus.call('credentials:store-blob:get', ctx(), { userId: 'u', ref: 'has space' }),
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
    await bus.call('credentials:store-blob:put', ctx(), { userId: 'u', ref: 'r1', blob });
    const got = await bus.call<
      { userId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx(), { userId: 'u', ref: 'r1' });
    expect(Array.from(got.blob!)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});
