import { createHash, randomBytes } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { sql, type Kysely } from 'kysely';
import { createMcpOAuthPlugin } from '../plugin.js';
import type { McpOAuthDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// REGRESSION: an OAuth token must be refreshed / redeemed as the client it was
// ISSUED TO (TASK-696).
//
// The bug: `begin` used to re-register an RFC 7591 DCR client on every call and
// upsert ONE shared client row (`${connectorId}|${authServerUrl}`). Every later
// callback-redeem and every refresh-on-read then used whichever client had
// registered LAST, not the client the authorization code / refresh token was
// issued to. A strict RFC 6749 authorization server binds both to their issuing
// client (§4.1.3, §6, §10.4) and answers `invalid_grant`, so connecting a second
// agent to a connector silently killed the first agent's connection.
//
// Everything real except the network edge. The real plugin (NO `testOverrides`),
// the real begin/callback/status routes, the real oauth-flow driving the real MCP
// SDK, the real store + @ax/credentials + credentials-store-db, all on a Postgres
// testcontainer. Only two things are faked: `globalThis.fetch` for `*.example.com`
// (an in-process authorization server that enforces client binding) and the DNS
// lookup for `*.example.com` (so the SSRF guard sees a public address).
//
// Tests labelled [CONTROL] pin behaviour that must hold with or without the fix
// (they exist to prove the harness and the fake AS are not the reason the other
// tests fail). Every other test fails against the pre-fix code.
// ---------------------------------------------------------------------------

vi.mock('node:dns/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:dns/promises')>();
  const lookup = async (h: string, ...rest: unknown[]) =>
    h.endsWith('.example.com')
      ? { address: '93.184.216.34', family: 4 }
      : (orig.lookup as (...a: unknown[]) => unknown)(h, ...rest);
  return { ...orig, lookup, default: { ...(orig as { default?: object }).default, lookup } };
});

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const APP = 'https://app.example.com';
const REDIRECT = `${APP}/api/connectors/oauth/callback`;
const AS = 'https://auth.example.com';
const RS = 'https://mcp.example.com';
/** The legacy shared client row's key: `${connectorId}|${authServerUrl}`. */
const SHARED_CLIENT_KEY = `conn-1|${AS}`;

// ---------------------------------------------------------------------------
// Fake authorization server (RFC 6749 / 7591 behaviour).
// ---------------------------------------------------------------------------
interface AsOpts {
  /** Publish resource metadata only at the URL in the authentication challenge. */
  challengeOnly: boolean;
  /** DCR hands back a client_secret (confidential client) instead of a public client. */
  issueSecret: boolean;
  /** RFC 6749 §6 / §10.4: a refresh token is bound to the client it was issued to. */
  bindRefreshToClient: boolean;
  /** `error_description` on invalid_grant; `undefined` omits the field entirely. */
  errorDescription: string | undefined;
  /** Per-arrival-order delay (ms) for DCR responses, to force begin interleavings. */
  registerDelayMsByCall: number[];
  /** `expires_in` on issued access tokens. 60s is inside the resolver's 5-minute refresh
   *  margin, so every `credentials:get` refreshes. */
  accessTokenTtlSec: number;
  /** Echo the code, verifier, client secret and refresh token into invalid_grant descriptions,
   *  the way a careless AS might. Lets a test prove the routes never log a provider body. */
  echoSecretsInErrors: boolean;
}

interface Grant {
  grant: string | null;
  clientId: string | undefined;
  refreshToken: string | undefined;
  outcome: 'ok' | 'invalid_grant' | 'invalid_client' | 'server_error';
}

class FakeAs {
  readonly opts: AsOpts;
  private n = 0;
  private regCalls = 0;
  readonly clients = new Map<string, { secret?: string; redirectUris: string[] }>();
  readonly codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
  readonly refreshTokens = new Map<string, { clientId: string }>();
  /** Every token-endpoint request, in arrival order. */
  readonly grants: Grant[] = [];
  /** Failures the next refresh_token grants should answer with (consumed one per grant). */
  private readonly transientRefreshFailures: Array<{ error: string; error_description: string }> = [];
  /** value -> what it is. Everything secret-shaped this AS minted or was shown. */
  readonly sensitive = new Map<string, string>();

  constructor(opts: Partial<AsOpts> = {}) {
    this.opts = {
      challengeOnly: false,
      issueSecret: false,
      bindRefreshToClient: true,
      errorDescription: 'The provided refresh token is invalid, expired, or was issued to another client.',
      registerDelayMsByCall: [],
      accessTokenTtlSec: 60,
      echoSecretsInErrors: false,
      ...opts,
    };
  }

  /** Answer the next refresh_token grant with a non-invalid_grant failure. */
  failNextRefresh(status500Body: { error: string; error_description: string }): void {
    this.transientRefreshFailures.push(status500Body);
  }

  private mint(kind: string): string {
    const v = `${kind.replace(/\s+/g, '_')}_${randomBytes(12).toString('hex')}`;
    this.sensitive.set(v, kind);
    return v;
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.toString() === `${RS}/` && method === 'GET') {
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': this.opts.challengeOnly
          ? `Bearer resource_metadata="${RS}/oauth/resource", scope="resource.read"`
          : 'Bearer' },
      });
    }
    if (url.host === 'mcp.example.com' && url.pathname === '/oauth/resource') {
      return this.json(200, { resource: RS, authorization_servers: [AS] });
    }
    if (url.host === 'mcp.example.com' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      if (this.opts.challengeOnly) return this.json(404, {});
      return this.json(200, { resource: RS, authorization_servers: [AS] });
    }
    if (url.host === 'auth.example.com' && url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return this.json(200, {
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        registration_endpoint: `${AS}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.host === 'auth.example.com' && url.pathname === '/register' && method === 'POST') {
      const call = this.regCalls++;
      const meta = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
      const delay = this.opts.registerDelayMsByCall[call] ?? 0;
      const id = `client-${++this.n}`; // named at ARRIVAL order, stored after the delay
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const secret = this.opts.issueSecret ? this.mint('client secret') : undefined;
      this.clients.set(id, { ...(secret ? { secret } : {}), redirectUris: meta.redirect_uris });
      return this.json(201, {
        client_id: id,
        ...(secret ? { client_secret: secret } : {}),
        redirect_uris: meta.redirect_uris,
      });
    }
    if (url.host === 'auth.example.com' && url.pathname === '/token' && method === 'POST') {
      return this.token(init);
    }
    throw new Error(`FakeAs: unexpected ${method} ${url}`);
  };

  /** The "browser" step: the user approves at the authorize endpoint. */
  authorize(authorizationUrl: string): { code: string; state: string } {
    const u = new URL(authorizationUrl);
    const clientId = u.searchParams.get('client_id')!;
    const c = this.clients.get(clientId);
    if (!c) throw new Error(`authorize: unknown client_id ${clientId}`);
    if (!c.redirectUris.includes(u.searchParams.get('redirect_uri')!)) {
      throw new Error('authorize: bad redirect_uri');
    }
    const code = this.mint('authorization code');
    this.codes.set(code, {
      clientId,
      challenge: u.searchParams.get('code_challenge')!,
      redirectUri: u.searchParams.get('redirect_uri')!,
    });
    return { code, state: u.searchParams.get('state')! };
  }

  private token(init?: RequestInit): Response {
    const p = new URLSearchParams(String(init?.body));
    const h = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
    let clientId = p.get('client_id') ?? undefined;
    let secret = p.get('client_secret') ?? undefined;
    const basic = h.get('authorization');
    if (basic?.startsWith('Basic ')) {
      const [id, s] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
      clientId = decodeURIComponent(id ?? '');
      secret = decodeURIComponent(s ?? '');
    }
    const grant = p.get('grant_type');
    const refreshToken = p.get('refresh_token') ?? undefined;
    const verifier = p.get('code_verifier');
    if (verifier) this.sensitive.set(verifier, 'code verifier');
    const record = (outcome: Grant['outcome']) =>
      this.grants.push({ grant, clientId, refreshToken, outcome });

    // Client authentication (RFC 6749 §2.3 / §5.2 invalid_client).
    const client = clientId ? this.clients.get(clientId) : undefined;
    if (!client || (client.secret !== undefined && client.secret !== secret)) {
      record('invalid_client');
      return this.json(401, { error: 'invalid_client', error_description: 'Client authentication failed.' });
    }
    const bad = () => {
      record('invalid_grant');
      const description = this.opts.echoSecretsInErrors
        ? `rejected code=${p.get('code')} verifier=${verifier} secret=${secret} refresh_token=${refreshToken}`
        : this.opts.errorDescription;
      return this.json(400, {
        error: 'invalid_grant',
        ...(description !== undefined ? { error_description: description } : {}),
      });
    };
    const issue = (withRefresh: boolean) => {
      const at = this.mint('access token');
      const rt = withRefresh ? this.mint('refresh token') : undefined;
      if (rt) this.refreshTokens.set(rt, { clientId: clientId! });
      return this.json(200, {
        access_token: at,
        ...(rt ? { refresh_token: rt } : {}),
        expires_in: this.opts.accessTokenTtlSec,
        token_type: 'Bearer',
      });
    };

    if (grant === 'authorization_code') {
      const rec = this.codes.get(p.get('code') ?? '');
      if (!rec) return bad(); // unknown / already used
      this.codes.delete(p.get('code')!); // single use
      if (rec.clientId !== clientId) return bad(); // RFC 6749 §4.1.3: code bound to its client
      if (rec.redirectUri !== p.get('redirect_uri')) return bad();
      if (createHash('sha256').update(verifier ?? '').digest('base64url') !== rec.challenge) return bad();
      record('ok');
      return issue(true);
    }
    if (grant === 'refresh_token') {
      const transient = this.transientRefreshFailures.shift();
      if (transient) {
        record('server_error');
        return this.json(500, transient);
      }
      const rec = this.refreshTokens.get(refreshToken ?? '');
      if (!rec) return bad();
      if (this.opts.bindRefreshToClient && rec.clientId !== clientId) return bad();
      record('ok');
      return issue(false);
    }
    return this.json(400, { error: 'unsupported_grant_type' });
  }
}

// ---------------------------------------------------------------------------
// Harness plumbing (mirrors e2e.test.ts).
// ---------------------------------------------------------------------------
interface CapturedRoute {
  method: string;
  path: string;
  handler: (req: unknown, res: unknown) => Promise<void>;
}
interface JsonBody {
  authorizationUrl?: string;
  status?: string;
  error?: string;
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
const realFetch = globalThis.fetch;
let fas: FakeAs;

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
  globalThis.fetch = realFetch;
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
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

function fakeRes() {
  const rec: { status: number; json?: JsonBody; redirectUrl?: string } = { status: 200 };
  const res = {
    status(n: number) {
      rec.status = n;
      return res;
    },
    header() {
      return res;
    },
    json(v: unknown) {
      rec.json = v as JsonBody;
    },
    text() {},
    redirect(u: string) {
      rec.redirectUrl = u;
    },
    end() {},
  };
  return { res, rec };
}

function fakeReq(user: string, over: { body?: unknown; query?: Record<string, string> } = {}) {
  const query: Record<string, string> = {};
  // @ax/http-server lowercases query keys; do the same.
  for (const [k, v] of Object.entries(over.query ?? {})) query[k.toLowerCase()] = v;
  return {
    headers: { 'x-user': user },
    body: Buffer.from(over.body === undefined ? '' : JSON.stringify(over.body)),
    cookies: {},
    query,
    params: {},
    signedCookie: () => null,
  };
}

type ResolveResult =
  | { ok: true; token: string }
  | { ok: false; code?: string; causeName?: string; msg: string };

interface Stack {
  h: TestHarness;
  db: Kysely<McpOAuthDatabase>;
  begin(
    user: string,
    body: { connectorId: string; agentId?: string },
  ): Promise<{ status: number; authorizationUrl?: string }>;
  callback(user: string, code: string, state: string): Promise<string | undefined>;
  /** begin -> (browser approve) -> callback, all sequential. `clientId` is the client the
   *  authorization request named, i.e. the one the token is meant to be issued to. */
  connect(
    user: string,
    connectorId: string,
    agentId?: string,
  ): Promise<{ redirect: string | undefined; clientId: string }>;
  status(
    user: string,
    connectorId: string,
    agentId?: string,
  ): Promise<{ status: number; json: JsonBody | undefined }>;
  /** Resolve through `credentials:get`, the same path a chat turn and `/status` use. */
  resolve(user: string, agentId: string): Promise<ResolveResult>;
  clientRows(): Promise<Array<{ client_key: string; client_id: string; client_secret: string | null }>>;
  pendingStates(): Promise<string[]>;
}

const clientIdOf = (authorizationUrl: string): string =>
  new URL(authorizationUrl).searchParams.get('client_id')!;

async function boot(opts: { visibility: 'team' | 'personal'; asOpts?: Partial<AsOpts>; scopes?: string[] }): Promise<Stack> {
  fas = new FakeAs(opts.asOpts);
  const routes: CapturedRoute[] = [];
  const services: Record<string, ServiceHandler> = {
    'http:register-route': (async (_c, input) => {
      routes.push(input as CapturedRoute);
      return { unregister: () => {} };
    }) as ServiceHandler,
    'auth:require-user': (async (_c, input) => ({
      user: { id: (input as { req: { headers: Record<string, string> } }).req.headers['x-user'], isAdmin: false },
    })) as ServiceHandler,
    'agents:resolve': (async (_c, input) => ({
      agent: { id: (input as { agentId: string }).agentId, visibility: opts.visibility, ownerId: 'alice' },
    })) as ServiceHandler,
    // Connectors are keyed (owner, slug), so every user can own a connector with the SAME
    // id `conn-1` -- the harness hands back the same shape for whoever asks.
    'connectors:get': (async () => ({
      connector: {
        id: 'conn-1',
        capabilities: {
          allowedHosts: ['mcp.example.com', 'auth.example.com'],
          credentials: [{ slot: 'oauth-main', kind: 'oauth', server: 'srv', scopes: opts.scopes ?? ['read'] }],
          mcpServers: [{ name: 'srv', url: RS }],
        },
      },
    })) as ServiceHandler,
  };
  globalThis.fetch = ((i: string | URL, init?: RequestInit) => {
    const host = new URL(typeof i === 'string' ? i : i.toString()).host;
    return host.endsWith('.example.com') ? fas.fetch(i, init) : realFetch(i, init);
  }) as typeof fetch;

  const h = await createTestHarness({
    services,
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createStoragePostgresPlugin(),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      // NO testOverrides: production begin/callback/status + the real refresh path.
      createMcpOAuthPlugin({ mountRoutes: true, publicOrigin: APP }),
    ],
  });
  harnesses.push(h);
  const route = (p: string) => routes.find((r) => r.path === p)!.handler;
  const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );

  const stack: Stack = {
    h,
    db,
    async begin(user, body) {
      const { res, rec } = fakeRes();
      await route('/api/connectors/oauth/begin')(fakeReq(user, { body }), res);
      return {
        status: rec.status,
        ...(rec.json?.authorizationUrl !== undefined ? { authorizationUrl: rec.json.authorizationUrl } : {}),
      };
    },
    async callback(user, code, state) {
      const { res, rec } = fakeRes();
      await route('/api/connectors/oauth/callback')(fakeReq(user, { query: { code, state } }), res);
      return rec.redirectUrl;
    },
    async connect(user, connectorId, agentId) {
      const b = await stack.begin(user, { connectorId, ...(agentId ? { agentId } : {}) });
      if (b.status !== 200 || !b.authorizationUrl) throw new Error(`begin failed ${b.status}`);
      const { code, state } = fas.authorize(b.authorizationUrl);
      const redirect = await stack.callback(user, code, state);
      return { redirect, clientId: clientIdOf(b.authorizationUrl) };
    },
    async status(user, connectorId, agentId) {
      const { res, rec } = fakeRes();
      await route('/api/connectors/oauth/status')(
        fakeReq(user, { query: { connectorId, ...(agentId ? { agentId } : {}) } }),
        res,
      );
      return { status: rec.status, json: rec.json };
    },
    async resolve(user, agentId) {
      try {
        const token = await h.bus.call<{ ref: string; userId: string }, string>(
          'credentials:get',
          h.ctx({ agentId, userId: user }),
          { ref: 'account:conn-1', userId: user },
        );
        return { ok: true, token };
      } catch (e) {
        const err = e as { code?: string; message: string; cause?: { name?: string } };
        return {
          ok: false,
          ...(err.code ? { code: err.code } : {}),
          ...(err.cause?.name ? { causeName: err.cause.name } : {}),
          msg: err.message,
        };
      }
    },
    async clientRows() {
      return db
        .selectFrom('mcp_oauth_v1_clients')
        .select(['client_key', 'client_id', 'client_secret'])
        .execute();
    },
    async pendingStates() {
      const rows = await db.selectFrom('mcp_oauth_v1_pending').select(['state']).execute();
      return rows.map((r) => r.state);
    },
  };
  return stack;
}

/** Only the refresh_token grants the AS saw from index `from` onward. */
const refreshGrants = (from = 0): Grant[] =>
  fas.grants.slice(from).filter((g) => g.grant === 'refresh_token');

/** 'ok', or why the resolve failed -- so a red run says what the AS refused, not just `false`. */
const outcome = (r: ResolveResult): string =>
  r.ok ? 'ok' : `failed (${r.causeName ?? r.code ?? 'error'}): ${r.msg}`;

const SUCCESS = expect.stringContaining('oauth=success');

describe('challenge-only OAuth discovery through the production plugin', () => {
  it('discovers, authorizes, stores and refreshes a token without well-known resource metadata', async () => {
    const s = await boot({ visibility: 'personal', scopes: [], asOpts: { challengeOnly: true } });
    const begun = await s.begin('alice', { connectorId: 'conn-1' });
    expect(begun.status).toBe(200);
    expect(new URL(begun.authorizationUrl!).searchParams.get('scope')).toBe('resource.read');
    const { code, state } = fas.authorize(begun.authorizationUrl!);
    expect(await s.callback('alice', code, state)).toEqual(SUCCESS);
    const resolved = await s.resolve('alice', 'agent-A');
    expect(outcome(resolved)).toBe('ok');
    expect(refreshGrants()).toHaveLength(1);
    expect(await s.status('alice', 'conn-1')).toEqual({ status: 200, json: { status: 'connected' } });
  });
});

// ---------------------------------------------------------------------------
// The bug: two agents on one connector.
// ---------------------------------------------------------------------------
describe('two agents connect the same connector (strict RFC 6749 authorization server)', () => {
  it('team agents A then B: both keep refreshing, each as the client its own token was issued to', async () => {
    const s = await boot({ visibility: 'team' });
    const a = await s.connect('alice', 'conn-1', 'agent-A');
    expect(a.redirect).toEqual(SUCCESS);
    // Precondition (holds with or without the fix): A alone is healthy.
    expect(outcome(await s.resolve('alice', 'agent-A'))).toBe('ok');

    const b = await s.connect('alice', 'conn-1', 'agent-B');
    expect(b.redirect).toEqual(SUCCESS);
    expect(b.clientId, 'each begin registers its own client').not.toBe(a.clientId);

    const mark = fas.grants.length;
    expect(outcome(await s.resolve('alice', 'agent-A')), 'agent-A after agent-B connected').toBe('ok');
    expect(outcome(await s.resolve('alice', 'agent-B')), 'agent-B after agent-B connected').toBe('ok');

    // The AS saw A refresh as A's client and B refresh as B's client -- not both as "the last one".
    expect(refreshGrants(mark).map((g) => [g.clientId, g.outcome])).toEqual([
      [a.clientId, 'ok'],
      [b.clientId, 'ok'],
    ]);
  });

  it('confidential clients: A survives B connecting (the client secret travels with the token)', async () => {
    const s = await boot({ visibility: 'team', asOpts: { issueSecret: true } });
    const a = await s.connect('alice', 'conn-1', 'agent-A');
    expect(a.redirect).toEqual(SUCCESS);
    expect(outcome(await s.resolve('alice', 'agent-A'))).toBe('ok'); // precondition
    const b = await s.connect('alice', 'conn-1', 'agent-B');
    expect(b.redirect).toEqual(SUCCESS);

    const mark = fas.grants.length;
    expect(outcome(await s.resolve('alice', 'agent-A')), 'agent-A after agent-B connected').toBe('ok');
    expect(outcome(await s.resolve('alice', 'agent-B')), 'agent-B after agent-B connected').toBe('ok');
    // 'ok' (not 'invalid_client') proves each refresh also presented its own client's secret.
    expect(refreshGrants(mark).map((g) => [g.clientId, g.outcome])).toEqual([
      [a.clientId, 'ok'],
      [b.clientId, 'ok'],
    ]);
  });

  it('two users, each with a personal connector of the same id: both stay connected', async () => {
    // Connectors are keyed (owner, slug), so alice and bob can both have `conn-1`. The shared
    // client row key `conn-1|<AS>` knew nothing about the owner. No agentId => user-scope tokens.
    const s = await boot({ visibility: 'personal' });
    const alice = await s.connect('alice', 'conn-1');
    expect(alice.redirect).toEqual(SUCCESS);
    expect(outcome(await s.resolve('alice', ''))).toBe('ok'); // precondition
    const bob = await s.connect('bob', 'conn-1');
    expect(bob.redirect).toEqual(SUCCESS);

    const mark = fas.grants.length;
    expect(outcome(await s.resolve('alice', '')), 'alice after bob connected').toBe('ok');
    expect(outcome(await s.resolve('bob', '')), 'bob after bob connected').toBe('ok');
    expect(refreshGrants(mark).map((g) => [g.clientId, g.outcome])).toEqual([
      [alice.clientId, 'ok'],
      [bob.clientId, 'ok'],
    ]);
  });

  it('the "Connect" card race (begin A, begin B, THEN callbacks): both authorization codes redeem', async () => {
    const s = await boot({ visibility: 'team' });
    const bA = await s.begin('alice', { connectorId: 'conn-1', agentId: 'agent-A' });
    const bB = await s.begin('alice', { connectorId: 'conn-1', agentId: 'agent-B' });
    const a = fas.authorize(bA.authorizationUrl!);
    const b = fas.authorize(bB.authorizationUrl!);

    // Sequential callbacks. Before the fix, A's redeem used the client B's begin registered
    // last, so the AS refused A's code (issued to A's own client).
    expect(await s.callback('alice', a.code, a.state), 'agent-A callback').toEqual(SUCCESS);
    expect(await s.callback('alice', b.code, b.state), 'agent-B callback').toEqual(SUCCESS);

    expect(outcome(await s.resolve('alice', 'agent-A'))).toBe('ok');
    expect(outcome(await s.resolve('alice', 'agent-B'))).toBe('ok');
  });

  it('truly concurrent begins and callbacks: both succeed and both agents resolve', async () => {
    // A's DCR response is delayed, so A registers first but its registration LANDS last.
    const s = await boot({ visibility: 'team', asOpts: { registerDelayMsByCall: [60, 0] } });
    const [bA, bB] = await Promise.all([
      s.begin('alice', { connectorId: 'conn-1', agentId: 'agent-A' }),
      s.begin('alice', { connectorId: 'conn-1', agentId: 'agent-B' }),
    ]);
    expect(bA.status).toBe(200);
    expect(bB.status).toBe(200);
    const a = fas.authorize(bA.authorizationUrl!);
    const b = fas.authorize(bB.authorizationUrl!);

    const redirects = await Promise.all([
      s.callback('alice', a.code, a.state),
      s.callback('alice', b.code, b.state),
    ]);
    expect(redirects).toEqual([SUCCESS, SUCCESS]);

    const mark = fas.grants.length;
    expect(outcome(await s.resolve('alice', 'agent-A'))).toBe('ok');
    expect(outcome(await s.resolve('alice', 'agent-B'))).toBe('ok');
    expect(refreshGrants(mark).map((g) => g.clientId)).toEqual([
      clientIdOf(bA.authorizationUrl!),
      clientIdOf(bB.authorizationUrl!),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Controls: behaviour that must be identical before and after the fix.
// ---------------------------------------------------------------------------
describe('[CONTROL] shapes that never depended on the per-token client', () => {
  it('[CONTROL] two PERSONAL agents of one user share one user-scope token; both resolve', async () => {
    const s = await boot({ visibility: 'personal' });
    await s.connect('alice', 'conn-1', 'agent-A');
    await s.connect('alice', 'conn-1', 'agent-B'); // overwrites the user-scope token; no orphan
    expect(outcome(await s.resolve('alice', 'agent-A'))).toBe('ok');
    expect(outcome(await s.resolve('alice', 'agent-B'))).toBe('ok');
  });

  it('[CONTROL] the same agent reconnecting replaces its own token; it resolves and reports connected', async () => {
    const s = await boot({ visibility: 'team' });
    expect((await s.connect('alice', 'conn-1', 'agent-A')).redirect).toEqual(SUCCESS);
    expect((await s.connect('alice', 'conn-1', 'agent-A')).redirect).toEqual(SUCCESS);
    expect(outcome(await s.resolve('alice', 'agent-A'))).toBe('ok');
    expect(await s.status('alice', 'conn-1', 'agent-A')).toEqual({ status: 200, json: { status: 'connected' } });
  });

  it('[CONTROL] a lenient AS (refresh tokens not bound to a client): A survives B connecting', async () => {
    const s = await boot({ visibility: 'team', asOpts: { bindRefreshToClient: false } });
    await s.connect('alice', 'conn-1', 'agent-A');
    await s.connect('alice', 'conn-1', 'agent-B');
    expect(outcome(await s.resolve('alice', 'agent-A'))).toBe('ok');
    expect(outcome(await s.resolve('alice', 'agent-B'))).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Back-compat: tokens written before this change carry no clientId/clientSecret.
// ---------------------------------------------------------------------------
describe('legacy token blobs (no clientId/clientSecret, only clientKey)', () => {
  /**
   * Seed exactly what the old callback wrote: an `mcp-oauth` credential whose blob names only
   * `clientKey`, plus the shared client row that key points at. The refresh token belongs to a
   * client registered on the fake AS, so a refresh with any OTHER client is refused. The blob is
   * built by hand (not via encodeTokenBlob) so it stays legacy-shaped whatever the schema becomes.
   */
  async function seedLegacyToken(s: Stack, confidential: boolean) {
    const secret = confidential ? 'legacy-client-secret' : undefined;
    fas.clients.set('legacy-client', { ...(secret ? { secret } : {}), redirectUris: [REDIRECT] });
    fas.refreshTokens.set('legacy-rt', { clientId: 'legacy-client' });
    await s.db
      .insertInto('mcp_oauth_v1_clients')
      .values({
        client_key: SHARED_CLIENT_KEY,
        client_id: 'legacy-client',
        client_secret: secret ?? null,
        dynamic: true,
        created_at: new Date(),
      })
      .execute();
    const expiresAt = Date.now() + 60_000; // inside the 5-minute refresh margin => refresh on read
    const blob = {
      accessToken: 'legacy-access-token',
      refreshToken: 'legacy-rt',
      tokenType: 'Bearer',
      expiresAt,
      resource: RS,
      authServerUrl: AS,
      tokenEndpoint: `${AS}/token`,
      clientKey: SHARED_CLIENT_KEY,
    };
    expect(blob).not.toHaveProperty('clientId');
    await s.h.bus.call('credentials:set', s.h.ctx({ userId: 'alice' }), {
      scope: 'agent',
      ownerId: 'agent-legacy',
      ref: 'account:conn-1',
      kind: 'mcp-oauth',
      payload: new TextEncoder().encode(JSON.stringify(blob)),
      expiresAt,
    });
  }

  it.each([
    { label: 'public client', confidential: false },
    { label: 'confidential client', confidential: true },
  ])('[CONTROL] a legacy token ($label) still refreshes through the shared client row', async ({ confidential }) => {
    const s = await boot({ visibility: 'team' });
    await seedLegacyToken(s, confidential);
    expect(outcome(await s.resolve('alice', 'agent-legacy'))).toBe('ok');
    expect(refreshGrants().map((g) => [g.clientId, g.refreshToken, g.outcome])).toEqual([
      ['legacy-client', 'legacy-rt', 'ok'],
    ]);
  });

  it.each([
    { label: 'public client', confidential: false },
    { label: 'confidential client', confidential: true },
  ])('a new connect for another agent does not disturb a legacy token ($label)', async ({ confidential }) => {
    const s = await boot({ visibility: 'team', asOpts: { issueSecret: confidential } });
    await seedLegacyToken(s, confidential);

    // Another agent connects the same connector: registers its own client, gets its own token.
    const b = await s.connect('alice', 'conn-1', 'agent-B');
    expect(b.redirect).toEqual(SUCCESS);

    const mark = fas.grants.length;
    expect(outcome(await s.resolve('alice', 'agent-legacy')), 'legacy agent after agent-B connected').toBe('ok');
    expect(outcome(await s.resolve('alice', 'agent-B'))).toBe('ok');
    expect(refreshGrants(mark).map((g) => [g.clientId, g.outcome])).toEqual([
      ['legacy-client', 'ok'],
      [b.clientId, 'ok'],
    ]);

    // The row the legacy token falls back to is exactly as it was seeded. Before the fix, B's
    // begin upserted its own client over it.
    const legacyRow = (await s.clientRows()).find((r) => r.client_key === SHARED_CLIENT_KEY);
    expect(legacyRow, 'shared client row after agent-B connected').toMatchObject({ client_id: 'legacy-client' });
  });
});

// ---------------------------------------------------------------------------
// A dead refresh token must read as needs-reconnect; a flaky AS must not.
// ---------------------------------------------------------------------------
describe('/status after a refresh failure', () => {
  const REVOKED_DESCRIPTIONS = [
    {
      label: 'a description that never says the error code',
      errorDescription: 'The provided refresh token is invalid, expired, or was issued to another client.',
    },
    { label: 'no description at all', errorDescription: undefined },
  ];

  it.each(REVOKED_DESCRIPTIONS)(
    'a revoked refresh token (invalid_grant with $label) reports needs-reconnect, not a 500',
    async ({ errorDescription }) => {
      const s = await boot({ visibility: 'team', asOpts: { errorDescription } });
      expect((await s.connect('alice', 'conn-1', 'agent-A')).redirect).toEqual(SUCCESS);
      fas.refreshTokens.clear(); // the user revoked the grant at the provider

      expect(await s.status('alice', 'conn-1', 'agent-A')).toEqual({
        status: 200,
        json: { status: 'needs-reconnect' },
      });
      expect(await s.resolve('alice', 'agent-A')).toMatchObject({ ok: false, causeName: 'NeedsReconnectError' });
    },
  );

  /** Two transient failures, then success: /status and a direct resolve each eat one. */
  async function runTransientFailure(errorDescription: string) {
    const s = await boot({ visibility: 'team' });
    expect((await s.connect('alice', 'conn-1', 'agent-A')).redirect).toEqual(SUCCESS);
    const issuedRefreshToken = [...fas.refreshTokens.keys()][0]!;
    const mark = fas.grants.length;
    fas.failNextRefresh({ error: 'server_error', error_description: errorDescription });
    fas.failNextRefresh({ error: 'server_error', error_description: errorDescription });

    const status = await s.status('alice', 'conn-1', 'agent-A');
    expect(status.json).not.toEqual({ status: 'needs-reconnect' });
    expect(status.json).not.toEqual({ status: 'connected' });

    const failed = await s.resolve('alice', 'agent-A');
    expect(failed.ok).toBe(false);
    expect(failed).not.toMatchObject({ causeName: 'NeedsReconnectError' });

    // Nothing was wiped: the very same refresh token still works once the AS recovers.
    expect(outcome(await s.resolve('alice', 'agent-A'))).toBe('ok');
    expect(refreshGrants(mark).map((g) => [g.refreshToken, g.outcome])).toEqual([
      [issuedRefreshToken, 'server_error'],
      [issuedRefreshToken, 'server_error'],
      [issuedRefreshToken, 'ok'],
    ]);
  }

  it('[CONTROL] a transient AS failure is not needs-reconnect and leaves the stored token usable', async () => {
    await runTransientFailure('temporarily_unavailable, try again');
  });

  it('a transient failure whose text merely mentions "invalid_grant" is still not needs-reconnect', async () => {
    // Only the AS's error CODE means the grant is dead; prose in a 500's description does not.
    await runTransientFailure('upstream said invalid_grant while its database was failing over');
  });
});

// ---------------------------------------------------------------------------
// Pending-authorization hygiene.
// ---------------------------------------------------------------------------
describe('pending authorizations', () => {
  async function insertPending(s: Stack, state: string, createdAtMs: number) {
    // Raw SQL naming only the original columns: whatever else a pending row carries defaults.
    await sql`
      INSERT INTO mcp_oauth_v1_pending
        (state, user_id, agent_id, connector_id, slot, code_verifier, auth_server_url,
         client_key, resource, scope, cred_scope, created_at)
      VALUES
        (${state}, 'alice', 'agent-A', 'conn-1', 'oauth-main', 'verifier-not-a-secret', ${AS},
         ${SHARED_CLIENT_KEY}, ${RS}, 'read', 'agent', ${new Date(createdAtMs)})
    `.execute(s.db);
  }

  it('begin purges expired, never-consumed pending rows and keeps in-flight ones', async () => {
    const s = await boot({ visibility: 'team' });
    const now = Date.now();
    await insertPending(s, 'stale-abandoned-state', now - 60 * 60_000); // 1h old, TTL is 10 min
    await insertPending(s, 'inflight-state', now - 60_000); // 1 min old, still redeemable
    expect((await s.pendingStates()).sort()).toEqual(['inflight-state', 'stale-abandoned-state']);

    const b = await s.begin('alice', { connectorId: 'conn-1', agentId: 'agent-B' });
    expect(b.status).toBe(200);
    const fresh = new URL(b.authorizationUrl!).searchParams.get('state')!;

    expect((await s.pendingStates()).sort()).toEqual(['inflight-state', fresh].sort());
  });
});

// ---------------------------------------------------------------------------
// Secrets stay out of the logs.
// ---------------------------------------------------------------------------
describe('logging', () => {
  it('[CONTROL] a confidential connect, a failed redeem and a refresh never log a secret', async () => {
    // The routes log through `initCtx.logger`, which writes JSON lines to process.stdout. Capture
    // every byte the process writes to stdout/stderr/console while the flow runs.
    const captured: string[] = [];
    const capture = (chunk: unknown): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return true;
    };
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        }),
      ),
    ];
    try {
      // The AS echoes code/verifier/secret/refresh-token into its invalid_grant descriptions, so
      // any code path that logs a provider error message would leak all four.
      const s = await boot({ visibility: 'team', asOpts: { issueSecret: true, echoSecretsInErrors: true } });
      expect((await s.connect('alice', 'conn-1', 'agent-A')).redirect).toEqual(SUCCESS);
      expect(outcome(await s.resolve('alice', 'agent-A'))).toBe('ok'); // refresh with a secret

      // Agent B's authorization code is consumed at the AS before the callback arrives => the
      // redeem is refused with invalid_grant.
      const bB = await s.begin('alice', { connectorId: 'conn-1', agentId: 'agent-B' });
      const b = fas.authorize(bB.authorizationUrl!);
      fas.codes.delete(b.code);
      expect(await s.callback('alice', b.code, b.state)).toContain('oauth=error');

      const logged = captured.join('\n');
      // Not vacuous: the redeem failure really was logged through the captured writer...
      expect(logged).toContain('mcp_oauth_redeem_failed');
      // ...and the AS really was holding every kind of secret we say is absent.
      const kinds = new Set(fas.sensitive.values());
      for (const kind of [
        'client secret',
        'authorization code',
        'code verifier',
        'access token',
        'refresh token',
      ]) {
        expect(kinds, `fake AS minted a ${kind}`).toContain(kind);
      }
      for (const [value, kind] of fas.sensitive) {
        expect(logged.includes(value), `${kind} appeared in the logs`).toBe(false);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
