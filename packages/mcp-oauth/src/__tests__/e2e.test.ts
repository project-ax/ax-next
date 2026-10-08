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

// Slice 4 — "Signed in as" lives in the credential's ENVELOPE metadata. A lazy
// refresh re-stores the token through the REAL vault; the label must survive it
// (the vault keeps `env.metadata` when the resolver returns none of its own).
describe('@ax/mcp-oauth e2e canary — the sign-in identity survives a refresh (slice 4)', () => {
  it('envelope metadata {account, signedInBy, signedInAt} is unchanged after a refresh re-store', async () => {
    const { fakeRefresh, recorder } = makeFakeRefresh();
    const { h } = await bootStack({ testOverrides: { refresh: fakeRefresh } });
    const signIn = {
      account: 'alice@example.com',
      signedInBy: 'owner',
      signedInAt: '2026-10-07T12:00:00.000Z',
    };

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
      }),
      expiresAt: PAST,
      metadata: signIn,
    });

    const resolved = await h.bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      h.ctx({ agentId: 'agent-A', userId: 'owner' }),
      { ref: 'account:test', userId: 'owner' },
    );
    expect(resolved).toBe('fresh-AT');
    expect(recorder.calls).toBe(1); // the refresh really ran and re-stored

    const got = await h.bus.call<
      { scope: 'agent'; ownerId: string; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', h.ctx(), { scope: 'agent', ownerId: 'agent-A', ref: 'account:test' });
    const plaintext = await h.bus.call<{ ciphertext: Uint8Array }, { plaintext: string }>(
      'credentials:envelope-decrypt',
      h.ctx(),
      { ciphertext: got.blob! },
    );
    const env = JSON.parse(plaintext.plaintext) as { payloadB64: string; metadata?: unknown };
    const stored = decodeTokenBlob(new Uint8Array(Buffer.from(env.payloadB64, 'base64')));
    expect(stored.accessToken).toBe('fresh-AT'); // this IS the re-stored row
    expect(env.metadata).toEqual(signIn);
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
  // `agentId|connectorId` pairs the callback attached. Begin's Add asks the
  // read question (no `purpose`) to refuse an Add of a connector already on
  // the agent, so "yes" must mean "attached", as @ax/connectors answers it.
  const attached = new Set<string>();
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
    // An Add's callback attaches the connector once the sign-in is stored.
    'agents:attach-connector': (async (_c, input) => {
      const { agentId, connectorId } = input as { agentId: string; connectorId: string };
      attached.add(`${agentId}|${connectorId}`);
      return { agent: {}, changed: true };
    }) as ServiceHandler,
    // TASK-798/813 — bob is a team admin of agent-A's team, so he may sign in for it.
    'agents:can-set-shared-credential': (async () => ({ allowed: true })) as ServiceHandler,
    // TASK-711 — @ax/connectors' answer to "is conn-1 the one shared connector
    // every member of agent-A sees?". Yes here, so the sign-in is stored on the
    // agent AND the vault lets the sharee read it back there — once attached.
    'credentials:authorize-agent:account': (async (_c, input) => {
      const i = input as { agentId: string; ref: string; purpose?: string };
      if (i.purpose === 'store') return { allowed: true };
      return { allowed: attached.has(`${i.agentId}|${i.ref.replace(/^account:/, '')}`) };
    }) as ServiceHandler,
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
        // Slice 4 — the account the agent signed in as (signature unchecked;
        // display only).
        id_token: `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
          JSON.stringify({ email: 'owner@example.com' }),
        ).toString('base64url')}.sig`,
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
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-A', mode: 'add' })) }),
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

    // Slice 4 — the real vault holds the sign-in identity as envelope metadata,
    // and credentials:list hands those exact keys back.
    const listed = await h.bus.call<
      { scope: 'agent'; ownerId: string },
      { credentials: Array<{ ref: string; metadata?: Record<string, unknown> }> }
    >('credentials:list', h.ctx({ agentId: 'agent-A', userId: 'owner' }), { scope: 'agent', ownerId: 'agent-A' });
    const row = listed.credentials.find((c) => c.ref === 'account:conn-1');
    expect(row?.metadata).toMatchObject({ account: 'owner@example.com' });
    expect(typeof row?.metadata?.signedInBy).toBe('string');
    expect(Number.isNaN(Date.parse(String(row?.metadata?.signedInAt)))).toBe(false);
  });
});

// Slice 3 — every sign-in belongs to an agent. One person, two of their own
// agents, the same connector, two different accounts: each Add lands its own
// agent-scope row (owner A, owner B), attaches to its own agent, and neither
// overwrites the other.
describe('@ax/mcp-oauth e2e canary — two agents of one owner keep two separate sign-ins', () => {
  it('Add on agent-A then on agent-B writes ownerId A and ownerId B; each agent resolves its own account', async () => {
    const routes: CapturedRoute[] = [];
    const metadata = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      response_types_supported: ['code'],
    };
    // The provider hands out a different account's token per redemption.
    const issued = ['account-1-AT', 'account-2-AT'];
    let redemptions = 0;
    const attaches: unknown[] = [];
    const services = captureRouteServices(routes);
    // bob's own PERSONAL agents: resolve hands back whichever agent was asked for.
    services['agents:resolve'] = (async (_c, input) => ({
      agent: { id: (input as { agentId: string }).agentId, visibility: 'personal', ownerId: 'bob' },
    })) as ServiceHandler;
    const recordAttach = services['agents:attach-connector']!;
    services['agents:attach-connector'] = (async (c, input) => {
      attaches.push(input);
      return recordAttach(c, input);
    }) as ServiceHandler;
    const h = await createTestHarness({
      services,
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createStoragePostgresPlugin(),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        createMcpOAuthPlugin({
          mountRoutes: true,
          publicOrigin: 'https://app.example.com',
          testOverrides: {
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
              access_token: issued[redemptions++]!,
              expires_in: 3600,
              token_type: 'Bearer',
              scope: 'read',
            })) as never,
          },
        }),
      ],
    });
    harnesses.push(h);
    const begin = routes.find((r) => r.path === '/api/connectors/oauth/begin')!;
    const callback = routes.find((r) => r.path === '/api/connectors/oauth/callback')!;
    const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );

    const addOn = async (agentId: string) => {
      const { res: beginRes, rec: beginRec } = fakeRes();
      await begin.handler(
        fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId, mode: 'add' })) }),
        beginRes,
      );
      expect(beginRec.statusCode).toBe(200);
      const row = await db
        .selectFrom('mcp_oauth_v1_pending')
        .select('state')
        .where('agent_id', '=', agentId)
        .executeTakeFirstOrThrow();
      const { res: cbRes, rec: cbRec } = fakeRes();
      await callback.handler(fakeReq({ query: { code: `code-${agentId}`, state: row.state } }), cbRes);
      expect(cbRec.redirectUrl).toBe('https://app.example.com/oauth/connected?connector=conn-1&oauth=success');
    };
    await addOn('agent-A');
    await addOn('agent-B');

    // Each Add attached the connector to ITS agent, as bob.
    expect(attaches).toEqual([
      { actor: { userId: 'bob', isAdmin: false }, agentId: 'agent-A', connectorId: 'conn-1' },
      { actor: { userId: 'bob', isAdmin: false }, agentId: 'agent-B', connectorId: 'conn-1' },
    ]);
    // Two agent-scope rows, owners A and B — and nothing on bob himself.
    const get = (agentId: string) =>
      h.bus.call<{ ref: string; userId: string }, string>(
        'credentials:get',
        h.ctx({ agentId, userId: 'bob' }),
        { ref: 'account:conn-1', userId: 'bob' },
      );
    expect(await get('agent-A')).toBe('account-1-AT');
    expect(await get('agent-B')).toBe('account-2-AT');
    await expect(get('')).rejects.toMatchObject({ code: 'credential-not-found' });
  });
});

// TASK-858 — a team admin removes the agent's shared sign-in. Through the REAL
// vault and the REAL callback: the sign-in the callback wrote is gone for every
// member (so the rail reads "needs sign-in"), its "expired" marker goes with it,
// and a person's OWN sign-in to the same connector is not touched.
describe('@ax/mcp-oauth e2e canary — mcp-oauth:remove-shared-sign-in removes the sign-in the callback wrote', () => {
  it('after removal the sharee has no sign-in and no stale marker; a personal sign-in for the same connector survives', async () => {
    const routes: CapturedRoute[] = [];
    const metadata = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      response_types_supported: ['code'],
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
          testOverrides: {
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
              access_token: 'team-AT',
              refresh_token: 'team-RT',
              expires_in: 3600,
              token_type: 'Bearer',
              scope: 'read',
            })) as never,
          },
        }),
      ],
    });
    harnesses.push(h);
    const begin = routes.find((r) => r.path === '/api/connectors/oauth/begin')!;
    const callback = routes.find((r) => r.path === '/api/connectors/oauth/callback')!;
    const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );

    // A team admin (bob) signs in for team agent-A: the callback writes the
    // agent-bound row, exactly the one the hook must remove.
    const { res: beginRes } = fakeRes();
    await begin.handler(
      fakeReq({ body: Buffer.from(JSON.stringify({ connectorId: 'conn-1', agentId: 'agent-A', mode: 'add' })) }),
      beginRes,
    );
    const pending = await db.selectFrom('mcp_oauth_v1_pending').select('state').executeTakeFirstOrThrow();
    const { res: cbRes, rec: cbRec } = fakeRes();
    await callback.handler(fakeReq({ query: { code: 'auth-code', state: pending.state } }), cbRes);
    expect(cbRec.redirectUrl).toContain('oauth=success');

    // carol ALSO has her own sign-in to the same connector (user scope).
    await h.bus.call('credentials:set', h.ctx({ userId: 'carol' }), {
      scope: 'user',
      ownerId: 'carol',
      ref: 'account:conn-1',
      kind: 'mcp-oauth',
      payload: encodeTokenBlob({
        accessToken: 'carol-own-AT',
        refreshToken: 'carol-own-RT',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 60 * 60_000,
        resource: 'https://mcp.example.com',
        authServerUrl: 'https://auth.example.com',
        tokenEndpoint: 'https://auth.example.com/token',
        clientKey: 'conn-1|https://auth.example.com',
        clientId: 'cid',
      }),
    });

    const get = (userId: string) =>
      h.bus.call<{ ref: string; userId: string }, string>(
        'credentials:get',
        h.ctx({ agentId: 'agent-A', userId }),
        { ref: 'account:conn-1', userId },
      );
    const has = (userId: string) =>
      h.bus.call<{ ref: string; userId: string }, { present: boolean }>(
        'credentials:has',
        h.ctx({ agentId: 'agent-A', userId }),
        { ref: 'account:conn-1', userId },
      );
    expect(await get('bob')).toBe('team-AT');

    // The shared sign-in was once rejected: the rail would read "expired".
    const sharedMarked = async () =>
      (
        await h.bus.call<unknown, { needsReconnect: string[]; shared: string[] }>(
          'mcp-oauth:status-batch',
          h.ctx(),
          { userId: 'bob', agentId: 'agent-A', connectorIds: ['conn-1'] },
        )
      ).shared;
    await createMcpOAuthStore(db).markNeedsReconnect({ kind: 'agent', agentId: 'agent-A' }, 'conn-1');
    expect(await sharedMarked()).toEqual(['conn-1']);

    const out = await h.bus.call('mcp-oauth:remove-shared-sign-in', h.ctx({ userId: 'bob' }), {
      agentId: 'agent-A',
      connectorId: 'conn-1',
    });
    expect(out).toEqual({ removed: true });

    // Gone for the sharee: no row (so the rail says "needs sign-in") and no marker.
    await expect(get('bob')).rejects.toMatchObject({ code: 'credential-not-found' });
    expect(await has('bob')).toEqual({ present: false });
    expect(await sharedMarked()).toEqual([]);
    // carol's own sign-in is hers: still there, still the one she resolves.
    expect(await get('carol')).toBe('carol-own-AT');
    expect(await has('carol')).toEqual({ present: true });

    // Removing again (already gone) is a quiet success, not an error.
    expect(
      await h.bus.call('mcp-oauth:remove-shared-sign-in', h.ctx({ userId: 'bob' }), {
        agentId: 'agent-A',
        connectorId: 'conn-1',
      }),
    ).toEqual({ removed: true });
  });
});
