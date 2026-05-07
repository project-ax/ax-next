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

  // Task 1.4 implements the resolution-precedence chain (user→agent→global)
  // in `credentials:get`. Until then, `get` only resolves user-scoped rows;
  // re-enable this test in 1.4.
  it.todo('writes a global credential');

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
