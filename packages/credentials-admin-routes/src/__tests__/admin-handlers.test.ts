import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createAdminCredentialsHandlers } from '../admin-routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

// ---------------------------------------------------------------------------
// /admin/credentials* read-only handler tests (list + kinds).
//
// We boot the credentials facade against an in-memory sqlite (the same
// pattern packages/credentials/src/__tests__/list.test.ts uses) and stub
// `auth:require-user` so we can drive the actor identity per case. The
// handlers are tested directly with mkReq/mkRes — the actual HTTP
// transport is the http-server's job and isn't under test here.
//
// create / destroy tests were removed with the credentials UX redesign
// (Task 19) — write paths now go through destination-routes.
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
  // Stub auth:require-user. Production registrant is @ax/auth-oidc; the
  // routes don't care which plugin owns it as long as the contract is
  // `{ req } → { user: { id, isAdmin } }`.
  bus.registerService(
    'auth:require-user',
    'test',
    async (_ctx, _input) => ({ user: authedUser }),
  );
  return bus;
}

describe('admin credentials handlers', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = KEY;
  });

  it('GET /admin/credentials returns metadata only', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    await bus.call(
      'credentials:set',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' }),
      {
        scope: 'global',
        ownerId: null,
        ref: 'k',
        kind: 'api-key',
        payload: new TextEncoder().encode('SHHH'),
      },
    );
    const handlers = createAdminCredentialsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { credentials: unknown[] };
    expect(body.credentials).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('SHHH');
  });

  it('GET /admin/credentials/kinds returns the catalog (any authed user)', async () => {
    // Non-admin should pass — the kinds route relaxes the gate to
    // `auth:require-user`. This is the load-bearing assertion for Phase 4.
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createAdminCredentialsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.kinds(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { kinds: Array<{ kind: string; flow: string }> };
    expect(Array.isArray(body.kinds)).toBe(true);
    // api-key is always reported (registered by the credentials facade).
    expect(body.kinds.find((k) => k.kind === 'api-key')).toBeDefined();
  });

  it('GET /admin/credentials/kinds returns 401 when auth fails', async () => {
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
    const { PluginError } = await import('@ax/core');
    bus.registerService('auth:require-user', 'test', async () => {
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'test',
        message: 'no cookie',
      });
    });
    const handlers = createAdminCredentialsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.kinds(mkReq({}), res);
    expect(statusOf()).toBe(401);
  });

  it('GET /admin/credentials returns 401 when auth:require-user rejects', async () => {
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
    // No-cookie / unknown-session is modeled in production by auth-oidc
    // throwing PluginError{ code: 'unauthenticated' }. We mirror that here
    // by registering a service that throws — the route should write 401
    // BEFORE the 403 admin-gate kicks in (unauthenticated is the prior
    // failure mode).
    const { PluginError } = await import('@ax/core');
    bus.registerService('auth:require-user', 'test', async () => {
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'test',
        message: 'no cookie',
      });
    });
    const handlers = createAdminCredentialsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(401);
  });
});
