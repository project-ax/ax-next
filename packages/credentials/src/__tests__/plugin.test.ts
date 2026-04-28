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
    await bus.call('credentials:set', ctx(), { id: 'gh-token', value: 'ghp_abc123' });
    const got = await bus.call<{ id: string }, { value: string }>(
      'credentials:get',
      ctx(),
      { id: 'gh-token' },
    );
    expect(got.value).toBe('ghp_abc123');
  });

  it('credentials:get returns a structured error for unknown ids', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await expect(bus.call('credentials:get', ctx(), { id: 'missing' })).rejects.toMatchObject({
      code: 'credential-not-found',
    });
  });

  it('credentials:delete removes the credential', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await bus.call('credentials:set', ctx(), { id: 'x', value: 'v' });
    await bus.call('credentials:delete', ctx(), { id: 'x' });
    await expect(bus.call('credentials:get', ctx(), { id: 'x' })).rejects.toMatchObject({
      code: 'credential-not-found',
    });
  });

  it('rejects credentials:set with an invalid id', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await expect(
      bus.call('credentials:set', ctx(), { id: 'has space', value: 'v' }),
    ).rejects.toBeInstanceOf(PluginError);
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

  it('error messages never contain the decrypted value', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await bus.call('credentials:set', ctx(), { id: 'x', value: 'UNIQUE-SECRET-9f3a' });
    const memGet = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx(),
      { key: 'credential:x' },
    );
    const tampered = new Uint8Array(memGet.value!);
    tampered[tampered.length - 1] ^= 0xff;
    await bus.call('storage:set', ctx(), { key: 'credential:x', value: tampered });
    try {
      await bus.call('credentials:get', ctx(), { id: 'x' });
    } catch (err) {
      expect(String(err)).not.toContain('UNIQUE-SECRET-9f3a');
    }
  });
});
