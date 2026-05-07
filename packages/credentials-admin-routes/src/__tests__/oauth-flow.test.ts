import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsOauthPendingPlugin } from '@ax/credentials-oauth-pending';
import {
  createAdminOauthHandlers,
  createSettingsOauthHandlers,
} from '../oauth-routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

// ---------------------------------------------------------------------------
// /admin/credentials/oauth/* + /settings/credentials/oauth/* round-trip.
//
// We boot the credentials facade + the in-memory pending state holder and
// stub the per-kind login + exchange services for a fictional kind
// `fake-oauth`. The handlers are tested directly with mkReq/mkRes — same
// shape as admin-handlers.test.ts.
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

interface BusAndAuth {
  bus: HookBus;
  /** Mutate to swap who the bus thinks the actor is — useful for the
   *  "wrong actor finishes the flow" test. HookBus doesn't allow
   *  re-registering a service, so we route auth through a closure. */
  setAuthedUser(user: { id: string; isAdmin: boolean }): void;
}

async function makeBus(authedUser: { id: string; isAdmin: boolean }): Promise<BusAndAuth> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [
      createStorageSqlitePlugin({ databasePath: ':memory:' }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      createCredentialsOauthPendingPlugin(),
    ],
    config: {},
  });
  let current = authedUser;
  bus.registerService('auth:require-user', 'test', async () => ({ user: current }));
  // Stub the per-kind login + exchange for `fake-oauth`. Production
  // registrant for the anthropic kind is @ax/credentials-anthropic-oauth;
  // the route handler doesn't care which plugin owns the hook as long as
  // the contract matches. ExchangeOutput uses `payload` (not `blob`) —
  // facade-consistent naming.
  bus.registerService('credentials:login:fake-oauth', 'test', async () => ({
    authorizeUrl: 'https://provider.example/auth?state=xyz',
    codeVerifier: 'verifier-xyz',
    state: 'xyz',
  }));
  bus.registerService(
    'credentials:exchange:fake-oauth',
    'test',
    async (_ctx, input: { code: string; codeVerifier: string; state: string }) => {
      if (input.codeVerifier !== 'verifier-xyz') {
        throw new PluginError({
          code: 'oauth-exchange-failed',
          plugin: 'test',
          message: 'verifier mismatch',
        });
      }
      return {
        payload: new TextEncoder().encode('TOKEN-' + input.code),
        expiresAt: Date.now() + 3600_000,
        kind: 'fake-oauth',
      };
    },
  );
  // We need a credentials:resolve:fake-oauth so credentials:get can read
  // back the value the finish handler stored. The fake kind is just an
  // api-key-like UTF-8 unwrap — keep the resolver trivial.
  bus.registerService(
    'credentials:resolve:fake-oauth',
    'test',
    async (_ctx, input: { payload: Uint8Array; userId: string; ref: string }) => ({
      value: new TextDecoder().decode(input.payload),
    }),
  );
  return {
    bus,
    setAuthedUser(u) {
      current = u;
    },
  };
}

describe('admin OAuth start/finish handlers', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = KEY;
  });

  it('non-admin gets 403 on /admin/credentials/oauth/start', async () => {
    const { bus } = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createAdminOauthHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.start(
      mkReq({
        body: {
          scope: 'global',
          ownerId: null,
          ref: 'fake',
          kind: 'fake-oauth',
        },
      }),
      res,
    );
    expect(statusOf()).toBe(403);
  });

  it('admin start returns pendingId + authorizeUrl', async () => {
    const { bus } = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminOauthHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.start(
      mkReq({
        body: {
          scope: 'global',
          ownerId: null,
          ref: 'fake',
          kind: 'fake-oauth',
        },
      }),
      res,
    );
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { pendingId: string; authorizeUrl: string };
    expect(typeof body.pendingId).toBe('string');
    expect(body.pendingId.length).toBeGreaterThanOrEqual(20);
    expect(body.authorizeUrl).toBe('https://provider.example/auth?state=xyz');
  });

  it('start with unsupported kind returns 400', async () => {
    const { bus } = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminOauthHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.start(
      mkReq({
        body: {
          scope: 'global',
          ownerId: null,
          ref: 'fake',
          kind: 'no-such-kind',
        },
      }),
      res,
    );
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toMatch(/unsupported kind/);
  });

  it('finish completes the round-trip and stores the credential', async () => {
    const { bus } = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminOauthHandlers({ bus });
    const start = mkRes();
    await handlers.start(
      mkReq({
        body: {
          scope: 'global',
          ownerId: null,
          ref: 'fake',
          kind: 'fake-oauth',
        },
      }),
      start.res,
    );
    const { pendingId } = start.bodyOf() as { pendingId: string };
    const finish = mkRes();
    await handlers.finish(
      mkReq({ body: { pendingId, code: 'AUTH-CODE-123' } }),
      finish.res,
    );
    expect(finish.statusOf()).toBe(201);
    // Verify the credential was actually written, by reading it back via
    // credentials:get. The fake resolver just decodes the bytes.
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    const value = await bus.call('credentials:get', ctx, {
      ref: 'fake',
      userId: 'u',
    });
    expect(value).toBe('TOKEN-AUTH-CODE-123');
  });

  it('finish with unknown pendingId returns 410', async () => {
    const { bus } = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminOauthHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.finish(
      mkReq({
        body: {
          pendingId: 'A'.repeat(43),
          code: 'x',
        },
      }),
      res,
    );
    expect(statusOf()).toBe(410);
  });

  it('finish with wrong actor returns 410 (single-use, no oracle)', async () => {
    // Same bus, but swap auth between start and finish so a different user
    // tries to claim. The pending entry is consumed defensively, so a
    // subsequent finish from the original user would also 410. Here we
    // assert the cross-user case.
    const { bus, setAuthedUser } = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminOauthHandlers({ bus });
    const start = mkRes();
    await handlers.start(
      mkReq({
        body: {
          scope: 'global',
          ownerId: null,
          ref: 'fake',
          kind: 'fake-oauth',
        },
      }),
      start.res,
    );
    const { pendingId } = start.bodyOf() as { pendingId: string };
    // Swap the bus's idea of "who is authed" so a *different* admin id
    // authenticates. requireAdmin only blocks non-admins, not other
    // admins; the userId bind on the pending entry is what actually
    // stops them.
    setAuthedUser({ id: 'eve', isAdmin: true });
    const finish = mkRes();
    await handlers.finish(
      mkReq({ body: { pendingId, code: 'x' } }),
      finish.res,
    );
    expect(finish.statusOf()).toBe(410);
  });

  it('finish rejects pendingId shorter than 20 chars (zod schema)', async () => {
    const { bus } = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminOauthHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.finish(
      mkReq({ body: { pendingId: 'short', code: 'x' } }),
      res,
    );
    expect(statusOf()).toBe(400);
  });

  it('start rejects body > 64 KiB', async () => {
    const { bus } = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminOauthHandlers({ bus });
    const { res, statusOf } = mkRes();
    const req = mkReq({});
    (req as { body: Buffer }).body = Buffer.alloc(65 * 1024);
    await handlers.start(req, res);
    expect(statusOf()).toBe(413);
  });
});

describe('settings OAuth start/finish handlers', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = KEY;
  });

  it('settings start ignores body scope/ownerId; forces user/actor', async () => {
    const { bus } = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createSettingsOauthHandlers({ bus });
    const start = mkRes();
    await handlers.start(
      mkReq({ body: { ref: 'fake', kind: 'fake-oauth' } }),
      start.res,
    );
    expect(start.statusOf()).toBe(200);
    const { pendingId } = start.bodyOf() as { pendingId: string };
    const finish = mkRes();
    await handlers.finish(
      mkReq({ body: { pendingId, code: 'AUTH-CODE-456' } }),
      finish.res,
    );
    expect(finish.statusOf()).toBe(201);
    // The credential MUST land at scope='user', ownerId='alice'. A
    // user-scoped credentials:list filtered to alice must see it.
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    const out = await bus.call<
      { scope: 'user'; ownerId: string },
      { credentials: Array<{ scope: string; ownerId: string | null; ref: string }> }
    >('credentials:list', ctx, { scope: 'user', ownerId: 'alice' });
    const found = out.credentials.find((c) => c.ref === 'fake');
    expect(found).toMatchObject({ scope: 'user', ownerId: 'alice', ref: 'fake' });
  });

  it('settings finish 401 when unauthenticated', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: ':memory:' }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        createCredentialsOauthPendingPlugin(),
      ],
      config: {},
    });
    bus.registerService('auth:require-user', 'test', async () => {
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'test',
        message: 'no cookie',
      });
    });
    const handlers = createSettingsOauthHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.finish(
      mkReq({ body: { pendingId: 'A'.repeat(43), code: 'x' } }),
      res,
    );
    expect(statusOf()).toBe(401);
  });
});
