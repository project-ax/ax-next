import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, bootstrap, PluginError } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

// Minimal in-memory storage plugin for the test.
function memStoragePlugin() {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: ['storage:get', 'storage:set'],
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
    },
  };
}

const TEST_KEY_HEX = '42'.repeat(32);

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('@ax/credentials plugin', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });

  it('round-trips a credential via credentials:set / credentials:get', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'gh-token',
      userId: 'u',
      kind: 'api-key',
      payload: bytes('ghp_abc123'),
    });
    const got = await bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      ctx(),
      { ref: 'gh-token', userId: 'u' },
    );
    expect(got).toBe('ghp_abc123');
  });

  it('credentials:get returns a structured error for unknown refs', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await expect(
      bus.call('credentials:get', ctx(), { ref: 'missing', userId: 'u' }),
    ).rejects.toMatchObject({ code: 'credential-not-found' });
  });

  it('credentials:delete removes the credential', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'x',
      userId: 'u',
      kind: 'api-key',
      payload: bytes('v'),
    });
    await bus.call('credentials:delete', ctx(), { ref: 'x', userId: 'u' });
    await expect(
      bus.call('credentials:get', ctx(), { ref: 'x', userId: 'u' }),
    ).rejects.toMatchObject({ code: 'credential-not-found' });
  });

  it('rejects credentials:set with an invalid ref', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await expect(
      bus.call('credentials:set', ctx(), {
        ref: 'has space',
        userId: 'u',
        kind: 'api-key',
        payload: bytes('v'),
      }),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('rejects credentials:set with an invalid userId', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await expect(
      bus.call('credentials:set', ctx(), {
        ref: 'r1',
        userId: 'has space',
        kind: 'api-key',
        payload: bytes('v'),
      }),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('rejects credentials:set with an invalid kind', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await expect(
      bus.call('credentials:set', ctx(), {
        ref: 'r1',
        userId: 'u',
        kind: 'BAD KIND',
        payload: bytes('v'),
      }),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('different userIds do not collide on the same ref', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'shared',
      userId: 'alice',
      kind: 'api-key',
      payload: bytes('alice-secret'),
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'shared',
      userId: 'bob',
      kind: 'api-key',
      payload: bytes('bob-secret'),
    });
    expect(
      await bus.call<{ ref: string; userId: string }, string>(
        'credentials:get',
        ctx(),
        { ref: 'shared', userId: 'alice' },
      ),
    ).toBe('alice-secret');
    expect(
      await bus.call<{ ref: string; userId: string }, string>(
        'credentials:get',
        ctx(),
        { ref: 'shared', userId: 'bob' },
      ),
    ).toBe('bob-secret');
  });

  it('init throws if AX_CREDENTIALS_KEY is missing', async () => {
    delete process.env.AX_CREDENTIALS_KEY;
    const bus = new HookBus();
    await expect(
      bootstrap({
        bus,
        plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
        config: {},
      }),
    ).rejects.toThrow(/AX_CREDENTIALS_KEY/);
  });

  it('credentials:get dispatches to credentials:resolve:<kind> when sub-service is registered', async () => {
    const bus = new HookBus();
    let captured:
      | { payload: Uint8Array; userId: string; ref: string }
      | undefined;
    const fakeResolverPlugin = {
      manifest: {
        name: 'fake-resolver',
        version: '0.0.0',
        registers: ['credentials:resolve:fake-oauth'],
        calls: [],
        subscribes: [],
      },
      async init({ bus }: { bus: HookBus }) {
        bus.registerService(
          'credentials:resolve:fake-oauth',
          'fake-resolver',
          async (_ctx, input: { payload: Uint8Array; userId: string; ref: string }) => {
            captured = input;
            return { value: 'token-from-resolver' };
          },
        );
      },
    };
    await bootstrap({
      bus,
      plugins: [
        memStoragePlugin(),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        fakeResolverPlugin,
      ],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'oauth1',
      userId: 'u',
      kind: 'fake-oauth',
      payload: bytes('refresh-token-blob'),
    });
    const out = await bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      ctx(),
      { ref: 'oauth1', userId: 'u' },
    );
    expect(out).toBe('token-from-resolver');
    expect(captured?.userId).toBe('u');
    expect(captured?.ref).toBe('oauth1');
    expect(new TextDecoder().decode(captured?.payload)).toBe('refresh-token-blob');
  });

  it('credentials:get re-stores when sub-service returns refreshed blob', async () => {
    const bus = new HookBus();
    let firstCall = true;
    const fakeResolverPlugin = {
      manifest: {
        name: 'fake-resolver',
        version: '0.0.0',
        registers: ['credentials:resolve:fake-oauth'],
        calls: [],
        subscribes: [],
      },
      async init({ bus }: { bus: HookBus }) {
        bus.registerService(
          'credentials:resolve:fake-oauth',
          'fake-resolver',
          async (
            _ctx,
            input: { payload: Uint8Array; userId: string; ref: string },
          ): Promise<{
            value: string;
            refreshed?: { payload: Uint8Array; expiresAt?: number };
          }> => {
            if (firstCall) {
              firstCall = false;
              return {
                value: 'token-A',
                refreshed: {
                  payload: bytes('refresh-token-v2'),
                  expiresAt: 12345,
                },
              };
            }
            // Second call should see the refreshed payload, not the original.
            expect(new TextDecoder().decode(input.payload)).toBe('refresh-token-v2');
            return { value: 'token-B' };
          },
        );
      },
    };
    await bootstrap({
      bus,
      plugins: [
        memStoragePlugin(),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        fakeResolverPlugin,
      ],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'oauth1',
      userId: 'u',
      kind: 'fake-oauth',
      payload: bytes('refresh-token-v1'),
    });
    const first = await bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      ctx(),
      { ref: 'oauth1', userId: 'u' },
    );
    expect(first).toBe('token-A');
    const second = await bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      ctx(),
      { ref: 'oauth1', userId: 'u' },
    );
    expect(second).toBe('token-B');
  });

  it('serializes concurrent credentials:get for the same (userId, ref) — only one resolve fires (I7)', async () => {
    const bus = new HookBus();
    let resolveCount = 0;
    const slowResolverPlugin = {
      manifest: {
        name: 'slow-resolver',
        version: '0.0.0',
        registers: ['credentials:resolve:slow-oauth'],
        calls: [],
        subscribes: [],
      },
      async init({ bus }: { bus: HookBus }) {
        bus.registerService('credentials:resolve:slow-oauth', 'slow-resolver', async () => {
          resolveCount++;
          await new Promise((r) => setTimeout(r, 50));
          return { value: `token-${resolveCount}` };
        });
      },
    };
    await bootstrap({
      bus,
      plugins: [
        memStoragePlugin(),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        slowResolverPlugin,
      ],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'r1',
      userId: 'u',
      kind: 'slow-oauth',
      payload: bytes('blob'),
    });
    const [a, b] = await Promise.all([
      bus.call<{ ref: string; userId: string }, string>('credentials:get', ctx(), {
        ref: 'r1',
        userId: 'u',
      }),
      bus.call<{ ref: string; userId: string }, string>('credentials:get', ctx(), {
        ref: 'r1',
        userId: 'u',
      }),
    ]);
    expect(resolveCount).toBe(1);
    expect(a).toBe(b);
  });

  it('different (userId, ref) pairs run resolves in parallel', async () => {
    const bus = new HookBus();
    const startTimes: number[] = [];
    const slowResolverPlugin = {
      manifest: {
        name: 'slow-resolver',
        version: '0.0.0',
        registers: ['credentials:resolve:slow-oauth'],
        calls: [],
        subscribes: [],
      },
      async init({ bus }: { bus: HookBus }) {
        bus.registerService('credentials:resolve:slow-oauth', 'slow-resolver', async () => {
          startTimes.push(Date.now());
          await new Promise((r) => setTimeout(r, 30));
          return { value: 'ok' };
        });
      },
    };
    await bootstrap({
      bus,
      plugins: [
        memStoragePlugin(),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        slowResolverPlugin,
      ],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'r1',
      userId: 'alice',
      kind: 'slow-oauth',
      payload: bytes('blob1'),
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'r1',
      userId: 'bob',
      kind: 'slow-oauth',
      payload: bytes('blob2'),
    });
    await Promise.all([
      bus.call('credentials:get', ctx(), { ref: 'r1', userId: 'alice' }),
      bus.call('credentials:get', ctx(), { ref: 'r1', userId: 'bob' }),
    ]);
    expect(startTimes.length).toBe(2);
    // Parallel: both started within a few ms of each other (<25ms gap proves
    // they overlapped, since each resolve sleeps 30ms).
    expect(Math.abs(startTimes[1]! - startTimes[0]!)).toBeLessThan(25);
  });

  it('credentials:get for api-key kind decodes payload as UTF-8 (no sub-service)', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'k1',
      userId: 'u',
      kind: 'api-key',
      payload: bytes('sk-real'),
    });
    expect(
      await bus.call<{ ref: string; userId: string }, string>(
        'credentials:get',
        ctx(),
        { ref: 'k1', userId: 'u' },
      ),
    ).toBe('sk-real');
  });

  it('error messages never contain the decrypted value', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'x',
      userId: 'u',
      kind: 'api-key',
      payload: bytes('UNIQUE-SECRET-9f3a'),
    });
    const memGet = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx(),
      { key: 'credential:u:x' },
    );
    const tampered = new Uint8Array(memGet.value!);
    tampered[tampered.length - 1] ^= 0xff;
    await bus.call('storage:set', ctx(), { key: 'credential:u:x', value: tampered });
    try {
      await bus.call('credentials:get', ctx(), { ref: 'x', userId: 'u' });
    } catch (err) {
      expect(String(err)).not.toContain('UNIQUE-SECRET-9f3a');
    }
  });
});
