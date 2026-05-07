import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('credentials:get scope precedence (user > agent > global)', () => {
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

  it('returns global when only global exists', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    await bus.call('credentials:set', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'k',
      kind: 'api-key',
      payload: new TextEncoder().encode('GLOBAL'),
    });
    expect(await bus.call('credentials:get', ctx, { ref: 'k', userId: 'alice' })).toBe(
      'GLOBAL',
    );
  });

  it('agent overrides global', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    await bus.call('credentials:set', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'k',
      kind: 'api-key',
      payload: new TextEncoder().encode('GLOBAL'),
    });
    await bus.call('credentials:set', ctx, {
      scope: 'agent',
      ownerId: 'agent-1',
      ref: 'k',
      kind: 'api-key',
      payload: new TextEncoder().encode('AGENT'),
    });
    expect(await bus.call('credentials:get', ctx, { ref: 'k', userId: 'alice' })).toBe(
      'AGENT',
    );
  });

  it('user overrides agent overrides global', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    await bus.call('credentials:set', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'k',
      kind: 'api-key',
      payload: new TextEncoder().encode('GLOBAL'),
    });
    await bus.call('credentials:set', ctx, {
      scope: 'agent',
      ownerId: 'agent-1',
      ref: 'k',
      kind: 'api-key',
      payload: new TextEncoder().encode('AGENT'),
    });
    await bus.call('credentials:set', ctx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'k',
      kind: 'api-key',
      payload: new TextEncoder().encode('USER'),
    });
    expect(await bus.call('credentials:get', ctx, { ref: 'k', userId: 'alice' })).toBe(
      'USER',
    );
  });

  it('agent scope only matched when ctx.agentId is set', async () => {
    const bus = await makeBus();
    const ctxNoAgent = makeAgentContext({ sessionId: 's', agentId: '', userId: 'alice' });
    await bus.call('credentials:set', ctxNoAgent, {
      scope: 'agent',
      ownerId: 'agent-1',
      ref: 'k',
      kind: 'api-key',
      payload: new TextEncoder().encode('AGENT'),
    });
    await expect(
      bus.call('credentials:get', ctxNoAgent, { ref: 'k', userId: 'alice' }),
    ).rejects.toMatchObject({ code: 'credential-not-found' });
  });

  it('envFallback fires only when no v2 row exists in any scope', async () => {
    const bus = new HookBus();
    process.env.MY_FALLBACK = 'ENV_VALUE';
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: ':memory:' }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin({ envFallback: { k: 'MY_FALLBACK' } }),
      ],
      config: {},
    });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    expect(await bus.call('credentials:get', ctx, { ref: 'k', userId: 'alice' })).toBe(
      'ENV_VALUE',
    );
    // Now write a global; it should win over env.
    await bus.call('credentials:set', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'k',
      kind: 'api-key',
      payload: new TextEncoder().encode('GLOBAL'),
    });
    expect(await bus.call('credentials:get', ctx, { ref: 'k', userId: 'alice' })).toBe(
      'GLOBAL',
    );
  });
});
