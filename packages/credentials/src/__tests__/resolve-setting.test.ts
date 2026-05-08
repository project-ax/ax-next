import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('credentials:resolve:setting', () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
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

  it('resolves a setting credential to its string value', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    await bus.call('credentials:set', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'fast-model',
      kind: 'setting',
      payload: new TextEncoder().encode('claude-3-haiku-20250122'),
    });
    expect(await bus.call('credentials:get', ctx, { ref: 'fast-model', userId: 'alice' })).toBe(
      'claude-3-haiku-20250122',
    );
  });

  it('resolves setting with UTF-8 content correctly', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    const settingValue = 'model-config-with-emoji-🚀';
    await bus.call('credentials:set', ctx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'custom-setting',
      kind: 'setting',
      payload: new TextEncoder().encode(settingValue),
    });
    expect(await bus.call('credentials:get', ctx, { ref: 'custom-setting', userId: 'alice' })).toBe(
      settingValue,
    );
  });

  it('respects scope precedence for settings (user > global)', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    // Set global setting
    await bus.call('credentials:set', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'config-value',
      kind: 'setting',
      payload: new TextEncoder().encode('global-config'),
    });
    // Set user-scoped setting
    await bus.call('credentials:set', ctx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'config-value',
      kind: 'setting',
      payload: new TextEncoder().encode('user-config'),
    });
    // User scope should win
    expect(await bus.call('credentials:get', ctx, { ref: 'config-value', userId: 'alice' })).toBe(
      'user-config',
    );
  });
});
