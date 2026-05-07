import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createSettingsCredentialsHandlers } from '../settings-routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

// ---------------------------------------------------------------------------
// /settings/credentials* handler tests.
//
// The settings tree is restricted to scope='user' / ownerId=actor.id
// regardless of body input. These tests pin the hard restrictions so a
// future "let users set scope='agent'" surgery doesn't quietly leak.
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
  bus.registerService('auth:require-user', 'test', async () => ({
    user: authedUser,
  }));
  return bus;
}

describe('settings credentials handlers', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = KEY;
  });

  it('any authed user can POST a credential to their own bag', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createSettingsCredentialsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(
      mkReq({
        body: {
          ref: 'my-key',
          kind: 'api-key',
          payload: Buffer.from('alice-secret').toString('base64'),
        },
      }),
      res,
    );
    expect(statusOf()).toBe(201);
    expect(bodyOf()).toMatchObject({
      credential: {
        scope: 'user',
        ownerId: 'alice',
        ref: 'my-key',
        kind: 'api-key',
      },
    });
  });

  it('rejects body fields scope/ownerId (strict schema)', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createSettingsCredentialsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.create(
      mkReq({
        body: {
          // strict schema: scope/ownerId aren't in the settings shape.
          // A confused caller targeting /admin/* would otherwise leak
          // intent past the gate; reject with 400 instead.
          scope: 'global',
          ownerId: null,
          ref: 'my-key',
          kind: 'api-key',
          payload: Buffer.from('whatever').toString('base64'),
        },
      }),
      res,
    );
    expect(statusOf()).toBe(400);
  });

  it('list filters to scope=user AND ownerId=actor.id', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    // Seed two creds: one global (admin scope), one user-scoped to alice,
    // one user-scoped to bob. The settings list must only return alice's.
    const seedCtx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await bus.call('credentials:set', seedCtx, {
      scope: 'global',
      ownerId: null,
      ref: 'global-key',
      kind: 'api-key',
      payload: new TextEncoder().encode('GLOBAL'),
    });
    await bus.call('credentials:set', seedCtx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'alice-key',
      kind: 'api-key',
      payload: new TextEncoder().encode('ALICE'),
    });
    await bus.call('credentials:set', seedCtx, {
      scope: 'user',
      ownerId: 'bob',
      ref: 'bob-key',
      kind: 'api-key',
      payload: new TextEncoder().encode('BOB'),
    });
    const handlers = createSettingsCredentialsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as {
      credentials: Array<{ scope: string; ownerId: string | null; ref: string }>;
    };
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]).toMatchObject({
      scope: 'user',
      ownerId: 'alice',
      ref: 'alice-key',
    });
    // Sanity: none of the secrets leaked.
    const json = JSON.stringify(body);
    expect(json).not.toContain('GLOBAL');
    expect(json).not.toContain('BOB');
    expect(json).not.toContain('ALICE');
  });

  it('DELETE /settings/credentials/:ref deletes the actor user-cred', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    const seedCtx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    await bus.call('credentials:set', seedCtx, {
      scope: 'user',
      ownerId: 'alice',
      ref: 'doomed',
      kind: 'api-key',
      payload: new Uint8Array([1]),
    });
    const handlers = createSettingsCredentialsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.destroy(mkReq({ params: { ref: 'doomed' } }), res);
    expect(statusOf()).toBe(204);
    // After delete, list should return zero rows.
    const list = mkRes();
    await handlers.list(mkReq({}), list.res);
    const body = list.bodyOf() as { credentials: unknown[] };
    expect(body.credentials).toHaveLength(0);
  });

  it('returns 401 when auth:require-user rejects', async () => {
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
    const handlers = createSettingsCredentialsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(401);
  });
});
