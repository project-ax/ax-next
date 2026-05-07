import { describe, it, expect } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin, v2StorageKey, v1StorageKey } from '../plugin.js';

describe('store-blob v2 keys with v1 fallback', () => {
  it('encodes the v2 key correctly for each scope', () => {
    expect(v2StorageKey('global', null, 'anthropic-api-key')).toBe(
      'credential:v2:global:_:anthropic-api-key',
    );
    expect(v2StorageKey('user', 'alice', 'gh-token')).toBe(
      'credential:v2:user:alice:gh-token',
    );
    expect(v2StorageKey('agent', 'linear-bot', 'linear-api')).toBe(
      'credential:v2:agent:linear-bot:linear-api',
    );
  });

  it('encodes the v1 key for backward-read', () => {
    expect(v1StorageKey('alice', 'gh-token')).toBe('credential:alice:gh-token');
  });

  it('v2 put then v2 get round-trips', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: ':memory:' }),
        createCredentialsStoreDbPlugin(),
      ],
      config: {},
    });
    const blob = new Uint8Array([1, 2, 3]);
    await bus.call('credentials:store-blob:put', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'anthropic-api-key',
      blob,
    });
    const got = await bus.call('credentials:store-blob:get', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'anthropic-api-key',
    });
    expect((got as { blob: Uint8Array | undefined }).blob).toEqual(blob);
  });

  it('v2 get falls back to v1 when scope=user and no v2 row exists', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: ':memory:' }),
        createCredentialsStoreDbPlugin(),
      ],
      config: {},
    });
    // Seed a v1 key directly via storage:set.
    await bus.call('storage:set', ctx, {
      key: v1StorageKey('alice', 'gh-token'),
      value: new Uint8Array([9]),
    });
    const got = await bus.call('credentials:store-blob:get', ctx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'gh-token',
    });
    expect((got as { blob: Uint8Array | undefined }).blob).toEqual(new Uint8Array([9]));
  });

  it('v2 get does NOT fall back to v1 for scope=global or scope=agent', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: ':memory:' }),
        createCredentialsStoreDbPlugin(),
      ],
      config: {},
    });
    // Seeding under a v1-style key for an agent-scoped ref must NOT be visible.
    await bus.call('storage:set', ctx, {
      key: v1StorageKey('agent-1', 'foo'),
      value: new Uint8Array([5]),
    });
    const got = await bus.call('credentials:store-blob:get', ctx, {
      scope: 'agent',
      ownerId: 'agent-1',
      ref: 'foo',
    });
    expect((got as { blob: Uint8Array | undefined }).blob).toBeUndefined();
  });
});
