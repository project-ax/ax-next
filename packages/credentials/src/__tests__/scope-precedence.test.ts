import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('credentials:get scope precedence (user > agent > global)', () => {
  let savedKey: string | undefined;
  let savedFallback: string | undefined;
  beforeEach(() => {
    savedKey = process.env.AX_CREDENTIALS_KEY;
    savedFallback = process.env.MY_FALLBACK;
    process.env.AX_CREDENTIALS_KEY = KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
    if (savedFallback === undefined) delete process.env.MY_FALLBACK;
    else process.env.MY_FALLBACK = savedFallback;
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

  // Regression: two concurrent credentials:get calls from DIFFERENT users
  // for the same global blob (distinct userIds, same resolved row) used to
  // miss the inflight-mutex because the key was `(userId, ref)`. With OAuth
  // refresh paths at non-user scopes (Phase 3), this would let the resolver
  // fire twice — racing token rotations is the bug we're closing here.
  //
  // The fix: hoist the store-blob walk OUT of the mutex; key the mutex on
  // the resolved (scope, ownerId, ref) tuple so two callers landing on the
  // same global row share one Promise.
  it('dedupes concurrent credentials:get for the same global blob across users', async () => {
    const bus = await makeBus();
    const seedCtx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await bus.call('credentials:set', seedCtx, {
      scope: 'global',
      ownerId: null,
      ref: 'shared',
      kind: 'fake-refresh',
      payload: new TextEncoder().encode('initial'),
    });

    let resolverCalls = 0;
    bus.registerService(
      'credentials:resolve:fake-refresh',
      'test',
      async (_ctx, input: { payload: Uint8Array; userId: string; ref: string }) => {
        resolverCalls += 1;
        // Yield once so two concurrent callers can both queue against the
        // mutex before either resolves. Without the fix, each caller has a
        // distinct mutex key and both arrive here.
        await new Promise((r) => setImmediate(r));
        return { value: `value-${new TextDecoder().decode(input.payload)}` };
      },
    );

    const ctxAlice = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    const ctxBob = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'bob' });
    const [a, b] = await Promise.all([
      bus.call('credentials:get', ctxAlice, { ref: 'shared', userId: 'alice' }),
      bus.call('credentials:get', ctxBob, { ref: 'shared', userId: 'bob' }),
    ]);
    expect(a).toBe('value-initial');
    expect(b).toBe('value-initial');
    expect(resolverCalls).toBe(1);
  });
});
