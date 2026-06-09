import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestHarness,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import type { ServiceHandler } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import type { Kysely } from 'kysely';
import { createMcpOAuthPlugin } from '../plugin.js';
import { createMcpOAuthStore } from '../store.js';
import { runMcpOAuthMigration, type McpOAuthDatabase } from '../migrations.js';
import { encodeTokenBlob, decodeTokenBlob } from '../types.js';
import type { RefreshedTokens, ResolverDeps } from '../resolver.js';

// ---------------------------------------------------------------------------
// INVARIANT-#3 ACCEPTANCE CANARY for @ax/mcp-oauth.
//
// Proves the design's core runtime claim end-to-end through the REAL wiring —
// no faked credentials plugin, no faked precedence chain, no faked resolver
// dispatch. The ONLY fake is `testOverrides.refresh`, injected through the
// plugin's production test seam, standing in for the live token endpoint (a
// true loopback HTTP e2e is impractical: the SSRF guard demands https +
// non-private IPs, so we can't point it at a localhost stub).
//
// The claim: when an MCP-OAuth token is stored AGENT-BOUND (scope:'agent',
// ownerId = the agent id), a DIFFERENT user who chats that shared/team agent
//   (a) resolves the OWNER's token (the agent-scope row), and
//   (b) the @ax/mcp-oauth resolver — registered by the real plugin factory and
//       dispatched by the real @ax/credentials per-kind sub-service seam —
//       transparently REFRESHES it when expired (lazy refresh), and
//   (c) @ax/credentials re-stores the rotated token under the same scope+owner,
//       so a second resolve does NOT refresh again.
//
// "Owner authorizes once, sharees ride — and it stays fresh."
//
// The real stack wired here (all on one postgres testcontainer):
//   @ax/database-postgres   → database:get-instance (mcp-oauth migration + store)
//   @ax/storage-postgres    → storage:* (the credentials store-db backend's KV)
//   @ax/credentials-store-db→ credentials:store-blob:* (the vault backend)
//   @ax/credentials         → credentials:get/set + per-kind resolve dispatch
//   @ax/mcp-oauth           → credentials:resolve:mcp-oauth (the resolver)
// ---------------------------------------------------------------------------

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const CLIENT_KEY = 'test|https://auth.example.com';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.AX_CREDENTIALS_KEY;
  process.env.AX_CREDENTIALS_KEY = KEY;
});

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // Drop every table our stack created so each test boots clean.
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS mcp_oauth_v1_clients');
    await cleanup.query('DROP TABLE IF EXISTS mcp_oauth_v1_pending');
    await cleanup.query('DROP TABLE IF EXISTS storage_postgres_v1_kv');
  } finally {
    await cleanup.end().catch(() => {});
  }
  if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
  else process.env.AX_CREDENTIALS_KEY = savedKey;
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

// The real plugin wires the resolver's `now` to `Date.now()` (production —
// not injected), so the EXPIRED token's `expiresAt` must be a genuine past
// instant relative to the wall clock for the resolver to choose to refresh.
// One day ago is unambiguously past the 5-minute refresh margin.
const PAST = Date.now() - 24 * 60 * 60_000;

interface FreshTokenRecorder {
  refresh: RefreshedTokens & { refresh_token: string };
  calls: number;
}

/** Build a fake refresh (the production `testOverrides.refresh` shape) that
 *  returns a fresh access token + a ROTATED refresh token and records how many
 *  times it was invoked. */
function makeFakeRefresh(): {
  fakeRefresh: ResolverDeps['refresh'];
  recorder: FreshTokenRecorder;
} {
  const recorder: FreshTokenRecorder = {
    refresh: {
      access_token: 'fresh-AT',
      refresh_token: 'rt2',
      expires_in: 3600,
      token_type: 'Bearer',
    },
    calls: 0,
  };
  const fakeRefresh: ResolverDeps['refresh'] = async () => {
    recorder.calls += 1;
    return { ...recorder.refresh };
  };
  return { fakeRefresh, recorder };
}

async function bootStack(testOverrides: Parameters<typeof createMcpOAuthPlugin>[0]) {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createStoragePostgresPlugin(),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      createMcpOAuthPlugin(testOverrides),
    ],
  });
  harnesses.push(h);
  // The store lives on the same shared kysely the plugin migrated. The
  // migration already ran in the plugin's init; build a store handle off the
  // same instance so the test can seed the client registration row.
  const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  await runMcpOAuthMigration(db); // idempotent — CREATE TABLE IF NOT EXISTS
  const store = createMcpOAuthStore(db);
  return { h, store };
}

describe('@ax/mcp-oauth e2e canary — sharee resolves owner agent-bound token + lazy refresh', () => {
  it('a different user resolves the OWNER agent-bound token, refreshes it lazily, and rotation is re-stored', async () => {
    const { fakeRefresh, recorder } = makeFakeRefresh();
    const { h, store } = await bootStack({ testOverrides: { refresh: fakeRefresh } });

    // The real resolver sub-service must be live (registered by the factory).
    expect(h.bus.hasService('credentials:resolve:mcp-oauth')).toBe(true);

    // (2) Client registration in the mcp-oauth store — the resolver's getClient
    //     reads it before refreshing.
    await store.putClient({
      clientKey: CLIENT_KEY,
      clientId: 'cid',
      clientSecret: 's',
      dynamic: true,
    });

    // (3) The OWNER stores an EXPIRED agent-bound token, exactly as the callback
    //     route would: scope:'agent', ownerId = the agent id. We write it via the
    //     REAL credentials:set hook (with an owner ctx) so it goes through the
    //     real envelope + store-blob backend.
    const ownerCtx = h.ctx({ agentId: 'agent-A', userId: 'owner' });
    await h.bus.call('credentials:set', ownerCtx, {
      scope: 'agent',
      ownerId: 'agent-A',
      ref: 'account:test',
      kind: 'mcp-oauth',
      payload: encodeTokenBlob({
        accessToken: 'stale-AT',
        refreshToken: 'rt1',
        tokenType: 'Bearer',
        expiresAt: PAST,
        scope: 'read',
        resource: 'https://mcp.example.com',
        authServerUrl: 'https://auth.example.com',
        tokenEndpoint: 'https://auth.example.com/token',
        clientKey: CLIENT_KEY,
      }),
      expiresAt: PAST,
    });

    // (4) SHAREE RIDES + REFRESH. A DIFFERENT user (bob), chatting the shared
    //     agent (ctx.agentId === 'agent-A'), resolves account:test. bob has no
    //     user-scope row; the precedence chain falls to the agent-scope row,
    //     which is the owner's token. It's expired, so the real resolver fires
    //     the (faked) refresh and returns the FRESH access token.
    const bobCtx = h.ctx({ agentId: 'agent-A', userId: 'bob' });
    const resolved = await h.bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      bobCtx,
      { ref: 'account:test', userId: 'bob' },
    );
    expect(resolved).toBe('fresh-AT'); // (a) bob got the OWNER's token, (b) refreshed, (c) fakeRefresh ran
    expect(recorder.calls).toBe(1);

    // (5a) ROTATION RE-STORE. The credentials plugin re-stored the refreshed
    //      blob under the SAME scope+owner. Peek the agent-scope row directly
    //      and assert the persisted refresh token rotated to 'rt2' and the
    //      access token is fresh.
    const got = await h.bus.call<
      { scope: 'agent'; ownerId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', h.ctx(), {
      scope: 'agent',
      ownerId: 'agent-A',
      ref: 'account:test',
    });
    expect(got.blob).toBeDefined();
    // The store-blob layer holds the ENCRYPTED envelope, not our raw token blob.
    // Decrypt it through the credentials envelope primitive (same key), unwrap
    // the credential envelope, then decode our token blob.
    const plaintext = await h.bus.call<{ ciphertext: Uint8Array }, { plaintext: string }>(
      'credentials:envelope-decrypt',
      h.ctx(),
      { ciphertext: got.blob! },
    );
    const env = JSON.parse(plaintext.plaintext) as { kind: string; payloadB64: string };
    expect(env.kind).toBe('mcp-oauth');
    const storedBlob = decodeTokenBlob(new Uint8Array(Buffer.from(env.payloadB64, 'base64')));
    expect(storedBlob.refreshToken).toBe('rt2'); // rotated + persisted
    expect(storedBlob.accessToken).toBe('fresh-AT'); // fresh AT persisted

    // (5b) SECOND RESOLVE — NO REFRESH. The persisted token is now valid, so a
    //      second resolve returns the fresh AT WITHOUT calling fakeRefresh again.
    const resolved2 = await h.bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      bobCtx,
      { ref: 'account:test', userId: 'bob' },
    );
    expect(resolved2).toBe('fresh-AT');
    expect(recorder.calls).toBe(1); // still exactly one refresh, ever
  });
});

// ---------------------------------------------------------------------------
// OPTIONAL begin→callback half (step 6). Drives the REAL begin/callback route
// handlers (mounted by the real plugin via mountRoutes:true) end-to-end against
// the real @ax/credentials stack: the callback's credentials:set lands an
// agent-bound mcp-oauth blob that a step-4-style sharee resolve then reads.
//
// We capture the route handlers off a fake http:register-route, inject the
// flow fakes through testOverrides, and stub the auth/agents/connectors hooks
// (begin/callback only READ those; routes.test.ts covers their reject paths in
// detail — here we exercise the happy path through to the vault + back out).
// ---------------------------------------------------------------------------

interface CapturedRoute {
  method: string;
  path: string;
  handler: (req: unknown, res: unknown) => Promise<void>;
}

function captureRouteServices(routes: CapturedRoute[]): Record<string, ServiceHandler> {
  return {
    'http:register-route': (async (_ctx, input) => {
      const r = input as CapturedRoute;
      routes.push(r);
      return { unregister: () => {} };
    }) as ServiceHandler,
    // begin authenticates as bob; callback re-authenticates as bob (same user
    // who began — the CSRF binding requires it).
    'auth:require-user': (async () => ({ user: { id: 'bob', isAdmin: false } })) as ServiceHandler,
    // A successful resolve IS the agent-owner authz — return a stub team agent
    // so the credential is stored agent-bound (scope:'agent', ownerId:'agent-A'),
    // matching the sharee-resolves design this canary exercises.
    'agents:resolve': (async () => ({ agent: { id: 'agent-A', visibility: 'team', ownerId: 'team-1' } })) as ServiceHandler,
    // One oauth slot + a matching mcpServer.
    'connectors:get': (async () => ({
      connector: {
        id: 'conn-1',
        capabilities: {
          allowedHosts: ['mcp.example.com', 'auth.example.com'],
          credentials: [{ slot: 'oauth-main', kind: 'oauth', server: 'srv', scopes: ['read'] }],
          mcpServers: [{ name: 'srv', url: 'https://mcp.example.com' }],
        },
      },
    })) as ServiceHandler,
  };
}

/** A minimal RouteResponse recorder. */
function fakeRes() {
  const rec: { statusCode: number; jsonBody: unknown; redirectUrl?: string } = {
    statusCode: 200,
    jsonBody: undefined,
  };
  const res = {
    status(n: number) {
      rec.statusCode = n;
      return res;
    },
    header() {
      return res;
    },
    json(v: unknown) {
      rec.jsonBody = v;
    },
    text() {},
    redirect(url: string) {
      rec.redirectUrl = url;
    },
    end() {},
  };
  return { res, rec };
}

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

describe('@ax/mcp-oauth e2e canary — begin→callback lands an agent-bound blob a sharee resolves', () => {
  it('callback stores an agent-bound mcp-oauth token via real credentials; a different user resolves it', async () => {
    const routes: CapturedRoute[] = [];

    // Flow fakes: discovery yields the auth-server metadata; redeemCode yields
    // the initial token pair. No SSRF, no network.
    const metadata = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      response_types_supported: ['code'],
    };
    const testOverrides = {
      discover: (async () => ({ authServerUrl: 'https://auth.example.com', metadata })) as never,
      ensureClient: (async () => ({
        clientKey: 'conn-1|https://auth.example.com',
        clientId: 'cid',
        clientSecret: undefined,
        dynamic: true,
      })) as never,
      buildAuthorization: (async () => ({
        authorizationUrl: 'https://auth.example.com/authorize?state=STATE0',
        codeVerifier: 'verifier-0',
      })) as never,
      redeemCode: (async () => ({
        access_token: 'callback-AT',
        refresh_token: 'callback-RT',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'read',
      })) as never,
    };

    const h = await createTestHarness({
      services: captureRouteServices(routes),
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createStoragePostgresPlugin(),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        createMcpOAuthPlugin({
          mountRoutes: true,
          publicOrigin: 'https://app.example.com',
          testOverrides,
        }),
      ],
    });
    harnesses.push(h);

    const begin = routes.find((r) => r.path === '/api/connectors/oauth/begin')!;
    const callback = routes.find((r) => r.path === '/api/connectors/oauth/callback')!;
    expect(begin).toBeDefined();
    expect(callback).toBeDefined();

    // begin: returns an authorizationUrl AND persists a pending row (with a
    // server-minted state). We can't read the state out of the response (only
    // the authorizationUrl), so we recover it from the pending store, the same
    // place the callback reads it from.
    const { res: beginRes, rec: beginRec } = fakeRes();
    await begin.handler(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-A' })) }),
      beginRes,
    );
    expect(beginRec.statusCode).toBe(200);
    expect((beginRec.jsonBody as { authorizationUrl: string }).authorizationUrl).toContain(
      'auth.example.com',
    );

    // Recover the minted state from the pending row.
    const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const pendingRow = await db
      .selectFrom('mcp_oauth_v1_pending')
      .select('state')
      .executeTakeFirst();
    expect(pendingRow?.state).toBeDefined();
    const state = pendingRow!.state;

    // callback: the provider redirects back with code+state; the handler
    // redeems (faked) and writes the agent-bound mcp-oauth blob through REAL
    // credentials:set, then redirects oauth=success.
    const { res: cbRes, rec: cbRec } = fakeRes();
    await callback.handler(fakeReq({ query: { code: 'auth-code', state } }), cbRes);
    expect(cbRec.redirectUrl).toContain('oauth=success');

    // A DIFFERENT user (carol) chatting agent-A resolves the freshly-stored,
    // still-valid token — no refresh needed (testOverrides.refresh is unset on
    // this stack, so a refresh attempt would throw; the token is valid so it
    // returns the stored access token directly).
    const carolCtx = h.ctx({ agentId: 'agent-A', userId: 'carol' });
    const resolved = await h.bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      carolCtx,
      { ref: 'account:conn-1', userId: 'carol' },
    );
    expect(resolved).toBe('callback-AT');
  });
});
