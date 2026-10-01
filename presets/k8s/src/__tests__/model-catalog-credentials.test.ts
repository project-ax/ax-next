import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrap, HookBus, makeAgentContext, type Plugin } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createLlmOpenRouterPlugin } from '@ax/llm-openrouter';
import { createModelPolicyPlugin, type RouteHandlers } from '@ax/model-policy';

describe('admin model catalog credential resolution', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['global', 'user'] as const)('discovers OpenRouter models with a %s key in the real vault', async (scope) => {
    vi.stubEnv('AX_CREDENTIALS_KEY', '42'.repeat(32));
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const bus = new HookBus();
    let catalogHandler: RouteHandlers['catalog'] | undefined;
    const http: Plugin = {
      manifest: {
        name: 'test-http', version: '0.0.0',
        registers: ['http:register-route', 'auth:require-user'], calls: [], subscribes: [],
      },
      async init({ bus }) {
        bus.registerService('auth:require-user', 'test-http', async () => ({ user: { id: 'admin-1', isAdmin: true } }));
        bus.registerService('http:register-route', 'test-http', async (_ctx, input: { path: string; handler: RouteHandlers['catalog'] }) => {
          if (input.path === '/admin/models/catalog') catalogHandler = input.handler;
          return { unregister: () => {} };
        });
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer saved-test-key');
      return new Response(JSON.stringify({ data: [{ id: 'test/model', name: 'Test model' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const storage = createStorageSqlitePlugin({ databasePath: ':memory:' });
    const policy = createModelPolicyPlugin({ builtinAllowed: ['openrouter/test/model'] });
    await bootstrap({ bus, config: {}, plugins: [
      storage, createCredentialsStoreDbPlugin(), createCredentialsPlugin(),
      createLlmOpenRouterPlugin({ credentialResolution: true, fetchImpl }), policy, http,
    ] });
    try {
      await bus.call('credentials:set', makeAgentContext({ sessionId: 'seed', agentId: 'agt-seed', userId: 'admin-1' }), {
        scope, ownerId: scope === 'global' ? null : 'admin-1', ref: 'provider:openrouter',
        kind: 'api-key', payload: new TextEncoder().encode('saved-test-key'),
      });
      let status = 200;
      let body: unknown;
      const res: Parameters<RouteHandlers['catalog']>[1] = {
        status(n) { status = n; return res; },
        header() { return res; },
        json(v) { body = v; }, text() {}, end() {},
      };
      expect(catalogHandler).toBeDefined();
      await catalogHandler!({ headers: {}, body: Buffer.alloc(0), cookies: {}, query: {}, params: {}, signedCookie: () => null }, res);
      expect(status).toBe(200);
      expect(body).toEqual({ providers: [{
        id: 'openrouter', name: 'OpenRouter', status: 'live', fetchedAt: expect.any(String),
        models: [{ ref: 'openrouter/test/model', label: 'Test model' }],
      }] });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/models');
    } finally {
      await policy.shutdown?.();
      await storage.shutdown?.();
    }
  });
});
