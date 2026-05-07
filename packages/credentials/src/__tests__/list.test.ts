import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin, type CredentialMeta } from '../plugin.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('credentials:list + credentials:list-kinds', () => {
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

  it('list returns metadata only — no payload field', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await bus.call('credentials:set', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'anthropic',
      kind: 'api-key',
      payload: new TextEncoder().encode('SECRET-DO-NOT-LEAK'),
    });
    const out = (await bus.call('credentials:list', ctx, {})) as {
      credentials: CredentialMeta[];
    };
    expect(out.credentials).toHaveLength(1);
    const e = out.credentials[0];
    expect(e.scope).toBe('global');
    expect(e.ownerId).toBeNull();
    expect(e.ref).toBe('anthropic');
    expect(e.kind).toBe('api-key');
    expect(typeof e.createdAt).toBe('string');
    expect(e).not.toHaveProperty('payload');
    expect(e).not.toHaveProperty('blob');
    // Sanity: serialized JSON must not contain the secret.
    expect(JSON.stringify(out)).not.toContain('SECRET-DO-NOT-LEAK');
  });

  it('list rejects ownerId filter without scope (fail closed)', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await expect(
      bus.call('credentials:list', ctx, { ownerId: 'alice' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('list filters by scope', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    await bus.call('credentials:set', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'g',
      kind: 'api-key',
      payload: new Uint8Array([1]),
    });
    await bus.call('credentials:set', ctx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'u',
      kind: 'api-key',
      payload: new Uint8Array([2]),
    });
    const all = (
      (await bus.call('credentials:list', ctx, {})) as {
        credentials: CredentialMeta[];
      }
    ).credentials;
    expect(all).toHaveLength(2);
    const userOnly = (
      (await bus.call('credentials:list', ctx, {
        scope: 'user',
        ownerId: 'alice',
      })) as { credentials: CredentialMeta[] }
    ).credentials;
    expect(userOnly.map((e) => e.ref)).toEqual(['u']);
  });

  it('list skips tombstoned (deleted) credentials', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    await bus.call('credentials:set', ctx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'live',
      kind: 'api-key',
      payload: new Uint8Array([1]),
    });
    await bus.call('credentials:set', ctx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'dead',
      kind: 'api-key',
      payload: new Uint8Array([2]),
    });
    await bus.call('credentials:delete', ctx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'dead',
    });
    const out = (await bus.call('credentials:list', ctx, {})) as {
      credentials: CredentialMeta[];
    };
    expect(out.credentials.map((e) => e.ref)).toEqual(['live']);
  });

  it('list-kinds reports api-key always; oauth kinds when their plugin loaded', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    const out = (await bus.call('credentials:list-kinds', ctx, {})) as {
      kinds: Array<{ kind: string; flow: string }>;
    };
    expect(out.kinds.find((k) => k.kind === 'api-key')).toBeDefined();
    // No anthropic-oauth plugin loaded in this test bus, so it should NOT appear.
    expect(out.kinds.find((k) => k.kind === 'anthropic-oauth')).toBeUndefined();
  });

  it('list returns createdAt from the envelope (round-trips set time)', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    const before = Date.now();
    await bus.call('credentials:set', ctx, {
      scope: 'global',
      ownerId: null,
      ref: 'k',
      kind: 'api-key',
      payload: new Uint8Array([1]),
    });
    const after = Date.now();
    const out = (await bus.call('credentials:list', ctx, {})) as {
      credentials: Array<{ createdAt: string }>;
    };
    const ts = Date.parse(out.credentials[0].createdAt);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('list-kinds discovers oauth kinds via credentials:login:* registrations', async () => {
    // A fake oauth plugin that registers credentials:login:fake-oauth — list-kinds
    // should pick it up by walking bus.listServices().
    const fakeOauthPlugin = {
      manifest: {
        name: 'fake-oauth',
        version: '0.0.0',
        registers: ['credentials:login:fake-oauth'],
        calls: [],
        subscribes: [],
      },
      async init({ bus }: { bus: HookBus }) {
        bus.registerService('credentials:login:fake-oauth', 'fake-oauth', async () => ({}));
      },
    };
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: ':memory:' }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        fakeOauthPlugin,
      ],
      config: {},
    });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    const out = (await bus.call('credentials:list-kinds', ctx, {})) as {
      kinds: Array<{ kind: string; flow: string }>;
    };
    const fake = out.kinds.find((k) => k.kind === 'fake-oauth');
    expect(fake).toBeDefined();
    expect(fake?.flow).toBe('oauth');
  });
});
