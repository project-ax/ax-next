import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestHarness,
  stopPostgresContainer,
  type TestHarness,
  startTestContainer,
} from '@ax/test-harness';
import type { ServiceHandler } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import type { Kysely } from 'kysely';
import { createMcpOAuthPlugin } from '../plugin.js';
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
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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
  /** The client each refresh call was made as (clientId / clientSecret only). */
  clients: Array<{ clientId: string; clientSecret: string | undefined }>;
}

/** Build a fake refresh (the production `testOverrides.refresh` shape) that
 *  returns a fresh access token + a ROTATED refresh token and records how many
 *  times it was invoked, and as which client. */
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
    clients: [],
  };
  const fakeRefresh: ResolverDeps['refresh'] = async ({ client }) => {
    recorder.calls += 1;
    recorder.clients.push({ clientId: client.clientId, clientSecret: client.clientSecret });
    return { ...recorder.refresh };
  };
  return { fakeRefresh, recorder };
}

/** Seed a row in the LEGACY shared client table. Nothing in the plugin writes it
 *  any more (the store has no putClient), so this stands in for a row left behind
 *  by the pre-TASK-696 `begin`, which a legacy token blob (no clientId of its own)
 *  still resolves its client through. */
async function seedLegacyClient(
  db: Kysely<McpOAuthDatabase>,
  c: { clientKey: string; clientId: string; clientSecret: string | null },
): Promise<void> {
  await db
    .insertInto('mcp_oauth_v1_clients')
    .values({
      client_key: c.clientKey,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      dynamic: true,
      created_at: new Date(),
    })
    .execute();
}

async function bootStack(testOverrides: Parameters<typeof createMcpOAuthPlugin>[0]) {
  const h = await createTestHarness({
    // TASK-711 — the vault reads an agent-scope `account:` row only when a
    // provider of `credentials:authorize-agent:account` (@ax/connectors in a
    // real host) says the reader resolves the one shared connector. This canary
    // is about the sharee resolving the agent-bound token, so the stand-in says yes.
    services: {
      'credentials:authorize-agent:account': (async () => ({ allowed: true })) as ServiceHandler,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createStoragePostgresPlugin(),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      createMcpOAuthPlugin(testOverrides),
    ],
  });
  harnesses.push(h);
  // The plugin's tables live on the same shared kysely the plugin migrated. The
  // migration already ran in the plugin's init; grab that instance so the test
  // can seed the legacy client registration row.
  const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  await runMcpOAuthMigration(db); // idempotent — CREATE TABLE IF NOT EXISTS
  return { h, db };
}

describe('@ax/mcp-oauth e2e canary — sharee resolves owner agent-bound token + lazy refresh', () => {
  // This canary's token is a LEGACY blob (written before TASK-696: no clientId of
  // its own), so it proves the fallback path stays alive: the resolver reads the
  // client from the shared legacy row by `clientKey`. The per-token path (a blob
  // that carries its own client) is the next test.
  it('a different user resolves the OWNER agent-bound token, refreshes it lazily, and rotation is re-stored (LEGACY blob → legacy client row)', async () => {
    const { fakeRefresh, recorder } = makeFakeRefresh();
    const { h, db } = await bootStack({ testOverrides: { refresh: fakeRefresh } });

    // The real resolver sub-service must be live (registered by the factory).
    expect(h.bus.hasService('credentials:resolve:mcp-oauth')).toBe(true);

    // (2) Legacy client registration row — the resolver's getClient(clientKey)
    //     reads it before refreshing a blob that has no clientId.
    await seedLegacyClient(db, { clientKey: CLIENT_KEY, clientId: 'cid', clientSecret: 's' });

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
    // The legacy blob refreshed as the client in the shared legacy row.
    expect(recorder.clients).toEqual([{ clientId: 'cid', clientSecret: 's' }]);

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

  // TASK-696: a token that carries its own client refreshes as THAT client, with
  // no shared client row involved, and the client survives the vault re-store.
  it('a blob carrying its own client refreshes as that client (no legacy row needed) and keeps it after the re-store', async () => {
    const { fakeRefresh, recorder } = makeFakeRefresh();
    const { h, db } = await bootStack({ testOverrides: { refresh: fakeRefresh } });

    // A DIFFERENT client sits in the shared legacy row for the same clientKey (what
    // a later `begin` used to leave behind). It must NOT be the one used.
    await seedLegacyClient(db, { clientKey: CLIENT_KEY, clientId: 'registered-last', clientSecret: null });

    await h.bus.call('credentials:set', h.ctx({ agentId: 'agent-A', userId: 'owner' }), {
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
        clientId: 'issuing-cid',
        clientSecret: 'issuing-secret',
      }),
      expiresAt: PAST,
    });

    const resolved = await h.bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      h.ctx({ agentId: 'agent-A', userId: 'bob' }),
      { ref: 'account:test', userId: 'bob' },
    );
    expect(resolved).toBe('fresh-AT');
    expect(recorder.clients).toEqual([{ clientId: 'issuing-cid', clientSecret: 'issuing-secret' }]);

    // The re-stored (refreshed) blob still names its issuing client.
    const got = await h.bus.call<
      { scope: 'agent'; ownerId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', h.ctx(), { scope: 'agent', ownerId: 'agent-A', ref: 'account:test' });
    const plaintext = await h.bus.call<{ ciphertext: Uint8Array }, { plaintext: string }>(
      'credentials:envelope-decrypt',
      h.ctx(),
      { ciphertext: got.blob! },
    );
    const env = JSON.parse(plaintext.plaintext) as { payloadB64: string };
    const stored = decodeTokenBlob(new Uint8Array(Buffer.from(env.payloadB64, 'base64')));
    expect(stored.refreshToken).toBe('rt2');
    expect(stored.clientId).toBe('issuing-cid');
    expect(stored.clientSecret).toBe('issuing-secret');
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
    // TASK-711 — @ax/connectors' answer to "is conn-1 the one shared connector
    // every member of agent-A sees?". Yes here, so the sign-in is stored on the
    // agent AND the vault lets the sharee read it back there.
    'credentials:authorize-agent:account': (async () => ({ allowed: true })) as ServiceHandler,
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

// ---------------------------------------------------------------------------
// USER-SCOPE (connect-once) canary.  begin is called WITHOUT an agentId, so
// the route stores the token at scope:'user', ownerId = the initiating user.
// Any agent that user later chats resolves the SAME token via the user-scope
// step of the precedence chain — "connect once, all your agents use it."
// ---------------------------------------------------------------------------

describe('@ax/mcp-oauth e2e canary — user-scope connect-once reuse across agents', () => {
  it('callback stores a user-scoped mcp-oauth token; two different agentIds for the same user resolve the same token', async () => {
    const routes: CapturedRoute[] = [];

    // Same flow fakes as the agent-bound canary below — no real network.
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
        access_token: 'dave-user-AT',
        refresh_token: 'dave-user-RT',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'read',
      })) as never,
    };

    // auth:require-user returns dave; agents:resolve is NOT called when agentId
    // is absent (begin skips the agents:resolve gate).
    const userScopeServices: Record<string, ServiceHandler> = {
      'http:register-route': (async (_ctx, input) => {
        const r = input as CapturedRoute;
        routes.push(r);
        return { unregister: () => {} };
      }) as ServiceHandler,
      'auth:require-user': (async () => ({ user: { id: 'dave', isAdmin: false } })) as ServiceHandler,
      // agents:resolve is registered to satisfy the plugin manifest (which
      // declares it when mountRoutes:true), but the no-agentId begin path MUST
      // NOT invoke it. If it is called, the test would still pass but the
      // routing logic would be wrong — the callback stores based on credScope
      // captured at begin, so a call here would indicate a regression.
      'agents:resolve': (async () => {
        throw new Error('agents:resolve must not be called for no-agentId begin');
      }) as ServiceHandler,
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

    const h = await createTestHarness({
      services: userScopeServices,
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

    // (1) begin WITHOUT agentId — the route must accept it and produce a user-scoped pending row.
    const { res: beginRes, rec: beginRec } = fakeRes();
    await begin.handler(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1' })) }),
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
      .select(['state', 'cred_scope'])
      .executeTakeFirst();
    expect(pendingRow?.state).toBeDefined();
    // Verify the pending row captured user scope (not agent scope).
    expect(pendingRow?.cred_scope).toBe('user');
    const state = pendingRow!.state;

    // (2) callback — provider redirects back; handler redeems (faked) and writes
    // the user-scoped mcp-oauth blob through REAL credentials:set.
    const { res: cbRes, rec: cbRec } = fakeRes();
    await callback.handler(fakeReq({ query: { code: 'auth-code', state } }), cbRes);
    expect(cbRec.redirectUrl).toContain('oauth=success');

    // (3) Assert the stored credential is scope:'user', ownerId:'dave'.
    const got = await h.bus.call<
      { scope: 'user'; ownerId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', h.ctx(), {
      scope: 'user',
      ownerId: 'dave',
      ref: 'account:conn-1',
    });
    expect(got.blob).toBeDefined();
    // Decrypt and verify it is our mcp-oauth token.
    const plaintext = await h.bus.call<{ ciphertext: Uint8Array }, { plaintext: string }>(
      'credentials:envelope-decrypt',
      h.ctx(),
      { ciphertext: got.blob! },
    );
    const env = JSON.parse(plaintext.plaintext) as { kind: string; payloadB64: string };
    expect(env.kind).toBe('mcp-oauth');
    const storedBlob = decodeTokenBlob(new Uint8Array(Buffer.from(env.payloadB64, 'base64')));
    expect(storedBlob.accessToken).toBe('dave-user-AT');
    expect(storedBlob.refreshToken).toBe('dave-user-RT');
    // TASK-696: the blob names the client the authorization was started with...
    expect(storedBlob.clientId).toBe('cid');
    expect('clientSecret' in storedBlob).toBe(false); // public client
    // ...and begin/callback wrote nothing to the (legacy, read-only) shared client table.
    expect(await db.selectFrom('mcp_oauth_v1_clients').selectAll().execute()).toEqual([]);

    // (4) User-scope reuse: two DIFFERENT agentIds resolve the same token.
    // The precedence chain (user → agent → global) hits the user-scope row first
    // for both, so both return the same access token — connect once, all agents use it.
    const r1 = await h.bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      h.ctx({ userId: 'dave', agentId: 'agent-X' }),
      { ref: 'account:conn-1', userId: 'dave' },
    );
    const r2 = await h.bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      h.ctx({ userId: 'dave', agentId: 'agent-Y' }),
      { ref: 'account:conn-1', userId: 'dave' },
    );
    expect(r1).toBe('dave-user-AT');
    expect(r2).toBe('dave-user-AT');
    expect(r1).toBe(r2); // same user-scope token across agents (connect once, all agents use it)
  });
});

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
