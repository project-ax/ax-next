import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('credentials:set / :delete with scope', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = KEY;
  });

  async function makeBus() {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: ':memory:' }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
      ],
      config: {},
    });
    return bus;
  }

  it('writes a global credential', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await bus.call('credentials:set', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'anthropic-api-key',
      kind: 'api-key',
      payload: new TextEncoder().encode('sk-test'),
    });
    const value = await bus.call('credentials:get', ctx, {
      ref: 'anthropic-api-key',
      userId: 'someone',
    });
    expect(value).toBe('sk-test');
  });

  it('writes a user-scoped credential reachable only by that user', async () => {
    const bus = await makeBus();
    const ctxAlice = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    await bus.call('credentials:set', ctxAlice, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'gh-token',
      kind: 'api-key',
      payload: new TextEncoder().encode('ghp_alice'),
    });
    expect(
      await bus.call('credentials:get', ctxAlice, { ref: 'gh-token', userId: 'alice' }),
    ).toBe('ghp_alice');
    const ctxBob = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'bob' });
    await expect(
      bus.call('credentials:get', ctxBob, { ref: 'gh-token', userId: 'bob' }),
    ).rejects.toMatchObject({ code: 'credential-not-found' });
  });

  it('rejects scope=global with non-null ownerId', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await expect(
      bus.call('credentials:set', ctx, {
        scope: 'global',
        ownerId: 'alice',
        ref: 'x',
        kind: 'api-key',
        payload: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/ownerId must be null/);
  });

  it('rejects scope=user with null ownerId', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await expect(
      bus.call('credentials:set', ctx, {
        scope: 'user',
        ownerId: null,
        ref: 'x',
        kind: 'api-key',
        payload: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/ownerId is required/);
  });

  it('delete writes a tombstone', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    await bus.call('credentials:set', ctx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'gh-token',
      kind: 'api-key',
      payload: new TextEncoder().encode('x'),
    });
    await bus.call('credentials:delete', ctx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'gh-token',
    });
    await expect(
      bus.call('credentials:get', ctx, { ref: 'gh-token', userId: 'alice' }),
    ).rejects.toMatchObject({ code: 'credential-not-found' });
  });
});
