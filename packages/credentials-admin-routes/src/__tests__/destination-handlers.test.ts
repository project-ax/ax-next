import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createDestinationHandlers } from '../destination-routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

// ---------------------------------------------------------------------------
// /admin/destinations/:destinationKind/credential and
// /settings/destinations/:destinationKind/credential handler tests.
//
// Same harness pattern as admin-handlers.test.ts — in-memory sqlite + stub
// auth:require-user, handlers under test directly (no HTTP transport).
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
  bus.registerService(
    'auth:require-user',
    'test',
    async (_ctx, _input) => ({ user: authedUser }),
  );
  return bus;
}

describe('destination credential handlers', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = KEY;
  });

  // -------------------------------------------------------------------------
  // POST /admin/destinations/:destinationKind/credential
  // -------------------------------------------------------------------------

  it('POST /admin: computes deterministic ref and calls credentials:set for provider destination', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf } = mkRes();

    await handlers.create(
      mkReq({
        params: { destinationKind: 'provider' },
        body: {
          destination: { kind: 'provider', provider: 'anthropic' },
          scope: 'global',
          ownerId: null,
          kind: 'api-key',
          payloadB64: Buffer.from('sk-ant-test').toString('base64'),
        },
      }),
      res,
    );

    expect(statusOf()).toBe(204);

    // Verify the credential was stored under the computed ref 'provider:anthropic'
    const out = await bus.call<
      Record<string, never>,
      { credentials: Array<{ ref: string; scope: string; ownerId: string | null }> }
    >(
      'credentials:list',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' }),
      {},
    );
    const stored = out.credentials.find((c) => c.ref === 'provider:anthropic');
    expect(stored).toBeDefined();
    expect(stored?.scope).toBe('global');
    expect(stored?.ownerId).toBeNull();
  });

  it('POST /admin: computes deterministic ref for skill-slot destination', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf } = mkRes();

    await handlers.create(
      mkReq({
        params: { destinationKind: 'skill-slot' },
        body: {
          destination: { kind: 'skill-slot', skillId: 'my-skill', slot: 'apiKey' },
          scope: 'user',
          ownerId: 'alice',
          kind: 'api-key',
          payloadB64: Buffer.from('secret').toString('base64'),
        },
      }),
      res,
    );

    expect(statusOf()).toBe(204);

    const out = await bus.call<
      Record<string, never>,
      { credentials: Array<{ ref: string }> }
    >(
      'credentials:list',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' }),
      {},
    );
    expect(out.credentials.find((c) => c.ref === 'skill:my-skill:apiKey')).toBeDefined();
  });

  it('POST /admin: rejects malformed base64 payloadB64 with 400', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();

    await handlers.create(
      mkReq({
        params: { destinationKind: 'provider' },
        body: {
          destination: { kind: 'provider', provider: 'anthropic' },
          scope: 'global',
          ownerId: null,
          kind: 'api-key',
          payloadB64: 'not!base64!',
        },
      }),
      res,
    );

    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toMatch(/base64/);
  });

  it('POST /admin: rejects when destination.kind does not match route param (400)', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();

    await handlers.create(
      mkReq({
        params: { destinationKind: 'mcp-env' }, // route says mcp-env
        body: {
          destination: { kind: 'provider', provider: 'anthropic' }, // body says provider
          scope: 'global',
          ownerId: null,
          kind: 'api-key',
          payloadB64: Buffer.from('secret').toString('base64'),
        },
      }),
      res,
    );

    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toMatch(/destination\.kind/);
  });

  it('POST /admin: non-admin gets 403', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf } = mkRes();

    await handlers.create(
      mkReq({
        params: { destinationKind: 'provider' },
        body: {
          destination: { kind: 'provider', provider: 'anthropic' },
          scope: 'global',
          ownerId: null,
          kind: 'api-key',
          payloadB64: Buffer.from('sk').toString('base64'),
        },
      }),
      res,
    );

    expect(statusOf()).toBe(403);
  });

  // -------------------------------------------------------------------------
  // POST /settings/destinations/:destinationKind/credential
  // -------------------------------------------------------------------------

  it('POST /settings: forces scope=user and ownerId=actor.id regardless of body', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf } = mkRes();

    // Body claims scope=global / ownerId=null — settings route must override both
    await handlers.createSettings(
      mkReq({
        params: { destinationKind: 'skill-slot' },
        body: {
          destination: { kind: 'skill-slot', skillId: 'my-skill', slot: 'apiKey' },
          scope: 'global',
          ownerId: null,
          kind: 'api-key',
          payloadB64: Buffer.from('secret').toString('base64'),
        },
      }),
      res,
    );

    expect(statusOf()).toBe(204);

    const out = await bus.call<
      Record<string, never>,
      {
        credentials: Array<{
          ref: string;
          scope: string;
          ownerId: string | null;
        }>;
      }
    >(
      'credentials:list',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' }),
      {},
    );
    const stored = out.credentials.find((c) => c.ref === 'skill:my-skill:apiKey');
    expect(stored).toBeDefined();
    // Must be scope=user / ownerId=alice regardless of what the body said
    expect(stored?.scope).toBe('user');
    expect(stored?.ownerId).toBe('alice');
  });

  it('POST /settings: unauthenticated user gets 401', async () => {
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

    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.createSettings(
      mkReq({
        params: { destinationKind: 'provider' },
        body: {
          destination: { kind: 'provider', provider: 'anthropic' },
          scope: 'user',
          ownerId: 'alice',
          kind: 'api-key',
          payloadB64: Buffer.from('sk').toString('base64'),
        },
      }),
      res,
    );
    expect(statusOf()).toBe(401);
  });

  // -------------------------------------------------------------------------
  // DELETE /admin/destinations/:destinationKind/credential
  // -------------------------------------------------------------------------

  it('DELETE /admin: computes ref and calls credentials:delete (204)', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    // Seed the credential directly
    await bus.call('credentials:set', makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' }), {
      scope: 'global',
      ownerId: null,
      ref: 'provider:anthropic',
      kind: 'api-key',
      payload: new TextEncoder().encode('sk-test'),
    });

    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf } = mkRes();

    await handlers.destroy(
      mkReq({
        params: { destinationKind: 'provider' },
        body: {
          destination: { kind: 'provider', provider: 'anthropic' },
          scope: 'global',
          ownerId: null,
        },
      }),
      res,
    );

    expect(statusOf()).toBe(204);

    // Confirm deletion
    const out = await bus.call<
      Record<string, never>,
      { credentials: Array<{ ref: string }> }
    >(
      'credentials:list',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' }),
      {},
    );
    expect(out.credentials.find((c) => c.ref === 'provider:anthropic')).toBeUndefined();
  });

  it('DELETE /admin: rejects when destination.kind does not match route param (400)', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();

    await handlers.destroy(
      mkReq({
        params: { destinationKind: 'mcp-env' }, // route says mcp-env
        body: {
          destination: { kind: 'provider', provider: 'anthropic' }, // body says provider
          scope: 'global',
          ownerId: null,
        },
      }),
      res,
    );

    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toMatch(/destination\.kind/);
  });

  it('DELETE /admin: non-admin gets 403', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf } = mkRes();

    await handlers.destroy(
      mkReq({
        params: { destinationKind: 'provider' },
        body: {
          destination: { kind: 'provider', provider: 'anthropic' },
          scope: 'global',
          ownerId: null,
        },
      }),
      res,
    );

    expect(statusOf()).toBe(403);
  });

  // -------------------------------------------------------------------------
  // DELETE /settings/destinations/:destinationKind/credential
  // -------------------------------------------------------------------------

  it('DELETE /settings: forces scope=user and ownerId=actor.id regardless of body', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    // Seed a user-scoped credential for alice
    await bus.call('credentials:set', makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' }), {
      scope: 'user',
      ownerId: 'alice',
      ref: 'skill:my-skill:apiKey',
      kind: 'api-key',
      payload: new TextEncoder().encode('secret'),
    });

    const handlers = createDestinationHandlers({ bus });
    const { res, statusOf } = mkRes();

    // Body claims scope=global / ownerId=null — must be overridden
    await handlers.destroySettings(
      mkReq({
        params: { destinationKind: 'skill-slot' },
        body: {
          destination: { kind: 'skill-slot', skillId: 'my-skill', slot: 'apiKey' },
          scope: 'global',
          ownerId: null,
        },
      }),
      res,
    );

    expect(statusOf()).toBe(204);

    // Confirm deletion
    const out = await bus.call<
      Record<string, never>,
      { credentials: Array<{ ref: string }> }
    >(
      'credentials:list',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' }),
      {},
    );
    expect(out.credentials.find((c) => c.ref === 'skill:my-skill:apiKey')).toBeUndefined();
  });
});
