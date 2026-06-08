import { reject } from '@ax/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpOAuthRouteHandlers } from '../routes.js';
import type { McpOAuthRouteDeps } from '../routes.js';
import { decodeTokenBlob, type PendingAuthorization } from '../types.js';

// ---------------------------------------------------------------------------
// Test seams: fake bus / store / flow / request / response. No network, no
// server, no DB. The whole point is to drive the begin/callback algorithms
// with controllable success/reject branches and ASSERT what crosses the
// security boundaries (CSRF state binding, agent-owner authz, the vault write).
// ---------------------------------------------------------------------------

const REDIRECT_URI = 'https://app.example.com/api/connectors/oauth/callback';

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
  const calls: Array<{ hook: string; input: unknown }> = [];
  const bus = {
    async call<I, O>(hook: string, _ctx: unknown, input: I): Promise<O> {
      calls.push({ hook, input });
      const stub = (stubs as Record<string, ((i: unknown) => unknown) | undefined>)[hook];
      if (!stub) throw new Error(`unexpected hook ${hook}`);
      return (await stub(input)) as O;
    },
  };
  return { bus, calls };
}

function fakeStore(over: Partial<McpOAuthRouteDeps['store']> = {}) {
  const putClient = vi.fn(async () => {});
  const putPending = vi.fn(async () => {});
  const getClient = vi.fn(async () => ({
    clientKey: 'conn-1|https://auth.example.com',
    clientId: 'cid',
    clientSecret: undefined as string | undefined,
    dynamic: true,
  }));
  const getPending = vi.fn(async (): Promise<PendingAuthorization | null> => null);
  const consumePending = vi.fn(async (): Promise<PendingAuthorization | null> => null);
  return {
    putClient,
    putPending,
    getClient,
    getPending,
    consumePending,
    ...over,
  } as McpOAuthRouteDeps['store'] & {
    putClient: typeof putClient;
    putPending: typeof putPending;
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
  return {
    headers: {},
    body: over.body ?? Buffer.from(''),
    cookies: {},
    query: over.query ?? {},
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
  it('1. happy path → 200 { authorizationUrl }; putPending(state,userId) + putClient called', async () => {
    const { deps, store, flow } = makeDeps({
      'auth:require-user': () => OK_USER,
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
    expect(state.json).toEqual({
      authorizationUrl: 'https://auth.example.com/authorize?client_id=cid&state=STATE0',
    });
    expect(store.putClient).toHaveBeenCalledTimes(1);
    expect(store.putPending).toHaveBeenCalledTimes(1);
    const pending = store.putPending.mock.calls[0]![0] as PendingAuthorization;
    expect(pending.state).toBe('STATE0');
    expect(pending.userId).toBe('user-1');
    expect(pending.agentId).toBe('agent-1');
    expect(pending.connectorId).toBe('conn-1');
    expect(pending.codeVerifier).toBe('verifier-0');
    expect(pending.resource).toBe('https://mcp.example.com/mcp');
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
    expect(store.putClient).not.toHaveBeenCalled();
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

  it('missing connectorId/agentId → 400', async () => {
    const { deps } = makeDeps({
      'auth:require-user': () => OK_USER,
    });
    const handlers = createMcpOAuthRouteHandlers(deps);
    const { res, state } = fakeRes();
    await handlers.begin(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1' })) }),
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
                clientSecretRef: 'secret-ref-1',
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
                clientSecretRef: 'missing-ref',
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
});

describe('mcp-oauth callback route', () => {
  const pending: PendingAuthorization = {
    state: 'STATE0',
    userId: 'user-1',
    agentId: 'agent-1',
    connectorId: 'conn-1',
    slot: 'oauth-main',
    codeVerifier: 'verifier-0',
    authServerUrl: 'https://auth.example.com',
    clientKey: 'conn-1|https://auth.example.com',
    resource: 'https://mcp.example.com/mcp',
    scope: 'read write',
    createdAt: 1_000_000,
  };

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

  it('7. provider error (?error=access_denied) → redirect oauth=error; peek + consume + set NOT reached', async () => {
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
    expect(store.getPending).not.toHaveBeenCalled();
    expect(store.consumePending).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
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

  it('client registration missing (getClient → null) → logger.error(stage:getClient) + oauth=error redirect (no 500 leak)', async () => {
    const store = storeWithPending(pending, { getClient: vi.fn(async () => null) });
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

  it('Fix2a. getClient throws (DB fault) → logger.error(stage:getClient); credentials:set NOT called; oauth=error', async () => {
    const setSpy = vi.fn();
    const store = storeWithPending(pending, {
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
