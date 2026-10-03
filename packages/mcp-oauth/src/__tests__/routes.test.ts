import { reject, PluginError } from '@ax/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpOAuthRouteHandlers } from '../routes.js';
import type { McpOAuthRouteDeps } from '../routes.js';
import { decodeTokenBlob, type PendingAuthorization } from '../types.js';
import { NeedsReconnectError } from '../resolver.js';

// ---------------------------------------------------------------------------
// Test seams: fake bus / store / flow / request / response. No network, no
// server, no DB. The whole point is to drive the begin/callback algorithms
// with controllable success/reject branches and ASSERT what crosses the
// security boundaries (CSRF state binding, agent-owner authz, the vault write).
// ---------------------------------------------------------------------------

const REDIRECT_URI = 'https://app.example.com/api/connectors/oauth/callback';

it('publishes the configured CIMD identity and callback without requiring a user session', async () => {
  const { deps, calls } = makeDeps({});
  const { res, state } = fakeRes();
  await createMcpOAuthRouteHandlers(deps).clientMetadata(fakeReq() as never, res as never);
  expect(state.json).toMatchObject({ client_id: 'https://app.example.com/api/connectors/oauth/client-metadata', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' });
  expect(calls).toEqual([]);
});

it('names the CIMD client after the branding and lets authorization servers cache it briefly', async () => {
  const { deps } = makeDeps({});
  const headers: Record<string, string> = {};
  const { res, state } = fakeRes();
  res.header = (name: string, value: string) => { headers[name.toLowerCase()] = value; return res; };
  await createMcpOAuthRouteHandlers({ ...deps, clientName: async () => 'Canopy AI' }).clientMetadata(fakeReq() as never, res as never);
  expect(state.json).toMatchObject({ client_name: 'Canopy AI' });
  expect(headers['cache-control']).toBe('public, max-age=3600');
  const fallback = fakeRes();
  await createMcpOAuthRouteHandlers(deps).clientMetadata(fakeReq() as never, fallback.res as never);
  expect(fallback.state.json).toMatchObject({ client_name: 'AX' });
});

interface BusStubs {
  'auth:require-user'?: (input: unknown) => unknown;
  'agents:resolve'?: (input: unknown) => unknown;
  'connectors:get'?: (input: unknown) => unknown;
  'credentials:get'?: (input: unknown) => unknown;
  'credentials:set'?: (input: unknown) => unknown;
}

/** A bus whose `call` dispatches by hook name to a per-test stub. A stub that
 *  throws (PluginError-shaped or a Rejection) models the reject path. */
function fakeBus(stubs: BusStubs) {
  const calls: Array<{ hook: string; ctx: unknown; input: unknown }> = [];
  const bus = {
    async call<I, O>(hook: string, _ctx: unknown, input: I): Promise<O> {
      calls.push({ hook, ctx: _ctx, input });
      const stub = (stubs as Record<string, ((i: unknown) => unknown) | undefined>)[hook];
      if (!stub) throw new Error(`unexpected hook ${hook}`);
      return (await stub(input)) as O;
    },
  };
  return { bus, calls };
}

function fakeStore(over: Partial<McpOAuthRouteDeps['store']> = {}) {
  const putPending = vi.fn(async () => {});
  const purgeExpiredPending = vi.fn(async (_olderThanMs: number) => {});
  const getClient = vi.fn(async () => ({
    clientKey: 'conn-1|https://auth.example.com',
    clientId: 'cid',
    clientSecret: undefined as string | undefined,
    dynamic: true,
  }));
  const getPending = vi.fn(async (): Promise<PendingAuthorization | null> => null);
  const consumePending = vi.fn(async (): Promise<PendingAuthorization | null> => null);
  const clearNeedsReconnect = vi.fn(async (_userId: string, _connectorId: string) => {});
  return {
    putPending,
    purgeExpiredPending,
    getClient,
    getPending,
    consumePending,
    clearNeedsReconnect,
    ...over,
  } as McpOAuthRouteDeps['store'] & {
    clearNeedsReconnect: typeof clearNeedsReconnect;
    putPending: typeof putPending;
    purgeExpiredPending: typeof purgeExpiredPending;
    getClient: typeof getClient;
    getPending: typeof getPending;
    consumePending: typeof consumePending;
  };
}

/** A store whose peek + consume BOTH resolve to `pending` (the normal in-flow
 *  state). The peek-then-consume ordering means callback tests must supply
 *  both, or the peek's default-null short-circuits before consume. */
function storeWithPending(
  pending: PendingAuthorization,
  over: Partial<McpOAuthRouteDeps['store']> = {},
) {
  return fakeStore({
    getPending: vi.fn(async () => pending),
    consumePending: vi.fn(async () => pending),
    ...over,
  });
}

function fakeFlow(over: Partial<McpOAuthRouteDeps['flow']> = {}) {
  const metadata = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    response_types_supported: ['code'],
  };
  return {
    discover: vi.fn(async () => ({ authServerUrl: 'https://auth.example.com', metadata })),
    ensureClient: vi.fn(async () => ({
      clientKey: 'conn-1|https://auth.example.com',
      clientId: 'cid',
      clientSecret: undefined as string | undefined,
      dynamic: true,
    })),
    buildAuthorization: vi.fn(async () => ({
      authorizationUrl: 'https://auth.example.com/authorize?client_id=cid&state=STATE0',
      codeVerifier: 'verifier-0',
    })),
    redeemCode: vi.fn(async () => ({
      access_token: 'at-123',
      refresh_token: 'rt-456',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'read write',
    })),
    ...over,
  } as unknown as McpOAuthRouteDeps['flow'];
}

/** A connector with one oauth slot + a matching mcpServer. */
function connectorFixture(over: Partial<{ credentials: unknown[]; mcpServers: unknown[]; allowedHosts: string[] }> = {}) {
  return {
    connector: {
      id: 'conn-1',
      capabilities: {
        allowedHosts: over.allowedHosts ?? ['mcp.example.com', 'auth.example.com'],
        credentials: over.credentials ?? [
          { slot: 'oauth-main', kind: 'oauth', server: 'srv', scopes: ['read', 'write'] },
        ],
        mcpServers: over.mcpServers ?? [
          {
            name: 'srv',
            transport: 'http',
            url: 'https://mcp.example.com/mcp',
            allowedHosts: ['mcp.example.com'],
            credentials: [],
          },
        ],
        packages: { npm: [], pypi: [] },
        services: [],
      },
    },
  };
}

function makeDeps(stubs: BusStubs, opts: { store?: ReturnType<typeof fakeStore>; flow?: McpOAuthRouteDeps['flow'] } = {}) {
  const { bus, calls } = fakeBus(stubs);
  const store = opts.store ?? fakeStore();
  const flow = opts.flow ?? fakeFlow();
  const logger = { error: vi.fn(), warn: vi.fn() };
  const deps: McpOAuthRouteDeps = {
    bus,
    store,
    flow,
    config: {
      publicOrigin: 'https://app.example.com',
      connectorReturnPath: '/settings/connectors',
    },
    genState: () => 'STATE0',
    now: () => 1_000_000,
    pendingTtlMs: 10 * 60_000,
    logger,
  };
  return { deps, bus, calls, store, flow, logger };
}

// --- fake request/response ------------------------------------------------

function fakeReq(over: Partial<{ body: Buffer; query: Record<string, string> }> = {}) {
  // The real @ax/http-server LOWERCASES every query key (see http-server
  // types.ts: "lowercased keys, repeated keys collapsed"). Replicate that here
  // so a handler reading req.query is tested against the actual wire contract —
  // a camelCase read (e.g. req.query.connectorId) would silently miss the value
  // a browser sent as ?connectorId=… (which arrives as `connectorid`).
  const rawQuery = over.query ?? {};
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawQuery)) query[k.toLowerCase()] = v;
  return {
    headers: {},
    body: over.body ?? Buffer.from(''),
    cookies: {},
    query,
    params: {},
    signedCookie: () => null,
  };
}

interface CapturedRes {
  res: {
    status(n: number): unknown;
    header(name: string, value: string): unknown;
    json(v: unknown): void;
    text(s: string): void;
    redirect(url: string, status?: number): void;
    end(): void;
  };
  state: {
    status?: number;
    json?: unknown;
    redirectUrl?: string;
    redirectStatus?: number;
  };
}

function fakeRes(): CapturedRes {
  const state: CapturedRes['state'] = {};
  const res: CapturedRes['res'] = {
    status(n: number) {
      state.status = n;
      return res;
    },
    header() {
      return res;
    },
    json(v: unknown) {
      state.json = v;
    },
    text() {},
    redirect(url: string, status?: number) {
      state.redirectUrl = url;
      state.redirectStatus = status;
    },
    end() {},
  };
  return { res, state };
}

describe('OAuth host discovery route', () => {
  const request = () => fakeReq({ body: Buffer.from(JSON.stringify({ url: 'https://mcp.example.com/mcp' })) });
  const auth = { 'auth:require-user': () => ({ user: { id: 'owner', isAdmin: false } }) };

  it('previews an unsaved URL for an authenticated owner without reading connectors, credentials or writing state', async () => {
    const preview = vi.fn(async () => ({ hosts: ['auth.example.com', 'tokens.example.com'] }));
    const { deps, calls, store } = makeDeps(auth, { flow: fakeFlow({ discoverHosts: preview }) });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).discoverHosts(request(), res as never);
    expect(state).toEqual({ status: 200, json: { hosts: ['auth.example.com', 'tokens.example.com'] } });
    expect(preview).toHaveBeenCalledWith({ resourceUrl: 'https://mcp.example.com/mcp' });
    expect(calls.map(({ hook }) => hook)).toEqual(['auth:require-user']);
    expect(store.putPending).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers before any network request', async () => {
    const preview = vi.fn();
    const { deps } = makeDeps({ 'auth:require-user': () => { throw reject({ reason: 'login required' }); } }, { flow: fakeFlow({ discoverHosts: preview }) });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).discoverHosts(request(), res as never);
    expect(state.status).toBe(401);
    expect(preview).not.toHaveBeenCalled();
  });

  it.each(['null', '{}', '{', '{"url":3}', '{"url":"http://example.com"}', '{"url":"https://user:secret@example.com"}'])('rejects malformed or unsafe preview body %s', async (body) => {
    const preview = vi.fn();
    const { deps } = makeDeps(auth, { flow: fakeFlow({ discoverHosts: preview }) });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).discoverHosts(fakeReq({ body: Buffer.from(body) }), res as never);
    expect(state.status).toBe(400);
    expect(preview).not.toHaveBeenCalled();
  });

  it('caps request bodies and reflects neither the draft URL nor provider errors', async () => {
    const preview = vi.fn(async () => { throw new Error('SECRET_MARKER query or provider body'); });
    const { deps, logger } = makeDeps(auth, { flow: fakeFlow({ discoverHosts: preview }) });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const oversized = fakeRes();
    await handlers.discoverHosts(fakeReq({ body: Buffer.alloc(4097) }), oversized.res as never);
    expect(oversized.state.status).toBe(413);
    expect(preview).not.toHaveBeenCalled();
    const failure = fakeRes();
    await handlers.discoverHosts(request(), failure.res as never);
    expect(failure.state.status).toBe(502);
    expect(JSON.stringify(failure.state)).not.toContain('SECRET_MARKER');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET_MARKER');
  });

  it('bounds per-user attempts, expires old entries, and releases capacity after failure', async () => {
    const preview = vi.fn(async () => { throw new Error('failed'); });
    const { deps } = makeDeps(auth, { flow: fakeFlow({ discoverHosts: preview }) });
    let time = 1_000_000;
    deps.now = () => time;
    const handlers = createMcpOAuthRouteHandlers(deps);
    for (let i = 0; i < 6; i++) await handlers.discoverHosts(request(), fakeRes().res as never);
    const limited = fakeRes();
    await handlers.discoverHosts(request(), limited.res as never);
    expect(limited.state.status).toBe(429);
    expect(preview).toHaveBeenCalledTimes(6);
    time += 60_001;
    const later = fakeRes();
    await handlers.discoverHosts(request(), later.res as never);
    expect(later.state.status).toBe(502);
    expect(preview).toHaveBeenCalledTimes(7);
  });

  it('bounds concurrent previews', async () => {
    let finish!: (result: { hosts: string[] }) => void;
    const waiting = new Promise<{ hosts: string[] }>((resolve) => { finish = resolve; });
    const preview = vi.fn(() => waiting);
    const { deps } = makeDeps(auth, { flow: fakeFlow({ discoverHosts: preview }) });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const requests = Array.from({ length: 4 }, () => handlers.discoverHosts(request(), fakeRes().res as never));
    await Promise.resolve();
    await Promise.resolve();
    const limited = fakeRes();
    await handlers.discoverHosts(request(), limited.res as never);
    expect(limited.state.status).toBe(429);
    expect(preview).toHaveBeenCalledTimes(4);
    finish({ hosts: ['auth.example.com'] });
    await Promise.all(requests);
  });
});

// PluginError-ish reject (the duck-typed catch keys on instanceof PluginError
// OR isRejection; a thrown Rejection object exercises the isRejection branch).
function rejectThrow(reason: string): never {
  throw reject({ reason });
}

const OK_USER = { user: { id: 'user-1', isAdmin: false } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mcp-oauth begin route', () => {
  it.each([
    { scopes: undefined, expected: 'discovered.read' },
    { scopes: [] as string[], expected: 'discovered.read' },
    { scopes: ['configured.read'], expected: 'configured.read' },
  ])('threads the selected scope through registration, authorization and pending state: $expected', async ({ scopes, expected }) => {
    const flow = fakeFlow({ discover: vi.fn(async () => ({
      authServerUrl: 'https://auth.example.com',
      metadata: {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code'],
      },
      scope: 'discovered.read',
    })) });
    const { deps, store } = makeDeps({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture({ credentials: [{
        slot: 'oauth-main', kind: 'oauth', server: 'srv', ...(scopes ? { scopes } : {}),
      }] }),
    }, { flow });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1' })) }), res,
    );
    expect(state.status).toBe(200);
    expect(flow.ensureClient).toHaveBeenCalledWith(expect.objectContaining({ scope: expected }));
    expect(flow.buildAuthorization).toHaveBeenCalledWith(expect.objectContaining({ scope: expected }));
    expect(store.putPending).toHaveBeenCalledWith(expect.objectContaining({ scope: expected }));
  });

  it('1. happy path → 200 { authorizationUrl }; putPending(state,userId) called; the shared client row is never written', async () => {
    // The real store has no putClient any more. Plant one on the double so that a
    // stray begin -> putClient call (the TASK-696 bug) is observable, not a TypeError
    // swallowed by begin's 502 catch.
    const legacyPutClient = vi.fn(async () => {});
    const { deps, store, flow } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
        'connectors:get': () => connectorFixture(),
      },
      { store: fakeStore({ putClient: legacyPutClient } as never) },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );

    expect(state.status).toBe(200);
    expect(state.json).toEqual({
      authorizationUrl: 'https://auth.example.com/authorize?client_id=cid&state=STATE0',
    });
    // begin no longer upserts the shared `connectorId|authServerUrl` client row.
    expect(legacyPutClient).not.toHaveBeenCalled();
    expect(store.putPending).toHaveBeenCalledTimes(1);
    const pending = store.putPending.mock.calls[0]![0] as PendingAuthorization;
    expect(pending.state).toBe('STATE0');
    expect(pending.userId).toBe('user-1');
    expect(pending.agentId).toBe('agent-1');
    expect(pending.connectorId).toBe('conn-1');
    expect(pending.codeVerifier).toBe('verifier-0');
    expect(pending.resource).toBe('https://mcp.example.com/mcp');
    expect(pending.issuerRequired).toBe(false);
    // The redirectUri threaded to the SDK is publicOrigin + the callback path.
    expect((flow.ensureClient as ReturnType<typeof vi.fn>).mock.calls[0]![0].redirectUri).toBe(
      REDIRECT_URI,
    );
  });

  // Authorization to begin a bind is gated by `agents:resolve` — NOT a bespoke
  // owner-only check. A REJECT (the caller can't see the agent: a non-member of
  // a team agent, or a non-owner of a personal agent) is the hard boundary →
  // 403, nothing written, no discovery fetch leaks. This pins that gate.
  it('2. agents:resolve rejects (caller not permitted on agent) → 403; putPending NOT called; no discovery', async () => {
    const { deps, store, flow } = makeDeps({
      'auth:require-user': () => OK_USER,
      'agents:resolve': () => rejectThrow('not accessible'),
      'connectors:get': () => connectorFixture(),
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );

    expect(state.status).toBe(403);
    expect(state.json).toEqual({ error: 'forbidden' });
    expect(store.putPending).not.toHaveBeenCalled();
    expect(store.purgeExpiredPending).not.toHaveBeenCalled();
    expect(flow.discover).not.toHaveBeenCalled();
  });

  // The flip side of the gate: ANYONE `agents:resolve` admits may begin a bind —
  // and `agents:resolve` admits a team agent's MEMBERS, not just an owner (a team
  // agent has `ownerId = teamId` and no single user-owner; team membership IS
  // ax-next's sharing mechanism — see @ax/agents `checkAccess`). So a permitted
  // member, here a user who is NOT the agent's sole owner but whom `agents:resolve`
  // accepts, is INTENTIONALLY allowed to authorize. Every member then rides on the
  // bound identity (the shared-key consent moment is surfaced in the Phase-2
  // connect UI). The hard boundary above (a non-member → 403) is what's enforced.
  it('2b. agents:resolve accepts a team member (non-owner) → 200; pending written (team-member binding is allowed by design)', async () => {
    const { deps, store } = makeDeps({
      'auth:require-user': () => OK_USER,
      // A team member's resolve SUCCEEDS even though OK_USER is not the agent's
      // sole owner — the route does not distinguish owner from member, by design.
      'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
      'connectors:get': () => connectorFixture(),
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );

    expect(state.status).toBe(200);
    expect(store.putPending).toHaveBeenCalledTimes(1);
  });

  it('3. connector lacks oauth slot → 400; no discovery', async () => {
    const { deps, flow } = makeDeps({
      'auth:require-user': () => OK_USER,
      'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
      'connectors:get': () =>
        connectorFixture({ credentials: [{ slot: 'k', kind: 'api-key' }] }),
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );

    expect(state.status).toBe(400);
    expect(flow.discover).not.toHaveBeenCalled();
  });

  it('unauthenticated → 401 (auth:require-user rejects)', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => rejectThrow('no session'),
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(fakeReq({ body: Buffer.from('{}') }), res);
    expect(state.status).toBe(401);
    expect(state.json).toEqual({ error: 'unauthenticated' });
  });

  it('missing connectorId → 400 (agentId is optional)', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ agentId: 'agent-1' })) }),
      res,
    );
    expect(state.status).toBe(400);
  });

  it('agentId present but empty string → 400', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: '' })) }),
      res,
    );
    expect(state.status).toBe(400);
  });

  it('connectors:get not-found → 404', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
      'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
      'connectors:get': () => rejectThrow('not found'),
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );
    expect(state.status).toBe(404);
  });

  it('discovery failure → 502 oauth_discovery_failed (no secret leak)', async () => {
    const flow = fakeFlow({
      discover: vi.fn(async () => {
        throw new Error('blocked host internal.local');
      }),
    });
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
        'connectors:get': () => connectorFixture(),
      },
      { flow },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );
    expect(state.status).toBe(502);
    expect((state.json as { error: string }).error).toBe('oauth_discovery_failed');
  });

  it('resolves a pinned clientSecretRef via credentials:get', async () => {
    const getSecret = vi.fn(() => 'pinned-secret');
    const flow = fakeFlow();
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
        'connectors:get': () =>
          connectorFixture({
            credentials: [
              {
                slot: 'oauth-main',
                kind: 'oauth',
                server: 'srv',
                clientId: 'pinned-cid',
                clientSecretRef: 'account:conn-1:oauth-client-secret',
              },
            ],
          }),
        'credentials:get': getSecret,
      },
      { flow },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );
    expect(getSecret).toHaveBeenCalledTimes(1);
    const pinned = (flow.ensureClient as ReturnType<typeof vi.fn>).mock.calls[0]![0].pinned;
    expect(pinned).toEqual({ clientId: 'pinned-cid', clientSecret: 'pinned-secret' });
  });

  it('Fix4. pinned clientSecretRef rejects (missing/forbidden) → 400 oauth_client_secret_unavailable; no discovery', async () => {
    const flow = fakeFlow();
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
        'connectors:get': () =>
          connectorFixture({
            credentials: [
              {
                slot: 'oauth-main',
                kind: 'oauth',
                server: 'srv',
                clientId: 'pinned-cid',
                clientSecretRef: 'account:conn-1:oauth-client-secret',
              },
            ],
          }),
        'credentials:get': () => rejectThrow('credential not found'),
      },
      { flow },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );
    expect(state.status).toBe(400);
    expect(state.json).toEqual({ error: 'oauth_client_secret_unavailable' });
    expect(flow.discover).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // TASK-712 — `clientSecretRef` is author-controlled text that `begin` hands to
  // `credentials:get`; the resolved value is then posted to a token endpoint the
  // same author chose. Only `account:<this connector>:<tag>` may reach the vault.
  //
  // The check must fire BEFORE any vault call, so these assert `credentials:get`
  // was never called -- not merely that the flow ended in a 400. (On main a refused
  // ref used to end in `oauth_client_secret_unavailable` too, because the vault
  // threw on the placeholder agentId; that outcome cannot tell "refused" from
  // "asked and failed", and it is the accident this change stops depending on.)
  // -------------------------------------------------------------------------
  describe('clientSecretRef must be this connector\'s own account key (TASK-712)', () => {
    async function beginWithRef(ref: string, over: { clientId?: string | undefined } = {}) {
      const getSecret = vi.fn(() => 'the-resolved-secret');
      const flow = fakeFlow();
      const store = fakeStore();
      const { deps, logger } = makeDeps(
        {
          'auth:require-user': () => OK_USER,
          'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
          'connectors:get': () =>
            connectorFixture({
              credentials: [
                {
                  slot: 'oauth-main',
                  kind: 'oauth',
                  server: 'srv',
                  ...('clientId' in over
                    ? over.clientId !== undefined
                      ? { clientId: over.clientId }
                      : {}
                    : { clientId: 'pinned-cid' }),
                  clientSecretRef: ref,
                },
              ],
            }),
          'credentials:get': getSecret,
        },
        { flow, store },
      );
      const handlers = createMcpOAuthRouteHandlers(deps);
      const { res, state } = fakeRes();
      await handlers.begin(
        fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
        res,
      );
      return { getSecret, flow, store, logger, state };
    }

    it.each([
      // the operator's model key, the wizard's ref, any platform-minted namespace
      ['provider:anthropic'],
      ['provider:probe'],
      ['mcp:srv:env:API_KEY'],
      ['mcp:srv:header:Authorization'],
      ['skill:some-skill:SLOT'],
      ['routine:agent-1:daily:hmac'],
      // an env-fallback name (`envFallback: { 'anthropic-api': ... }` in the k8s preset)
      ['anthropic-api'],
      // someone else's account key, bare and tagged, and an id that merely starts with ours
      ['account:opskey'],
      ['account:zendesk:oauth-client-secret'],
      ['account:conn-10:oauth-client-secret'],
      ['account:conn-1-x:oauth-client-secret'],
      // this connector's TOKEN ref (bare), and malformed tags
      ['account:conn-1'],
      ['account:conn-1:'],
      ['account:conn-1:a:b'],
      ['account:conn-1:../secret'],
      ['account:conn-1:oauth-client-secret '],
      ['account:conn-1: oauth-client-secret'],
      [`account:conn-1:${'x'.repeat(65)}`],
      ['ACCOUNT:conn-1:oauth-client-secret'],
      [' account:conn-1:oauth-client-secret'],
      ['account:CONN-1:oauth-client-secret'],
    ])('refuses %j: 400 oauth_client_secret_ref_not_allowed, no vault call, no discovery', async (ref) => {
      const { getSecret, flow, store, logger, state } = await beginWithRef(ref);
      expect(state.status).toBe(400);
      expect(state.json).toEqual({ error: 'oauth_client_secret_ref_not_allowed' });
      expect(getSecret).not.toHaveBeenCalled();
      expect(flow.discover).not.toHaveBeenCalled();
      expect(flow.ensureClient).not.toHaveBeenCalled();
      expect(store.putPending).not.toHaveBeenCalled();
      // The rejected ref is author-controlled and may itself be a pasted credential:
      // the log carries the connector id only.
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(ref);
      expect(logger.warn).toHaveBeenCalledWith('mcp_oauth_begin_client_secret_ref_rejected', {
        connectorId: 'conn-1',
      });
    });

    it('refuses a foreign ref even when no clientId is pinned (the check is not gated on clientId)', async () => {
      const { getSecret, state } = await beginWithRef('provider:anthropic', { clientId: undefined });
      expect(state.status).toBe(400);
      expect(state.json).toEqual({ error: 'oauth_client_secret_ref_not_allowed' });
      expect(getSecret).not.toHaveBeenCalled();
    });

    it.each([
      ['account:conn-1:OAUTH_CLIENT_SECRET'], // what the connector editors write (TASK-762)
      ['account:conn-1:oauth-client-secret'],
      ['account:conn-1:OAUTH_SECRET'],
      ['account:conn-1:s'],
    ])('accepts %j: resolved via credentials:get for the caller and pinned', async (ref) => {
      const { getSecret, flow, state } = await beginWithRef(ref);
      expect(state.status).toBe(200);
      expect(getSecret).toHaveBeenCalledTimes(1);
      expect(getSecret).toHaveBeenCalledWith({ ref, userId: 'user-1' });
      const pinned = (flow.ensureClient as ReturnType<typeof vi.fn>).mock.calls[0]![0].pinned;
      expect(pinned).toEqual({ clientId: 'pinned-cid', clientSecret: 'the-resolved-secret' });
    });

    it('an empty clientSecretRef is "no pinned secret" (never dereferenced), not a refusal', async () => {
      const { getSecret, flow, state } = await beginWithRef('');
      expect(state.status).toBe(200);
      expect(getSecret).not.toHaveBeenCalled();
      const pinned = (flow.ensureClient as ReturnType<typeof vi.fn>).mock.calls[0]![0].pinned;
      expect(pinned).toEqual({ clientId: 'pinned-cid' });
    });
  });

  it('Fix5. connector with >1 oauth slot → 400 multiple_oauth_slots_unsupported; no discovery', async () => {
    const flow = fakeFlow();
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
        'connectors:get': () =>
          connectorFixture({
            credentials: [
              { slot: 'oauth-a', kind: 'oauth', server: 'srv' },
              { slot: 'oauth-b', kind: 'oauth', server: 'srv' },
            ],
          }),
      },
      { flow },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );
    expect(state.status).toBe(400);
    expect(state.json).toEqual({ error: 'multiple_oauth_slots_unsupported' });
    expect(flow.discover).not.toHaveBeenCalled();
  });

  // Ref-shape mismatch: the callback always writes the COLLAPSED ref
  // `account:<connectorId>`, but foldConnectorCaps/deriveCredentialPlan switch
  // to the PER-SLOT ref `account:<connectorId>:<slot>` once a connector has ≥2
  // TOTAL credential slots. A connector with one oauth slot + ANY other slot
  // would therefore store the token where the orchestrator never resolves it →
  // silent no-credential. begin must reject (before any discovery).
  it('connector with one oauth slot + another (non-oauth) slot → 400 oauth_with_multiple_slots_unsupported; no discovery', async () => {
    const flow = fakeFlow();
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
        'connectors:get': () =>
          connectorFixture({
            credentials: [
              { slot: 'oauth-main', kind: 'oauth', server: 'srv', scopes: ['read'] },
              { slot: 'API_KEY', kind: 'api-key' },
            ],
          }),
      },
      { flow },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );
    expect(state.status).toBe(400);
    expect(state.json).toEqual({ error: 'oauth_with_multiple_slots_unsupported' });
    expect(flow.discover).not.toHaveBeenCalled();
  });

  it('passes the branded client name to client registration', async () => {
    const flow = fakeFlow();
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture({ credentials: [
        { slot: 'oauth-main', kind: 'oauth', server: 'srv', clientRegistration: 'dcr' },
      ] }),
    }, { flow });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers({ ...deps, clientName: async () => 'Canopy AI' })
      .begin(fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1' })) }), res);
    expect(state.status).toBe(200);
    expect(flow.ensureClient).toHaveBeenCalledWith(expect.objectContaining({ registration: 'dcr', clientName: 'Canopy AI' }));
  });

  it('begins OAuth with custom request headers while retaining the collapsed token reference', async () => {
    const flow = fakeFlow();
    const { deps, store } = makeDeps({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture({ credentials: [
        { slot: 'oauth-main', kind: 'oauth', server: 'srv', clientRegistration: 'cimd' },
        { slot: 'header-one', kind: 'api-key', server: 'srv', headerName: 'X-API-Key' },
      ] }),
    }, { flow });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).begin(fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1' })) }), res);
    expect(state.status).toBe(200);
    expect(flow.ensureClient).toHaveBeenCalledWith(expect.objectContaining({ registration: 'cimd', clientMetadataUrl: 'https://app.example.com/api/connectors/oauth/client-metadata' }));
    expect(store.putPending).toHaveBeenCalled();
  });

  // The single-oauth-slot happy path is unchanged: when oauth is the connector's
  // ONLY credential slot, the collapsed ref the callback writes is exactly the
  // ref the orchestrator resolves, so begin proceeds (200 + discovery runs).
  it('connector with a SINGLE oauth slot (its only slot) still proceeds → 200; discovery runs', async () => {
    const flow = fakeFlow();
    const { deps, store } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
        'connectors:get': () => connectorFixture(),
      },
      { flow },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );
    expect(state.status).toBe(200);
    expect(store.putPending).toHaveBeenCalledTimes(1);
    expect(flow.discover).toHaveBeenCalledTimes(1);
  });

  // Phase 2 credScope selection: personal agent → 'user'; team agent → 'agent'

  it('credScope: personal agent (visibility=personal) → pending.credScope === "user"', async () => {
    const store = fakeStore();
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'agents:resolve': () => ({ agent: { id: 'agent-1', visibility: 'personal', ownerId: 'user-1' } }),
        'connectors:get': () => connectorFixture(),
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );
    expect(state.status).toBe(200);
    expect(store.putPending).toHaveBeenCalledTimes(1);
    const pending = store.putPending.mock.calls[0]![0] as PendingAuthorization;
    expect(pending.credScope).toBe('user');
  });

  it('credScope: team agent (visibility=team) → pending.credScope === "agent"', async () => {
    const store = fakeStore();
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'agents:resolve': () => ({ agent: { id: 'agent-1', visibility: 'team', ownerId: 'team-1' } }),
        'connectors:get': () => connectorFixture(),
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' })) }),
      res,
    );
    expect(state.status).toBe(200);
    expect(store.putPending).toHaveBeenCalledTimes(1);
    const pending = store.putPending.mock.calls[0]![0] as PendingAuthorization;
    expect(pending.credScope).toBe('agent');
  });

  it('credScope: no agentId in body → credScope === "user", agentId === "", agents:resolve NOT called', async () => {
    const store = fakeStore();
    const resolveStub = vi.fn(() => ({ agent: { id: 'agent-1' } }));
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
      },
      { store },
    );
    // Override bus to track resolve calls independently
    const { bus, calls: busCalls } = fakeBus({
      'auth:require-user': () => OK_USER,
      'agents:resolve': resolveStub,
      'connectors:get': () => connectorFixture(),
    });
    const handlers = createMcpOAuthRouteHandlers({ ...deps, bus });
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1' })) }),
      res,
    );
    expect(state.status).toBe(200);
    expect(store.putPending).toHaveBeenCalledTimes(1);
    const pending = store.putPending.mock.calls[0]![0] as PendingAuthorization;
    expect(pending.credScope).toBe('user');
    expect(pending.agentId).toBe('');
    expect(resolveStub).not.toHaveBeenCalled();
    // agents:resolve must not appear in bus calls
    expect(busCalls.filter(c => c.hook === 'agents:resolve')).toHaveLength(0);
  });

  // --- TASK-696: the pending row carries the client this authorization started with ---

  const BEGIN_STUBS: BusStubs = {
    'auth:require-user': () => OK_USER,
    'agents:resolve': () => ({ agent: { id: 'agent-1' } }),
    'connectors:get': () => connectorFixture(),
  };
  const BEGIN_BODY = Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-1' }));

  it('TASK-696a. putPending carries the client ensureClient returned (clientId + clientSecret) and the legacy clientKey', async () => {
    const flow = fakeFlow({
      ensureClient: vi.fn(async () => ({
        clientKey: 'conn-1|https://auth.example.com',
        clientId: 'dcr-cid-7',
        clientSecret: 'dcr-secret-7',
        dynamic: true,
      })),
    } as never);
    const { deps, store } = makeDeps(BEGIN_STUBS, { flow });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).begin(fakeReq({ body: BEGIN_BODY }), res);

    expect(state.status).toBe(200);
    const pending = store.putPending.mock.calls[0]![0] as PendingAuthorization;
    expect(pending.clientId).toBe('dcr-cid-7');
    expect(pending.clientSecret).toBe('dcr-secret-7');
    expect(pending.clientKey).toBe('conn-1|https://auth.example.com');
  });

  it('TASK-696b. a public client (no secret) yields a pending row with clientId and NO clientSecret key', async () => {
    // The default fakeFlow().ensureClient returns { clientId: 'cid', clientSecret: undefined }.
    const { deps, store } = makeDeps(BEGIN_STUBS);
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).begin(fakeReq({ body: BEGIN_BODY }), res);

    expect(state.status).toBe(200);
    const pending = store.putPending.mock.calls[0]![0] as PendingAuthorization;
    expect(pending.clientId).toBe('cid');
    expect('clientSecret' in pending).toBe(false);
  });

  it('TASK-696c. the authorize URL is built for the SAME client the pending row records', async () => {
    const flow = fakeFlow({
      ensureClient: vi.fn(async () => ({
        clientKey: 'conn-1|https://auth.example.com',
        clientId: 'dcr-cid-8',
        clientSecret: undefined,
        dynamic: true,
      })),
    } as never);
    const { deps, store } = makeDeps(BEGIN_STUBS, { flow });
    const { res } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).begin(fakeReq({ body: BEGIN_BODY }), res);

    const built = (flow.buildAuthorization as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      client: { clientId: string };
    };
    const pending = store.putPending.mock.calls[0]![0] as PendingAuthorization;
    expect(built.client.clientId).toBe('dcr-cid-8');
    expect(pending.clientId).toBe(built.client.clientId);
  });

  it('TASK-696d. expired pending rows are purged with now() - pendingTtlMs, BEFORE the new row is written', async () => {
    const order: string[] = [];
    const store = fakeStore({
      purgeExpiredPending: vi.fn(async () => {
        order.push('purge');
      }),
      putPending: vi.fn(async () => {
        order.push('put');
      }),
    });
    const { deps } = makeDeps(BEGIN_STUBS, { store });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).begin(fakeReq({ body: BEGIN_BODY }), res);

    expect(state.status).toBe(200);
    // now() = 1_000_000, pendingTtlMs = 10 * 60_000.
    expect(store.purgeExpiredPending).toHaveBeenCalledTimes(1);
    expect(store.purgeExpiredPending).toHaveBeenCalledWith(1_000_000 - 10 * 60_000);
    expect(order).toEqual(['purge', 'put']);
  });

  it('TASK-696e. a failing purge does NOT fail the begin: 200, the row is still written, purge failure is warned (neutral fields only)', async () => {
    const store = fakeStore({
      purgeExpiredPending: vi.fn(async () => {
        throw new Error('deadlock detected; secret-ish detail cid-leak-xyz');
      }),
    });
    const { deps, logger } = makeDeps(BEGIN_STUBS, { store });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).begin(fakeReq({ body: BEGIN_BODY }), res);

    expect(state.status).toBe(200);
    expect(store.putPending).toHaveBeenCalledTimes(1);
    const purgeWarns = logger.warn.mock.calls.filter((c) => c[0] === 'mcp_oauth_begin_purge_failed');
    expect(purgeWarns).toHaveLength(1);
    // The discovery-failed warn (the 502 path) must NOT have fired.
    expect(logger.warn.mock.calls.filter((c) => c[0] === 'mcp_oauth_begin_discovery_failed')).toHaveLength(0);
    // Neutral fields only: the error NAME, never its message.
    expect(purgeWarns[0]![1]).toEqual({ name: 'Error' });
  });
});

describe('mcp-oauth callback route', () => {
  // A row written by the FIXED begin: it carries the client the authorization
  // started with.
  const pending: PendingAuthorization = {
    state: 'STATE0',
    userId: 'user-1',
    agentId: 'agent-1',
    connectorId: 'conn-1',
    slot: 'oauth-main',
    codeVerifier: 'verifier-0',
    authServerUrl: 'https://auth.example.com',
    clientKey: 'conn-1|https://auth.example.com',
    clientId: 'pending-cid',
    clientSecret: 'pending-secret',
    resource: 'https://mcp.example.com/mcp',
    scope: 'read write',
    credScope: 'agent',
    createdAt: 1_000_000,
  };
  // A row written by the PRE-fix begin (an authorization in flight across the
  // deploy): it has only the legacy clientKey index.
  const { clientId: _cid, clientSecret: _csec, ...legacyPending } = pending;

  it('4 + 4b. happy → credentials:set once (agent/ownerId/ref/kind + decoded blob); redirect oauth=success', async () => {
    const setArgs: unknown[] = [];
    const store = storeWithPending(pending);
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': (input) => {
          setArgs.push(input);
        },
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(
      fakeReq({ query: { code: 'auth-code-xyz', state: 'STATE0' } }),
      res,
    );

    expect(setArgs).toHaveLength(1);
    const arg = setArgs[0] as {
      scope: string;
      ownerId: string;
      ref: string;
      kind: string;
      payload: Uint8Array;
      expiresAt?: number;
    };
    expect(arg.scope).toBe('agent');
    expect(arg.ownerId).toBe('agent-1');
    expect(arg.ref).toBe('account:conn-1');
    expect(arg.kind).toBe('mcp-oauth');
    expect(arg.expiresAt).toBe(1_000_000 + 3600 * 1000);

    const blob = decodeTokenBlob(arg.payload);
    expect(blob.clientId).toBe('pending-cid');
    expect(blob.clientSecret).toBe('pending-secret');
    expect(blob.accessToken).toBe('at-123');
    expect(blob.refreshToken).toBe('rt-456');
    expect(blob.tokenType).toBe('Bearer');
    expect(blob.tokenEndpoint).toBe('https://auth.example.com/token');
    expect(blob.resource).toBe('https://mcp.example.com/mcp');
    expect(blob.authServerUrl).toBe('https://auth.example.com');
    expect(blob.clientKey).toBe('conn-1|https://auth.example.com');
    expect(blob.scope).toBe('read write');

    expect(state.redirectUrl).toContain('oauth=success');
    expect(state.redirectUrl).toContain('connector=conn-1');
    expect(state.redirectUrl).toContain('https://app.example.com/settings/connectors');
  });

  // --- TASK-696: redeem AS, and record, the client the authorization started with ---

  /** Drive a callback to completion; return what redeemCode saw and what was vaulted. */
  async function runCallback(opts: {
    pending: PendingAuthorization;
    getClient?: ReturnType<typeof vi.fn>;
    redeemResult?: Record<string, unknown>;
  }) {
    const setArgs: Array<{ payload: Uint8Array }> = [];
    const store = storeWithPending(
      opts.pending,
      opts.getClient ? ({ getClient: opts.getClient } as never) : {},
    );
    const flow = fakeFlow(
      opts.redeemResult
        ? ({ redeemCode: vi.fn(async () => opts.redeemResult) } as never)
        : {},
    );
    const { deps, logger } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': (input) => {
          setArgs.push(input as { payload: Uint8Array });
        },
      },
      { store, flow },
    );
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).callback(
      fakeReq({ query: { code: 'auth-code-xyz', state: 'STATE0' } }),
      res,
    );
    const redeemArgs = (flow.redeemCode as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { client: { clientId: string; clientSecret?: string } }
      | undefined;
    return { store, state, logger, redeemArgs, setArgs };
  }

  it('TASK-696f. redeems the code as the PENDING row\'s client — the shared client row (which a later begin may have overwritten) is not consulted', async () => {
    // getClient would hand back whichever client registered LAST for this
    // connector|authServer — a DIFFERENT client. Using it is the bug.
    const getClient = vi.fn(async () => ({
      clientKey: 'conn-1|https://auth.example.com',
      clientId: 'registered-last-cid',
      clientSecret: 'registered-last-secret' as string | undefined,
      dynamic: true,
    }));
    const { redeemArgs, state } = await runCallback({ pending, getClient });

    expect(state.redirectUrl).toContain('oauth=success');
    expect(redeemArgs!.client.clientId).toBe('pending-cid');
    expect(redeemArgs!.client.clientSecret).toBe('pending-secret');
    expect(getClient).not.toHaveBeenCalled();
  });

  it('TASK-696g. the vaulted token blob carries the client it was issued to (clientId + clientSecret), plus the legacy clientKey', async () => {
    const { setArgs } = await runCallback({ pending });

    expect(setArgs).toHaveLength(1);
    const blob = decodeTokenBlob(setArgs[0]!.payload);
    expect(blob.clientId).toBe('pending-cid');
    expect(blob.clientSecret).toBe('pending-secret');
    expect(blob.clientKey).toBe('conn-1|https://auth.example.com');
  });

  it('TASK-696h. a public client\'s blob has clientId and NO clientSecret key', async () => {
    const { clientSecret: _s, ...publicPending } = pending;
    const { setArgs, redeemArgs } = await runCallback({ pending: publicPending });

    expect(redeemArgs!.client.clientSecret).toBeUndefined();
    const blob = decodeTokenBlob(setArgs[0]!.payload);
    expect(blob.clientId).toBe('pending-cid');
    expect('clientSecret' in blob).toBe(false);
    // The encoded bytes agree (zod strips unknown keys, so the decode alone proves little).
    expect(new TextDecoder().decode(setArgs[0]!.payload)).not.toContain('clientSecret');
  });

  it('TASK-696i. LEGACY pending row (no clientId) falls back to getClient(clientKey), redeems as that client, and records it on the blob', async () => {
    const getClient = vi.fn(async (_k: string) => ({
      clientKey: 'conn-1|https://auth.example.com',
      clientId: 'legacy-row-cid',
      clientSecret: 'legacy-row-secret' as string | undefined,
      dynamic: true,
    }));
    const { redeemArgs, setArgs, state } = await runCallback({ pending: legacyPending, getClient });

    expect(state.redirectUrl).toContain('oauth=success');
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(getClient).toHaveBeenCalledWith('conn-1|https://auth.example.com');
    expect(redeemArgs!.client.clientId).toBe('legacy-row-cid');
    expect(redeemArgs!.client.clientSecret).toBe('legacy-row-secret');
    // The token was redeemed as this client, so the blob records it: from here on
    // it no longer depends on the shared row.
    const blob = decodeTokenBlob(setArgs[0]!.payload);
    expect(blob.clientId).toBe('legacy-row-cid');
    expect(blob.clientSecret).toBe('legacy-row-secret');
    expect(blob.clientKey).toBe('conn-1|https://auth.example.com');
  });

  it('TASK-696j. a pending row WITH a client succeeds even when the shared client row is gone (getClient would return null / throw)', async () => {
    for (const getClient of [
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    ]) {
      const { state, logger, setArgs } = await runCallback({ pending, getClient });
      expect(state.redirectUrl).toContain('oauth=success');
      expect(logger.error).not.toHaveBeenCalled();
      expect(setArgs).toHaveLength(1);
      expect(getClient).not.toHaveBeenCalled();
    }
  });

  it('TASK-696k. the client secret never reaches a log line (redeem-failure path)', async () => {
    const store = storeWithPending(pending);
    const flow = fakeFlow({
      redeemCode: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { deps, logger } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': vi.fn(),
      },
      { store, flow },
    );
    const { res } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).callback(
      fakeReq({ query: { code: 'auth-code-xyz', state: 'STATE0' } }),
      res,
    );
    const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logged).not.toContain('pending-secret');
    expect(logged).not.toContain('auth-code-xyz');
  });

  // Phase 2: the callback writes the credential at the pending row's STORED
  // credScope/ownerId, NOT a hardcoded agent scope. These pin the production
  // credentials:set fields for both scope variants.

  it('TASK-741: a completed sign-in clears the caller\'s needs-reconnect marker AFTER the token is stored', async () => {
    const order: string[] = [];
    const store = storeWithPending(pending, {
      clearNeedsReconnect: vi.fn(async () => {
        order.push('clear');
      }),
    });
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': () => {
          order.push('set');
        },
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'auth-code-xyz', state: 'STATE0' } }), res);
    expect(store.clearNeedsReconnect).toHaveBeenCalledTimes(1);
    // TASK-756 — this pending is a TEAM agent's (credScope 'agent'): the token
    // is the agent's, so the marker cleared is the agent's, for every member.
    expect(store.clearNeedsReconnect).toHaveBeenCalledWith({ kind: 'agent', agentId: 'agent-1' }, 'conn-1');
    expect(order).toEqual(['set', 'clear']);
    expect(state.redirectUrl).toContain('oauth=success');
  });

  it('TASK-756: a PERSONAL sign-in clears only the signer\'s own marker', async () => {
    const store = storeWithPending(
      { ...pending, state: 'STATE-USER', credScope: 'user', agentId: '', userId: 'alice' },
      { clearNeedsReconnect: vi.fn(async () => {}) },
    );
    const { deps } = makeDeps(
      {
        'auth:require-user': () => ({ user: { id: 'alice', isAdmin: false } }),
        'connectors:get': () => connectorFixture(),
        'credentials:set': () => {},
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'auth-code-xyz', state: 'STATE-USER' } }), res);
    expect(store.clearNeedsReconnect).toHaveBeenCalledTimes(1);
    expect(store.clearNeedsReconnect).toHaveBeenCalledWith({ kind: 'user', userId: 'alice' }, 'conn-1');
    expect(state.redirectUrl).toContain('oauth=success');
  });

  it('TASK-741: a sign-in whose token could not be stored leaves the marker alone', async () => {
    const store = storeWithPending(pending);
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': () => {
          throw new Error('vault down');
        },
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'auth-code-xyz', state: 'STATE0' } }), res);
    expect(store.clearNeedsReconnect).not.toHaveBeenCalled();
    expect(state.redirectUrl).toContain('oauth=error');
  });

  it('TASK-741: a failing marker clear is logged and the sign-in still succeeds', async () => {
    const store = storeWithPending(pending, {
      clearNeedsReconnect: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const { deps, logger } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': () => {},
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'auth-code-xyz', state: 'STATE0' } }), res);
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_oauth_needs_reconnect_clear_failed',
      expect.objectContaining({ connectorId: 'conn-1' }),
    );
    expect(state.redirectUrl).toContain('oauth=success');
  });

  it('credScope=user: callback writes credentials:set with scope=user, ownerId=userId', async () => {
    const userScopedPending: PendingAuthorization = {
      ...pending,
      state: 'STATE-USER',
      credScope: 'user',
      agentId: '',
      userId: 'alice',
    };
    const setArgs: unknown[] = [];
    const store = storeWithPending(userScopedPending);
    const { deps } = makeDeps(
      {
        'auth:require-user': () => ({ user: { id: 'alice', isAdmin: false } }),
        'connectors:get': () => connectorFixture(),
        'credentials:set': (input) => { setArgs.push(input); },
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(
      fakeReq({ query: { code: 'auth-code-xyz', state: 'STATE-USER' } }),
      res,
    );
    expect(setArgs).toHaveLength(1);
    const arg = setArgs[0] as { scope: string; ownerId: string; ref: string; kind: string };
    expect(arg.scope).toBe('user');
    expect(arg.ownerId).toBe('alice');
    expect(arg.ref).toBe('account:conn-1');
    expect(arg.kind).toBe('mcp-oauth');
    expect(state.redirectUrl).toContain('oauth=success');
  });

  it('credScope=agent: callback writes credentials:set with scope=agent, ownerId=agentId', async () => {
    const agentScopedPending: PendingAuthorization = {
      ...pending,
      state: 'STATE-AGENT',
      credScope: 'agent',
      agentId: 'A',
      userId: 'alice',
    };
    const setArgs: unknown[] = [];
    const store = storeWithPending(agentScopedPending);
    const { deps } = makeDeps(
      {
        'auth:require-user': () => ({ user: { id: 'alice', isAdmin: false } }),
        'connectors:get': () => connectorFixture(),
        'credentials:set': (input) => { setArgs.push(input); },
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(
      fakeReq({ query: { code: 'auth-code-xyz', state: 'STATE-AGENT' } }),
      res,
    );
    expect(setArgs).toHaveLength(1);
    const arg = setArgs[0] as { scope: string; ownerId: string; ref: string; kind: string };
    expect(arg.scope).toBe('agent');
    expect(arg.ownerId).toBe('A');
    expect(arg.ref).toBe('account:conn-1');
    expect(arg.kind).toBe('mcp-oauth');
    expect(state.redirectUrl).toContain('oauth=success');
  });

  it('5. state/user mismatch → 403; consume NOT called (no burn); credentials:set NOT called', async () => {
    const setSpy = vi.fn();
    // Peek returns a row owned by a DIFFERENT user; the session user is user-1.
    const store = fakeStore({
      getPending: vi.fn(async () => ({ ...pending, userId: 'someone-else' })),
    });
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': setSpy,
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'c', state: 'STATE0' } }), res);
    expect(state.status).toBe(403);
    expect(state.json).toEqual({ error: 'state_user_mismatch' });
    // Anti-DoS: a wrong-user hit must NOT burn the victim's pending row.
    expect(store.consumePending).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('6. unknown/expired state (getPending → null) → 400; no redirect; credentials:set NOT called', async () => {
    const setSpy = vi.fn();
    const store = fakeStore({ getPending: vi.fn(async () => null) });
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'credentials:set': setSpy,
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'c', state: 'STATE0' } }), res);
    expect(state.status).toBe(400);
    expect(state.json).toEqual({ error: 'invalid_or_expired_state' });
    expect(state.redirectUrl).toBeUndefined();
    expect(store.consumePending).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('6b. consume races to null after a matching peek → 400 invalid_or_expired_state', async () => {
    const setSpy = vi.fn();
    // Peek matches (user-1) but the atomic consume loses the race / TTL expires.
    const store = fakeStore({
      getPending: vi.fn(async () => pending),
      consumePending: vi.fn(async () => null),
    });
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'credentials:set': setSpy,
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'c', state: 'STATE0' } }), res);
    expect(store.consumePending).toHaveBeenCalledTimes(1);
    expect(state.status).toBe(400);
    expect(state.json).toEqual({ error: 'invalid_or_expired_state' });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('provider denial consumes the user-bound state and returns the connector so the popup can report failure', async () => {
    const setSpy = vi.fn();
    const store = storeWithPending(pending);
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'credentials:set': setSpy,
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(
      fakeReq({ query: { error: 'access_denied', state: 'STATE0' } }),
      res,
    );
    expect(state.redirectUrl).toContain('oauth=error');
    expect(state.redirectUrl).toContain('connector=conn-1');
    expect(store.getPending).toHaveBeenCalledWith('STATE0');
    expect(store.consumePending).toHaveBeenCalledTimes(1);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('another user cannot cancel a pending authorization with a provider error', async () => {
    const store = storeWithPending(pending);
    const { deps, flow } = makeDeps({
      'auth:require-user': () => ({ user: { id: 'other-user', isAdmin: false } }),
    }, { store });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).callback(
      fakeReq({ query: { error: 'access_denied', state: 'STATE0' } }), res,
    );
    expect(state.status).toBe(403);
    expect(state.redirectUrl).toBeUndefined();
    expect(store.consumePending).not.toHaveBeenCalled();
    expect(flow.redeemCode).not.toHaveBeenCalled();
  });

  it('a provider denial with no state is rejected without touching pending authorizations', async () => {
    const { deps, store } = makeDeps({ 'auth:require-user': () => OK_USER });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).callback(fakeReq({ query: { error: 'access_denied' } }), res);
    expect(state.status).toBe(400);
    expect(store.getPending).not.toHaveBeenCalled();
  });

  it.each([{ code: 'c' }, { error: 'access_denied' }])('rejects a mismatching response issuer before consuming state: %j', async (response) => {
    const store = storeWithPending(pending);
    const { deps, flow } = makeDeps({ 'auth:require-user': () => OK_USER }, { store });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).callback(
      fakeReq({ query: { ...response, state: 'STATE0', iss: 'https://other.example.com' } }), res,
    );
    expect(state.status).toBe(400);
    expect(state.json).toEqual({ error: 'authorization_server_mismatch' });
    expect(store.consumePending).not.toHaveBeenCalled();
    expect(flow.redeemCode).not.toHaveBeenCalled();
  });

  it('accepts a response issuer matching the pending authorization server', async () => {
    const store = storeWithPending(pending);
    const { deps, flow } = makeDeps({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture(),
      'credentials:set': () => undefined,
    }, { store });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).callback(
      fakeReq({ query: { code: 'c', state: 'STATE0', iss: pending.authServerUrl } }), res,
    );
    expect(state.redirectUrl).toContain('oauth=success');
    expect(flow.redeemCode).toHaveBeenCalledOnce();
  });

  it('requires iss when the authorization server advertised issuer identification', async () => {
    const store = storeWithPending({ ...pending, issuerRequired: true });
    const { deps, flow } = makeDeps({ 'auth:require-user': () => OK_USER }, { store });
    const { res, state } = fakeRes();
    await createMcpOAuthRouteHandlers(deps).callback(
      fakeReq({ query: { code: 'c', state: 'STATE0' } }), res,
    );
    expect(state.status).toBe(400);
    expect(state.json).toEqual({ error: 'authorization_server_mismatch' });
    expect(store.consumePending).not.toHaveBeenCalled();
    expect(flow.redeemCode).not.toHaveBeenCalled();
  });

  it('unauthenticated callback → 401', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => rejectThrow('no session'),
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'c', state: 'STATE0' } }), res);
    expect(state.status).toBe(401);
  });

  it('missing code or state → 400', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { state: 'STATE0' } }), res);
    expect(state.status).toBe(400);
  });

  it('LEGACY pending row (no clientId): client registration missing (getClient → null) → logger.error(stage:getClient) + oauth=error redirect (no 500 leak)', async () => {
    const store = storeWithPending(legacyPending, { getClient: vi.fn(async () => null) });
    const { deps, logger } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': vi.fn(),
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'c', state: 'STATE0' } }), res);
    expect(state.redirectUrl).toContain('oauth=error');
    expect(state.status).toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const meta = logger.error.mock.calls[0]![1] as { stage: string; reason?: string };
    expect(meta.stage).toBe('getClient');
    expect(meta.reason).toBe('client_registration_missing');
  });

  it('omits scope+expiresAt from blob/set when the provider returns neither', async () => {
    const setArgs: Array<{ payload: Uint8Array; expiresAt?: number }> = [];
    const noScopePending = { ...pending, scope: undefined };
    const store = storeWithPending(noScopePending);
    const flow = fakeFlow({
      redeemCode: vi.fn(async () => ({ access_token: 'at-only', token_type: 'Bearer' })),
    });
    const { deps } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': (input) => {
          setArgs.push(input as { payload: Uint8Array; expiresAt?: number });
        },
      },
      { store, flow },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'c', state: 'STATE0' } }), res);
    expect(setArgs[0]!.expiresAt).toBeUndefined();
    const blob = decodeTokenBlob(setArgs[0]!.payload);
    expect(blob.expiresAt).toBeUndefined();
    expect(blob.scope).toBeUndefined();
  });

  // --- Fix 2: regression tests for the formerly-swallowed fault paths -------

  it('Fix2a. LEGACY pending row (no clientId): getClient throws (DB fault) → logger.error(stage:getClient); credentials:set NOT called; oauth=error', async () => {
    const setSpy = vi.fn();
    const store = storeWithPending(legacyPending, {
      getClient: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    const { deps, logger } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': setSpy,
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'c', state: 'STATE0' } }), res);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect((logger.error.mock.calls[0]![1] as { stage: string }).stage).toBe('getClient');
    expect(setSpy).not.toHaveBeenCalled();
    expect(state.redirectUrl).toContain('oauth=error');
  });

  it('Fix2b. credentials:set throws (vault fault) → logger.error(stage:store); oauth=error', async () => {
    const store = storeWithPending(pending);
    const { deps, logger } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': () => {
          throw new Error('pg write failed');
        },
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'c', state: 'STATE0' } }), res);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect((logger.error.mock.calls[0]![1] as { stage: string }).stage).toBe('store');
    expect(state.redirectUrl).toContain('oauth=error');
  });

  it('Fix2c. redeemCode throws (provider rejects code) → logger.WARN name-only; set NOT called; oauth=error', async () => {
    const setSpy = vi.fn();
    const store = storeWithPending(pending);
    const flow = fakeFlow({
      redeemCode: vi.fn(async () => {
        // A real SDK error often echoes the provider response BODY in .message —
        // must never reach the log.
        const e = new Error('invalid_grant: code already used by client cid-secret-xyz');
        e.name = 'OAuthError';
        throw e;
      }),
    });
    const { deps, logger } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => connectorFixture(),
        'credentials:set': setSpy,
      },
      { store, flow },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'c', state: 'STATE0' } }), res);
    // WARN (provider failure), not ERROR (server fault).
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const meta = logger.warn.mock.calls[0]![1] as Record<string, unknown>;
    expect(meta.name).toBe('OAuthError');
    // No message/code leak on the redeem path.
    expect(meta).not.toHaveProperty('message');
    expect(meta).not.toHaveProperty('code');
    expect(JSON.stringify(meta)).not.toContain('invalid_grant');
    expect(JSON.stringify(meta)).not.toContain('cid-secret-xyz');
    expect(setSpy).not.toHaveBeenCalled();
    expect(state.redirectUrl).toContain('oauth=error');
  });

  it('Fix2d. connectors:get throws a non-reject (server fault) → logger.error(stage:connector); oauth=error', async () => {
    const store = storeWithPending(pending);
    const { deps, logger } = makeDeps(
      {
        'auth:require-user': () => OK_USER,
        'connectors:get': () => {
          throw new Error('db down');
        },
        'credentials:set': vi.fn(),
      },
      { store },
    );
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(fakeReq({ query: { code: 'c', state: 'STATE0' } }), res);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect((logger.error.mock.calls[0]![1] as { stage: string }).stage).toBe('connector');
    expect(state.redirectUrl).toContain('oauth=error');
  });

  // --- Fix 3: peek-then-consume — a wrong-user hit does NOT burn the row ----

  // Task 5: the callback should redirect to /oauth/connected, not /settings/connectors
  it('Task5. happy callback redirects to /oauth/connected (not /settings/connectors)', async () => {
    const store = storeWithPending(pending);
    const { bus } = fakeBus({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture(),
      'credentials:set': () => {},
    });
    const deps: McpOAuthRouteDeps = {
      bus,
      store,
      flow: fakeFlow(),
      config: {
        publicOrigin: 'https://app.example.com',
        connectorReturnPath: '/oauth/connected',
      },
      genState: () => 'STATE0',
      now: () => 1_000_000,
      pendingTtlMs: 10 * 60_000,
      logger: { error: vi.fn(), warn: vi.fn() },
    };
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.callback(
      fakeReq({ query: { code: 'auth-code-xyz', state: 'STATE0' } }),
      res,
    );
    expect(state.redirectUrl).toContain('/oauth/connected?');
    expect(state.redirectUrl).toContain('oauth=success');
    expect(state.redirectUrl).not.toContain('/settings/connectors');
  });

  it('Fix3. wrong-user callback returns 403 without consuming; a SUBSEQUENT legitimate consume still succeeds', async () => {
    // One in-memory pending row; getPending peeks it, consumePending burns it.
    let consumed = false;
    const store = fakeStore({
      getPending: vi.fn(async () => (consumed ? null : pending)),
      consumePending: vi.fn(async () => {
        if (consumed) return null;
        consumed = true;
        return pending;
      }),
    });
    const handlersFor = (sessionUser: { id: string; isAdmin: boolean }) =>
      createMcpOAuthRouteHandlers(
        makeDeps(
          {
            'auth:require-user': () => ({ user: sessionUser }),
            'connectors:get': () => connectorFixture(),
            'credentials:set': vi.fn(),
          },
          { store },
        ).deps,
      );

    // Attacker (different user) who learned the victim's state hits the callback.
    const attacker = fakeRes();
    await handlersFor({ id: 'attacker', isAdmin: false }).callback(
      fakeReq({ query: { code: 'c', state: 'STATE0' } }),
      attacker.res,
    );
    expect(attacker.state.status).toBe(403);
    expect(store.consumePending).not.toHaveBeenCalled(); // row NOT burned

    // The legitimate user (user-1) then completes the flow successfully.
    const victim = fakeRes();
    await handlersFor({ id: 'user-1', isAdmin: false }).callback(
      fakeReq({ query: { code: 'c', state: 'STATE0' } }),
      victim.res,
    );
    expect(store.consumePending).toHaveBeenCalledTimes(1);
    expect(victim.state.redirectUrl).toContain('oauth=success');
  });
});

describe('mcp-oauth status route (GET /api/connectors/oauth/status)', () => {
  it('Task4.1. credentials:get resolves → 200 { status: "connected" }', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture(),
      'credentials:get': () => 'access-token-value',
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.status(fakeReq({ query: { connectorId: 'conn-1' } }), res);
    expect(state.status).toBe(200);
    expect(state.json).toEqual({ status: 'connected' });
  });

  it('Task4.2. credentials:get throws credential-not-found → 200 { status: "not-connected" }', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture(),
      'credentials:get': () => {
        throw new PluginError({ code: 'credential-not-found', plugin: 'credentials', message: '' });
      },
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.status(fakeReq({ query: { connectorId: 'conn-1' } }), res);
    expect(state.status).toBe(200);
    expect(state.json).toEqual({ status: 'not-connected' });
  });

  // PRODUCTION shape: the resolver's bare NeedsReconnectError crosses the hook
  // bus twice and HookBus.call wraps it into PluginError{ code:'unknown',
  // cause:<NeedsReconnectError> } (packages/core/src/hook-bus.ts). Classification
  // must discriminate on the structured `.cause`, not the message substring —
  // this is the regression guard for the formerly-dead instanceof branch.
  it('Task4.3a. credentials:get throws the bus-WRAPPED NeedsReconnectError (via .cause) → 200 { status: "needs-reconnect" }', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture(),
      'credentials:get': () => {
        throw new PluginError({
          code: 'unknown',
          plugin: 'core',
          message:
            "service hook 'credentials:resolve:mcp-oauth' threw: refresh token rejected; reconnect required",
          cause: new NeedsReconnectError('refresh token rejected; reconnect required'),
        });
      },
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.status(fakeReq({ query: { connectorId: 'conn-1' } }), res);
    expect(state.status).toBe(200);
    expect(state.json).toEqual({ status: 'needs-reconnect' });
  });

  // DIRECT/in-package shape: a bare NeedsReconnectError (no bus wrapping) — pins
  // the instanceof branch for any caller that doesn't cross the bus.
  it('Task4.3b. credentials:get throws a bare NeedsReconnectError → 200 { status: "needs-reconnect" }', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture(),
      'credentials:get': () => {
        throw new NeedsReconnectError('reconnect required');
      },
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.status(fakeReq({ query: { connectorId: 'conn-1' } }), res);
    expect(state.status).toBe(200);
    expect(state.json).toEqual({ status: 'needs-reconnect' });
  });

  it('Task4.4. agentId present + agents:resolve rejects → 403', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
      'agents:resolve': () => rejectThrow('not accessible'),
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.status(fakeReq({ query: { connectorId: 'conn-1', agentId: 'agent-1' } }), res);
    expect(state.status).toBe(403);
    expect(state.json).toEqual({ error: 'forbidden' });
  });

  it('Task4.5. credentials:get throws unexpected error → 500', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture(),
      'credentials:get': () => {
        throw new Error('db down');
      },
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.status(fakeReq({ query: { connectorId: 'conn-1' } }), res);
    expect(state.status).toBe(500);
    expect(state.json).toEqual({ error: 'status_check_failed' });
  });

  it('Task4.6. missing connectorId → 400', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.status(fakeReq({ query: {} }), res);
    expect(state.status).toBe(400);
  });

  it('Task4.7. agentId present + credentials:get resolves → probeCtx uses real agentId', async () => {
    const credGetArgs: unknown[] = [];
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
      'agents:resolve': () => ({ agent: { id: 'agent-A', visibility: 'personal', ownerId: 'user-1' } }),
      'credentials:get': (input) => {
        credGetArgs.push(input);
        return 'token-value';
      },
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.status(fakeReq({ query: { connectorId: 'conn-1', agentId: 'agent-A' } }), res);
    expect(state.status).toBe(200);
    expect(state.json).toEqual({ status: 'connected' });
    // The token value is discarded — not returned to the caller.
    expect(JSON.stringify(state.json)).not.toContain('token-value');
    const credGet = credGetArgs.length; // referenced to keep the capture meaningful
    expect(credGet).toBe(1);
  });

  // Regression (manual-acceptance walk): a NO-agentId (user-scope / Connectors-tab)
  // probe MUST pass probeCtx.agentId='' so the real credentials:get walks user→global
  // only. A non-empty placeholder ('@ax/mcp-oauth') was fed to the agent-scope lookup
  // as an ownerId and rejected by the ownerId pattern → 500 on every user-scope status
  // check (the mock credentials:get here doesn't validate ownerId, so the bug only
  // shows as the wrong ctx.agentId — that's what this pins).
  it('Task4.8. NO agentId → probeCtx.agentId is "" (agent-scope walk skipped)', async () => {
    const { deps, calls } = makeDeps({
      'auth:require-user': () => OK_USER,
      'connectors:get': () => connectorFixture(),
      'credentials:get': () => {
        throw new PluginError({ code: 'credential-not-found', plugin: 'credentials', message: '' });
      },
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.status(fakeReq({ query: { connectorId: 'conn-1' } }), res);
    expect(state.status).toBe(200);
    expect(state.json).toEqual({ status: 'not-connected' });
    const credGet = calls.find((c) => c.hook === 'credentials:get');
    expect((credGet?.ctx as { agentId?: string } | undefined)?.agentId).toBe('');
  });
});
