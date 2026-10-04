import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import type { ServiceHandler } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createConnectorsPlugin } from '@ax/connectors';
import type { Kysely } from 'kysely';
import { createMcpOAuthPlugin } from '../plugin.js';
import { createMcpOAuthStore } from '../store.js';
import type { McpOAuthDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// REGRESSION (TASK-797): an admin's SHARED custom-client OAuth connector must be
// signable by everyone, not only its author.
//
// The bug: `begin` reads the connector's `clientSecretRef` with `credentials:get`
// as the person signing in. The connector editor stored that secret at the AUTHOR's
// user scope, so for anyone else the read missed and `begin` answered
// `400 oauth_client_secret_unavailable`. Nobody but the admin who set the connector
// up could ever connect it.
//
// The fix has two halves, and this file drives both through the real thing:
//   - the admin's SHARED connector stores the secret at GLOBAL scope under
//     `account:<id>:OAUTH_CLIENT_SECRET`, and @ax/connectors'
//     `credentials:authorize-global:account` provider lets the vault hand that one
//     global row to anybody who resolves the connector, but ONLY when the connector
//     is the sole shared definition, an oauth slot names exactly that ref, the ref
//     is not a plan slot, and the owner is (still) an admin;
//   - `begin` reads the secret with a ctx whose agentId is '' (user -> global, no
//     agent step). The old placeholder agentId `'@ax/mcp-oauth'` made the vault's
//     agent step THROW on the ownerId grammar for a shared connector, before the
//     walk ever reached global.
//
// Everything real except the network edge: the real @ax/connectors plugin
// (`connectors:upsert` / `connectors:get` and both authorize providers), the real
// vault (@ax/credentials + its DB blob store), the real mcp-oauth route handlers
// driving the real MCP SDK, all on a Postgres testcontainer. Stubbed: the session
// (`auth:require-user` / `auth:get-user`, a mutable users map), `http:register-route`
// (handlers are captured), `globalThis.fetch` for `*.example.test` (an in-process
// authorization server that RECORDS every request), and DNS for the same hosts (so
// the SSRF guard sees a public address).
// ---------------------------------------------------------------------------

vi.mock('node:dns/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:dns/promises')>();
  const lookup = async (h: string, ...rest: unknown[]) =>
    h === 'example.test' || h.endsWith('.example.test')
      ? { address: '93.184.216.34', family: 4 }
      : (orig.lookup as (...a: unknown[]) => unknown)(h, ...rest);
  return { ...orig, lookup, default: { ...(orig as { default?: object }).default, lookup } };
});

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const APP = 'https://app.example.com';
const AS = 'https://auth.example.test';
const RS = 'https://mcp.example.test';

const ADMIN_SECRET = 'ADMIN-GLOBAL-CLIENT-SECRET';
const SECRET_REF = 'account:gmail:OAUTH_CLIENT_SECRET';

type Actor = { id: string; isAdmin: boolean };
const ROOT: Actor = { id: 'root', isAdmin: true }; // admin: authors the connector
const BOB: Actor = { id: 'bob', isAdmin: false }; // non-admin author
const ALICE: Actor = { id: 'alice', isAdmin: false }; // non-admin signer

// ---------------------------------------------------------------------------
// Recording authorization server.
// ---------------------------------------------------------------------------
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
let seen: Seen[] = [];
const realFetch = globalThis.fetch;

function asFetch(input: string | URL, init?: RequestInit): Response {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach(
    (v, k) => (headers[k] = v),
  );
  seen.push({
    method,
    url: url.toString(),
    headers,
    body: init?.body === undefined ? '' : String(init.body),
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
    return json(200, {
      issuer: AS,
      authorization_endpoint: `${AS}/authorize`,
      token_endpoint: `${AS}/token`,
      registration_endpoint: `${AS}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    });
  }
  return json(404, { error: 'not_found' });
}

/** Does the admin secret appear anywhere in a request any host received, including
 *  inside a Basic-auth header (base64 of `id:secret`)? `begin` never calls the token
 *  endpoint, so the answer must be no, in every case. */
function secretLeaked(): boolean {
  return seen.some((r) => {
    const auth = r.headers['authorization'];
    const decoded = auth?.startsWith('Basic ')
      ? decodeURIComponent(Buffer.from(auth.slice(6), 'base64').toString())
      : '';
    return JSON.stringify(r).includes(ADMIN_SECRET) || decoded.includes(ADMIN_SECRET);
  });
}

// ---------------------------------------------------------------------------
// Stack.
// ---------------------------------------------------------------------------
type Handler = (req: unknown, res: unknown) => Promise<void>;
let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

let savedKey: string | undefined;
beforeEach(() => {
  seen = [];
  savedKey = process.env.AX_CREDENTIALS_KEY;
  process.env.AX_CREDENTIALS_KEY = KEY;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    for (const t of [
      'mcp_oauth_v1_clients',
      'mcp_oauth_v1_pending',
      'connectors_v1_connectors',
      'connectors_v1_authored',
      'storage_postgres_v1_kv',
    ]) {
      await cleanup.query(`DROP TABLE IF EXISTS ${t}`);
    }
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
  const rec: { status: number; json?: { authorizationUrl?: string; error?: string } } = {
    status: 200,
  };
  const res = {
    status(n: number) {
      rec.status = n;
      return res;
    },
    header() {
      return res;
    },
    json(v: unknown) {
      rec.json = v as { authorizationUrl?: string; error?: string };
    },
    text() {},
    redirect() {},
    end() {},
  };
  return { res, rec };
}
function fakeReq(user: string, body: unknown) {
  return {
    headers: { 'x-user': user },
    body: Buffer.from(JSON.stringify(body)),
    cookies: {},
    query: {},
    params: {},
    signedCookie: () => null,
  };
}

/** The OAuth slot an admin sets up for a custom (pre-registered) client. */
function gmailCapabilities() {
  return {
    allowedHosts: ['auth.example.test', 'mcp.example.test'],
    credentials: [
      {
        slot: 'oauth-main',
        kind: 'oauth' as const,
        server: 'srv',
        scopes: ['read'],
        clientId: 'admin-client',
        clientRegistration: 'custom' as const,
        clientSecretRef: SECRET_REF,
        authServerUrl: AS,
      },
    ],
    mcpServers: [
      {
        name: 'srv',
        transport: 'http' as const,
        url: RS,
        allowedHosts: ['mcp.example.test'],
        credentials: [],
      },
    ],
    packages: { npm: [], pypi: [] },
  };
}

async function boot() {
  const routes = new Map<string, Handler>();
  const users = new Map<string, Actor>([ROOT, BOB, ALICE].map((a) => [a.id, { ...a }]));
  const services: Record<string, ServiceHandler> = {
    'http:register-route': (async (_c, input) => {
      const r = input as { method: string; path: string; handler: Handler };
      routes.set(`${r.method} ${r.path}`, r.handler);
      return { unregister: () => {} };
    }) as ServiceHandler,
    // The session comes from the x-user header; the role from the users map, so a
    // test can change it between requests.
    'auth:require-user': (async (_c, input) => {
      const id = (input as { req: { headers: Record<string, string> } }).req.headers['x-user']!;
      return { user: { ...(users.get(id) ?? { id, isAdmin: false }) } };
    }) as ServiceHandler,
    // What @ax/connectors asks to prove a connector's OWNER is an admin.
    'auth:get-user': (async (_c, input) =>
      users.get((input as { userId: string }).userId) ?? null) as ServiceHandler,
    // Declared by @ax/mcp-oauth for the team-agent path; these sign-ins carry no agentId.
    'agents:resolve': (async () => {
      throw new Error('agents:resolve must not be called: no agentId is sent');
    }) as ServiceHandler,
  };
  globalThis.fetch = ((i: string | URL, init?: RequestInit) => {
    const host = new URL(typeof i === 'string' ? i : i.toString()).host;
    if (host === 'example.test' || host.endsWith('.example.test')) {
      return Promise.resolve(asFetch(i, init));
    }
    // Anything else leaving the box is recorded and refused: the test must never
    // depend on the real network.
    seen.push({ method: (init?.method ?? 'GET').toUpperCase(), url: String(i), headers: {}, body: '<<UNEXPECTED HOST>>' });
    return Promise.reject(new Error(`unexpected outbound request to ${host}`));
  }) as typeof fetch;

  const h = await createTestHarness({
    services,
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createStoragePostgresPlugin(),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      // The REAL connectors plugin: `connectors:get` for `begin`, plus the two
      // `credentials:authorize-*:account` providers the vault consults.
      createConnectorsPlugin(),
      createMcpOAuthPlugin({ mountRoutes: true, publicOrigin: APP }),
    ],
  });
  harnesses.push(h);

  const begin = routes.get('POST /api/connectors/oauth/begin');
  if (!begin) throw new Error('begin route not registered');

  /** Author a custom-client OAuth connector the way the editor's save does. */
  const author = (
    owner: Actor,
    visibility: 'shared' | 'private',
    connectorId = 'gmail',
  ) =>
    h.bus.call('connectors:upsert', h.ctx({ userId: owner.id }), {
      userId: owner.id,
      connectorId,
      name: 'Gmail',
      keyMode: 'personal',
      visibility,
      capabilities: gmailCapabilities(),
    });

  /** An admin's shared connector keeps the client secret at GLOBAL scope. */
  const putGlobalSecret = (ref: string, value: string) =>
    h.bus.call('credentials:set', h.ctx({ userId: ROOT.id }), {
      scope: 'global',
      ownerId: null,
      ref,
      kind: 'api-key',
      payload: new TextEncoder().encode(value),
    });

  const signIn = async (who: Actor, connectorId = 'gmail') => {
    const r = fakeRes();
    await begin(fakeReq(who.id, { connectorId }), r.res);
    return r.rec;
  };

  /** The row `begin` stored for an authorization it started. */
  const pendingRow = async (authorizationUrl: string) => {
    const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    return createMcpOAuthStore(db).getPending(state);
  };

  return { h, users, author, putGlobalSecret, signIn, pendingRow };
}

// ---------------------------------------------------------------------------
describe('an admin’s shared custom-client connector is signable by everyone (TASK-797)', () => {
  it('[the regression] a non-admin signs in to the admin’s shared connector; the admin’s global client secret is used', async () => {
    // UNFIXED: FAILS with 400 oauth_client_secret_unavailable (the secret sat at the
    // author's user scope, and `begin`'s placeholder agentId broke the walk to global).
    const s = await boot();
    await s.author(ROOT, 'shared');
    await s.putGlobalSecret(SECRET_REF, ADMIN_SECRET);

    const out = await s.signIn(ALICE);

    expect(out.status).toBe(200);
    expect(out.json?.error).toBeUndefined();
    const url = new URL(out.json!.authorizationUrl!);
    expect(url.origin).toBe(AS);
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('client_id')).toBe('admin-client');

    // The secret really came from the vault: it is on the pending row `begin`
    // stored, for the callback to redeem with. It is NOT in the URL, and `begin`
    // sent it nowhere.
    const pending = await s.pendingRow(out.json!.authorizationUrl!);
    expect(pending).toMatchObject({
      userId: 'alice',
      connectorId: 'gmail',
      clientId: 'admin-client',
      clientSecret: ADMIN_SECRET,
    });
    expect(out.json!.authorizationUrl).not.toContain(ADMIN_SECRET);
    expect(seen.some((r) => r.url.startsWith(`${AS}/.well-known/`))).toBe(true); // control: the AS was really driven
    expect(secretLeaked()).toBe(false);
  });

  it('the admin signs in to their own shared connector too (global secret, no user-scope copy)', async () => {
    const s = await boot();
    await s.author(ROOT, 'shared');
    await s.putGlobalSecret(SECRET_REF, ADMIN_SECRET);

    const out = await s.signIn(ROOT);

    expect(out.status).toBe(200);
    expect(new URL(out.json!.authorizationUrl!).searchParams.get('client_id')).toBe('admin-client');
    expect((await s.pendingRow(out.json!.authorizationUrl!))?.clientSecret).toBe(ADMIN_SECRET);
    expect(secretLeaked()).toBe(false);
  });

  it('a NON-admin owner’s shared connector does not hand anyone the global secret: 400 oauth_client_secret_unavailable', async () => {
    // The row is what a non-admin can end up with (legacy data, an un-gated write
    // path). The role is checked at read time, so the global row stays closed.
    const s = await boot();
    await s.author(BOB, 'shared');
    await s.putGlobalSecret(SECRET_REF, ADMIN_SECRET);

    const out = await s.signIn(ALICE);

    expect(out.status).toBe(400);
    expect(out.json).toEqual({ error: 'oauth_client_secret_unavailable' });
    expect(secretLeaked()).toBe(false);
  });

  it('demoting the admin closes the global secret again, at once', async () => {
    const s = await boot();
    await s.author(ROOT, 'shared');
    await s.putGlobalSecret(SECRET_REF, ADMIN_SECRET);
    expect((await s.signIn(ALICE)).status).toBe(200);

    s.users.set(ROOT.id, { id: ROOT.id, isAdmin: false });

    const out = await s.signIn(ALICE);
    expect(out.status).toBe(400);
    expect(out.json).toEqual({ error: 'oauth_client_secret_unavailable' });
    expect(secretLeaked()).toBe(false);
  });

  it('a PRIVATE admin connector is invisible to a non-admin: 404 not-found, and the secret goes nowhere', async () => {
    const s = await boot();
    await s.author(ROOT, 'private');
    await s.putGlobalSecret(SECRET_REF, ADMIN_SECRET);

    const out = await s.signIn(ALICE);

    expect(out.status).toBe(404);
    expect(out.json).toEqual({ error: 'not-found' });
    expect(seen).toEqual([]); // not even a discovery request
    expect(secretLeaked()).toBe(false);
  });

  it('a private connector of the signer’s own, named like the admin’s shared one, does not borrow the global secret', async () => {
    // alice's own definition shadows the shared one for her id lookup, so it is not
    // "the sole shared definition she resolves": the global row stays closed.
    const s = await boot();
    await s.author(ROOT, 'shared');
    await s.author(ALICE, 'private');
    await s.putGlobalSecret(SECRET_REF, ADMIN_SECRET);

    const out = await s.signIn(ALICE);

    expect(out.status).toBe(400);
    expect(out.json).toEqual({ error: 'oauth_client_secret_unavailable' });
    expect(secretLeaked()).toBe(false);
  });
});
