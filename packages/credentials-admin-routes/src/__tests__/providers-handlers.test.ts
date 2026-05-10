import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootstrap, HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import {
  createProviderHandlers,
  registerProviderService,
} from '../providers-routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

// ---------------------------------------------------------------------------
// /admin/credentials/providers* handler tests.
//
// We boot the credentials facade against an in-memory sqlite and stub
// `auth:require-user` so we can drive the actor identity per case.
// The `credentials:list-providers` service is registered directly via
// `registerProviderService` rather than through the full plugin, so we
// test the service + HTTP handlers independently.
//
// `fetch` is stubbed via `vi.stubGlobal` for the validate path. Globals
// are restored after each test via `vi.unstubAllGlobals()`.
// ---------------------------------------------------------------------------

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function mkRes(): {
  res: RouteResponse;
  statusOf: () => number;
  bodyOf: () => unknown;
} {
  let _status = 200;
  let _body: unknown = undefined;
  const res: RouteResponse = {
    status(n: number) {
      _status = n;
      return res;
    },
    json(v: unknown) {
      _body = v;
    },
    text(s: string) {
      _body = s;
    },
    end() {},
  };
  return {
    res,
    statusOf: () => _status,
    bodyOf: () => _body,
  };
}

function mkReq(opts: {
  body?: unknown;
  params?: Record<string, string>;
}): RouteRequest {
  return {
    headers: {},
    body:
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(opts.body)),
    cookies: {},
    query: {},
    params: opts.params ?? {},
    signedCookie: () => null,
  };
}

async function makeBus(authedUser: {
  id: string;
  isAdmin: boolean;
}): Promise<HookBus> {
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
  // Register the provider service (normally done by plugin.ts init).
  registerProviderService(bus);
  // Stub auth:require-user — the production registrant is @ax/auth-oidc.
  bus.registerService(
    'auth:require-user',
    'test',
    async (_ctx, _input) => ({ user: authedUser }),
  );
  return bus;
}

describe('providers handlers', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // GET /admin/credentials/providers
  // -------------------------------------------------------------------------

  it('returns provider list with configured=false when no key is set', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createProviderHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();

    await handlers.list(mkReq({}), res);

    expect(statusOf()).toBe(200);
    const body = bodyOf() as {
      providers: Array<{ id: string; configured: boolean }>;
    };
    expect(Array.isArray(body.providers)).toBe(true);
    const anthropic = body.providers.find((p) => p.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic?.configured).toBe(false);
  });

  it('returns configured=true after a key has been saved', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    // Pre-seed a global anthropic credential.
    await bus.call(
      'credentials:set',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' }),
      {
        scope: 'global',
        ownerId: null,
        ref: 'anthropic-api',
        kind: 'api-key',
        payload: new TextEncoder().encode('sk-test'),
      },
    );

    const handlers = createProviderHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();

    await handlers.list(mkReq({}), res);

    expect(statusOf()).toBe(200);
    const body = bodyOf() as {
      providers: Array<{ id: string; configured: boolean }>;
    };
    const anthropic = body.providers.find((p) => p.id === 'anthropic');
    expect(anthropic?.configured).toBe(true);
  });

  it('returns 403 for non-admin on GET /admin/credentials/providers', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createProviderHandlers({ bus });
    const { res, statusOf } = mkRes();

    await handlers.list(mkReq({}), res);

    expect(statusOf()).toBe(403);
  });

  it('returns 401 when auth fails on GET /admin/credentials/providers', async () => {
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
    registerProviderService(bus);
    bus.registerService('auth:require-user', 'test', async () => {
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'test',
        message: 'no cookie',
      });
    });

    const handlers = createProviderHandlers({ bus });
    const { res, statusOf } = mkRes();

    await handlers.list(mkReq({}), res);

    expect(statusOf()).toBe(401);
  });

  // -------------------------------------------------------------------------
  // POST /admin/credentials/providers/:id/validate
  // -------------------------------------------------------------------------

  it('validates and saves when fetch returns 200', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200 } as Response),
    );

    const handlers = createProviderHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();

    const keyB64 = Buffer.from('sk-ant-real-key').toString('base64');
    await handlers.validate(
      mkReq({ body: { key: keyB64 }, params: { id: 'anthropic' } }),
      res,
    );

    expect(statusOf()).toBe(200);
    const body = bodyOf() as { provider: { id: string; configured: boolean } };
    expect(body.provider.id).toBe('anthropic');
    expect(body.provider.configured).toBe(true);

    // Verify the credential was actually saved.
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    const { credentials } = await bus.call<
      Record<string, never>,
      { credentials: Array<{ scope: string; ref: string }> }
    >('credentials:list', ctx, {});
    expect(
      credentials.some(
        (c) => c.scope === 'global' && c.ref === 'anthropic-api',
      ),
    ).toBe(true);
  });

  it('returns 422 when fetch returns 401 (bad key)', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 401 } as Response),
    );

    const handlers = createProviderHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();

    const keyB64 = Buffer.from('sk-ant-bad').toString('base64');
    await handlers.validate(
      mkReq({ body: { key: keyB64 }, params: { id: 'anthropic' } }),
      res,
    );

    expect(statusOf()).toBe(422);
    const body = bodyOf() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('returns 404 for an unknown provider id', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createProviderHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();

    const keyB64 = Buffer.from('some-key').toString('base64');
    await handlers.validate(
      mkReq({ body: { key: keyB64 }, params: { id: 'unknown-provider' } }),
      res,
    );

    expect(statusOf()).toBe(404);
    expect((bodyOf() as { error: string }).error).toBe('provider-not-found');
  });

  it('returns 400 when body is empty / missing key field', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createProviderHandlers({ bus });
    const { res, statusOf } = mkRes();

    await handlers.validate(
      mkReq({ params: { id: 'anthropic' } }),
      res,
    );

    expect(statusOf()).toBe(400);
  });

  it('returns 403 for non-admin on POST /admin/credentials/providers/:id/validate', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createProviderHandlers({ bus });
    const { res, statusOf } = mkRes();

    const keyB64 = Buffer.from('sk-ant-something').toString('base64');
    await handlers.validate(
      mkReq({ body: { key: keyB64 }, params: { id: 'anthropic' } }),
      res,
    );

    expect(statusOf()).toBe(403);
  });

  it('returns 401 when auth fails on POST /admin/credentials/providers/:id/validate', async () => {
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
    registerProviderService(bus);
    bus.registerService('auth:require-user', 'test', async () => {
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'test',
        message: 'no cookie',
      });
    });

    const handlers = createProviderHandlers({ bus });
    const { res, statusOf } = mkRes();

    const keyB64 = Buffer.from('sk-ant-something').toString('base64');
    await handlers.validate(
      mkReq({ body: { key: keyB64 }, params: { id: 'anthropic' } }),
      res,
    );

    expect(statusOf()).toBe(401);
  });

  it('uses credentials:validate:<id> service when registered on bus', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    // Stub fetch so any call to it would fail — the handler should NOT reach the built-in fallback
    const fetchSpy = vi.fn().mockRejectedValue(new Error('should not call fetch'));
    vi.stubGlobal('fetch', fetchSpy);

    // Register a custom validator that always accepts.
    bus.registerService(
      'credentials:validate:anthropic',
      'test',
      async (_ctx, _input: { key: Uint8Array }) => ({ ok: true }),
    );

    const handlers = createProviderHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();

    const keyB64 = Buffer.from('sk-ant-custom').toString('base64');
    await handlers.validate(
      mkReq({ body: { key: keyB64 }, params: { id: 'anthropic' } }),
      res,
    );

    expect(statusOf()).toBe(200);
    expect((bodyOf() as { provider: { configured: boolean } }).provider.configured).toBe(true);
    // bus service was preferred; no HTTP call made
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
