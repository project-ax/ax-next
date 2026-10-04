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
import type { Kysely } from 'kysely';
import { createMcpOAuthPlugin } from '../plugin.js';
import { createMcpOAuthStore } from '../store.js';
import { createMcpOAuthRouteHandlers } from '../routes.js';
import { discover, ensureClient, buildAuthorization, redeemCode } from '../oauth-flow.js';
import type { McpOAuthDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// REGRESSION (TASK-712): a connector's OAuth `clientSecretRef` must not be a way to
// read a credential the author does not own.
//
// The hole: `clientSecretRef` is a free string on a connector ANY signed-in user can
// author, and `begin` resolves it with `credentials:get` and posts the value (HTTP
// Basic) to the `token_endpoint` of an authorization server the same author picked.
// `provider:anthropic` (the operator's model key) or an env-fallback name would go
// straight to a host the author controls. On main it did not, by accident: `begin`
// builds its ctx with the placeholder agentId `'@ax/mcp-oauth'`, whose `/` fails the
// vault's `ownerId` grammar, so `credentials:get` throws at the agent-scope step
// before it reaches global scope or the env fallback.
//
// Everything real except the network edge: the real plugin (begin / callback), the
// real oauth-flow driving the real MCP SDK, the real vault (@ax/credentials + its
// DB blob store, envFallback wired as the k8s preset wires it), all on a Postgres
// testcontainer. Faked: `globalThis.fetch` for `*.attacker.example` (an in-process
// authorization server that RECORDS every request it is sent), DNS for the same
// hosts (so the SSRF guard sees a public address), and `connectors:get` (returns the
// connector the test declares -- @ax/connectors is a different plugin, and its
// authoring-time half of this rule is tested in its own package).
//
// The row a test hands `begin` is exactly what a connector stored BEFORE the
// authoring check existed looks like, which is why `begin` has to refuse it itself.
//
// The counterfactual tests run the SAME handlers with the bus wrapped so the
// placeholder agentId is replaced by "" / a real agent id, i.e. with the accident
// removed. They are the ones that fail if `begin` stops checking the ref itself.
// ---------------------------------------------------------------------------

vi.mock('node:dns/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:dns/promises')>();
  const lookup = async (h: string, ...rest: unknown[]) =>
    h === 'attacker.example' || h.endsWith('.attacker.example')
      ? { address: '93.184.216.34', family: 4 }
      : (orig.lookup as (...a: unknown[]) => unknown)(h, ...rest);
  return { ...orig, lookup, default: { ...(orig as { default?: object }).default, lookup } };
});

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const APP = 'https://app.example.com';
const AS = 'https://attacker.example';
const RS = 'https://mcp.attacker.example';

const OPERATOR_MODEL_KEY = 'OPERATOR-MODEL-KEY'; // global  provider:anthropic
const OPERATOR_PROBE_KEY = 'OPERATOR-PROBE-PROVIDER-KEY'; // global  provider:probe
const OPERATOR_ACCOUNT_KEY = 'OPERATOR-ACCOUNT-KEY'; // global  account:opskey
const OPERATOR_OWN_FORM_KEY = 'OPERATOR-OWN-FORM-KEY'; // global  account:cf-global:oauth-client-secret
const ENV_KEY = 'OPERATOR-ENV-FALLBACK-KEY'; // envFallback 'anthropic-api'
const MALLORY_OWN = 'MALLORY-OWN-USER-SCOPE-SECRET'; // user     account:mal-own:oauth-client-secret
const AGENT_TOKEN = 'TEAM-AGENT-OAUTH-TOKEN'; // agent    account:cf-agent (a teammate's connector token)

const ALL_SECRETS = [
  OPERATOR_MODEL_KEY,
  OPERATOR_PROBE_KEY,
  OPERATOR_ACCOUNT_KEY,
  OPERATOR_OWN_FORM_KEY,
  ENV_KEY,
  AGENT_TOKEN,
];

// ---------------------------------------------------------------------------
// Recording attacker authorization server.
// ---------------------------------------------------------------------------
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
let seen: Seen[] = [];
const realFetch = globalThis.fetch;

function attackerFetch(input: string | URL, init?: RequestInit): Response {
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
      // the attacker advertises BOTH secret-carrying client auth methods
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    });
  }
  if (url.pathname === '/token' && method === 'POST') {
    return json(200, { access_token: 'attacker-issued-at', token_type: 'Bearer', expires_in: 3600 });
  }
  return json(404, { error: 'not_found' });
}

/** Every secret above that appears anywhere in a request the attacker's host received,
 *  including inside the Basic-auth header (base64 of `id:secret`). */
function leakedSecrets(): string[] {
  const out: string[] = [];
  for (const s of ALL_SECRETS.concat(MALLORY_OWN)) {
    const hit = seen.some((r) => {
      const dec = r.headers['authorization']?.startsWith('Basic ')
        ? decodeURIComponent(Buffer.from(r.headers['authorization'].slice(6), 'base64').toString())
        : '';
      return JSON.stringify(r).includes(s) || dec.includes(s);
    });
    if (hit) out.push(s);
  }
  return out;
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
let savedEnv: string | undefined;
beforeEach(() => {
  seen = [];
  savedKey = process.env.AX_CREDENTIALS_KEY;
  savedEnv = process.env.PROBE_ANTHROPIC_ENV;
  process.env.AX_CREDENTIALS_KEY = KEY;
  process.env.PROBE_ANTHROPIC_ENV = ENV_KEY;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    for (const t of ['mcp_oauth_v1_clients', 'mcp_oauth_v1_pending', 'storage_postgres_v1_kv']) {
      await cleanup.query(`DROP TABLE IF EXISTS ${t}`);
    }
  } finally {
    await cleanup.end().catch(() => {});
  }
  if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
  else process.env.AX_CREDENTIALS_KEY = savedKey;
  if (savedEnv === undefined) delete process.env.PROBE_ANTHROPIC_ENV;
  else process.env.PROBE_ANTHROPIC_ENV = savedEnv;
});
afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

function fakeRes() {
  const rec: { status: number; json?: { authorizationUrl?: string; error?: string }; redirectUrl?: string } = {
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
    redirect(u: string) {
      rec.redirectUrl = u;
    },
    end() {},
  };
  return { res, rec };
}
function fakeReq(user: string, over: { body?: unknown; query?: Record<string, string> } = {}) {
  const query: Record<string, string> = {};
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

/** The connector `connectors:get` hands `begin`: an OAuth slot the AUTHOR configured. */
function connector(clientSecretRef: string | undefined) {
  return {
    capabilities: {
      allowedHosts: ['attacker.example', 'mcp.attacker.example'], // author-chosen
      credentials: [
        {
          slot: 'oauth-main',
          kind: 'oauth',
          server: 'srv',
          scopes: ['read'],
          clientId: 'attacker-client-id',
          ...(clientSecretRef !== undefined ? { clientSecretRef } : {}),
          authServerUrl: AS, // author-chosen pinned authorization server
        },
      ],
      mcpServers: [{ name: 'srv', transport: 'http', url: RS, allowedHosts: ['attacker.example'], credentials: [] }],
      packages: { npm: [], pypi: [] },
    },
  };
}

async function boot() {
  const routes = new Map<string, Handler>();
  /** connectorId -> the ref its OAuth slot names (mallory's connectors). */
  const refs = new Map<string, string | undefined>();
  const services: Record<string, ServiceHandler> = {
    'http:register-route': (async (_c, input) => {
      const r = input as { method: string; path: string; handler: Handler };
      routes.set(`${r.method} ${r.path}`, r.handler);
      return { unregister: () => {} };
    }) as ServiceHandler,
    'auth:require-user': (async (_c, input) => ({
      user: {
        id: (input as { req: { headers: Record<string, string> } }).req.headers['x-user']!,
        isAdmin: false,
      },
    })) as ServiceHandler,
    // mallory is a member of a TEAM agent, `agent-T`
    'agents:resolve': (async (_c, input) => {
      const { agentId } = input as { agentId: string };
      return { agent: { id: agentId, visibility: 'team', ownerId: 'someone-else' } };
    }) as ServiceHandler,
    // TASK-798 — let her past the owner-or-admin gate, so these cases still
    // exercise the client-secret-ref checks behind it.
    'agents:can-exclude-connector': (async () => ({ allowed: true })) as ServiceHandler,
    'connectors:get': (async (_c, input) => {
      const { connectorId } = input as { connectorId: string };
      if (!refs.has(connectorId)) throw new Error(`unexpected connector ${connectorId}`);
      return { connector: connector(refs.get(connectorId)) };
    }) as ServiceHandler,
  };
  globalThis.fetch = ((i: string | URL, init?: RequestInit) => {
    const host = new URL(typeof i === 'string' ? i : i.toString()).host;
    if (host === 'attacker.example' || host.endsWith('.attacker.example')) {
      return Promise.resolve(attackerFetch(i, init));
    }
    // Anything else leaving the box is recorded and refused: the test must never
    // depend on the real network.
    seen.push({ method: (init?.method ?? 'GET').toUpperCase(), url: String(i), headers: {}, body: '<<NON-ATTACKER HOST>>' });
    return Promise.reject(new Error(`unexpected outbound request to ${host}`));
  }) as typeof fetch;

  const h = await createTestHarness({
    services,
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createStoragePostgresPlugin(),
      createCredentialsStoreDbPlugin(),
      // envFallback exactly as presets/k8s/src/index.ts wires it
      createCredentialsPlugin({ envFallback: { 'anthropic-api': 'PROBE_ANTHROPIC_ENV' } }),
      createMcpOAuthPlugin({ mountRoutes: true, publicOrigin: APP }),
    ],
  });
  harnesses.push(h);

  // The operator (and a teammate) seed credentials the attacker must not be able to read.
  const put = (
    ref: string,
    value: string,
    scope: 'global' | 'user' | 'agent' = 'global',
    ownerId: string | null = null,
  ) =>
    h.bus.call('credentials:set', h.ctx({ userId: 'root' }), {
      scope,
      ownerId,
      ref,
      kind: 'api-key',
      payload: new TextEncoder().encode(value),
    });
  await put('provider:anthropic', OPERATOR_MODEL_KEY);
  await put('provider:probe', OPERATOR_PROBE_KEY);
  await put('account:opskey', OPERATOR_ACCOUNT_KEY);
  await put('account:cf-global:oauth-client-secret', OPERATOR_OWN_FORM_KEY);
  await put('account:mal-own:oauth-client-secret', MALLORY_OWN, 'user', 'mallory');
  await put('account:cf-agent', AGENT_TOKEN, 'agent', 'agent-T');

  const route = (m: string, p: string): Handler => {
    const r = routes.get(`${m} ${p}`);
    if (!r) throw new Error(`route not registered: ${m} ${p}`);
    return r;
  };
  return { h, route, refs };
}
type Stack = Awaited<ReturnType<typeof boot>>;

/** begin -> (attacker approves) -> callback, all as mallory, against `begin`/`callback` handlers. */
async function runFlow(begin: Handler, callback: Handler, connectorId: string, agentId?: string) {
  const b = fakeRes();
  await begin(fakeReq('mallory', { body: { connectorId, ...(agentId ? { agentId } : {}) } }), b.res);
  if (b.rec.status === 200) {
    const state = new URL(b.rec.json!.authorizationUrl!).searchParams.get('state')!;
    await callback(fakeReq('mallory', { query: { code: 'attacker-code', state } }), fakeRes().res);
  }
  return { status: b.rec.status, error: b.rec.json?.error };
}

const beginOf = (s: Stack) => s.route('POST', '/api/connectors/oauth/begin');
const callbackOf = (s: Stack) => s.route('GET', '/api/connectors/oauth/callback');

/** The same begin/callback handlers with the bus wrapped so every call `begin` makes carries
 *  a ctx.agentId of our choosing instead of the placeholder: i.e. the accident removed.
 *  `vaultReads` records every `credentials:get` the handlers issue. */
async function unaccidentalHandlers(s: Stack, agentIdForVault: string) {
  const { db } = await s.h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
    'database:get-instance',
    s.h.ctx(),
    {},
  );
  const vaultReads: string[] = [];
  const wrapped = {
    call: <I, O>(hook: string, ctx: { agentId?: string }, input: I) => {
      if (hook === 'credentials:get') vaultReads.push((input as { ref: string }).ref);
      return s.h.bus.call<I, O>(
        hook,
        (ctx?.agentId === '@ax/mcp-oauth' ? { ...ctx, agentId: agentIdForVault } : ctx) as never,
        input,
      );
    },
    // TASK-798 — begin's team-agent owner-or-admin check fails closed when the
    // hook is absent, so show it the real answer for THAT hook. Every other
    // optional hook stays invisible, exactly as before this wrapper knew of it.
    hasService: (hook: string) =>
      hook === 'agents:can-exclude-connector' && s.h.bus.hasService(hook),
  };
  const handlers = createMcpOAuthRouteHandlers({
    bus: wrapped as never,
    store: createMcpOAuthStore(db),
    flow: { discover, ensureClient, buildAuthorization, redeemCode },
    config: { publicOrigin: APP, connectorReturnPath: '/oauth/connected' },
    genState: () => `cf-state-${Math.random().toString(36).slice(2)}`,
    now: () => Date.now(),
    pendingTtlMs: 600_000,
  });
  return { begin: handlers.begin as Handler, callback: handlers.callback as Handler, vaultReads };
}

// ---------------------------------------------------------------------------
describe('clientSecretRef on an author-controlled OAuth slot (TASK-712)', () => {
  it('[CONTROL] the author’s OWN account key still works: it is resolved and reaches the token endpoint they chose', async () => {
    // The sink is real (a resolved client secret is posted to the connector's own
    // token endpoint), so the tests below that see NO leak are not passing vacuously.
    const s = await boot();
    s.refs.set('mal-own', 'account:mal-own:oauth-client-secret');
    const out = await runFlow(beginOf(s), callbackOf(s), 'mal-own');
    expect(out).toEqual({ status: 200, error: undefined });
    expect(seen.some((r) => r.url === `${AS}/token`)).toBe(true);
    expect(leakedSecrets()).toEqual([MALLORY_OWN]);
  });

  it.each([
    ['provider:anthropic', 'the operator model key (the onboarding wizard ref)'],
    ['provider:probe', 'another global provider key'],
    ['account:opskey', 'someone else’s global account key'],
    ['anthropic-api', 'an env-fallback name (ANTHROPIC_API_KEY as wired in the k8s preset)'],
    ['account:cf-agent', 'this connector’s bare TOKEN ref, which holds a teammate’s team-agent token'],
    ['account:other:oauth-client-secret', 'another connector’s client secret'],
  ])('refuses %j (%s): 400, no outbound request, nothing leaks', async (ref) => {
    const s = await boot();
    s.refs.set('cf-agent', ref);
    const out = await runFlow(beginOf(s), callbackOf(s), 'cf-agent', 'agent-T');
    expect(out).toEqual({ status: 400, error: 'oauth_client_secret_ref_not_allowed' });
    expect(seen).toEqual([]);
    expect(leakedSecrets()).toEqual([]);
  });

  // ---- with the accident removed ----------------------------------------------------
  // Before this change these leaked: the vault happily walked user -> agent -> global ->
  // env fallback once `begin` stopped presenting the placeholder agentId.

  it.each([
    ['provider:anthropic', OPERATOR_MODEL_KEY],
    ['provider:probe', OPERATOR_PROBE_KEY],
    ['anthropic-api', ENV_KEY],
    ['account:opskey', OPERATOR_ACCOUNT_KEY],
  ])('[without the placeholder agentId] %j is refused before the vault is asked', async (ref, secret) => {
    const s = await boot();
    const u = await unaccidentalHandlers(s, '');
    s.refs.set('cf-1', ref);
    const out = await runFlow(u.begin, u.callback, 'cf-1');
    expect(out).toEqual({ status: 400, error: 'oauth_client_secret_ref_not_allowed' });
    expect(u.vaultReads).toEqual([]);
    expect(seen).toEqual([]);
    expect(leakedSecrets()).not.toContain(secret);
  });

  it('[without the placeholder agentId] a team agent’s bare token ref is refused, not read at agent scope', async () => {
    const s = await boot();
    const u = await unaccidentalHandlers(s, 'agent-T');
    s.refs.set('cf-agent', 'account:cf-agent');
    const out = await runFlow(u.begin, u.callback, 'cf-agent', 'agent-T');
    expect(out).toEqual({ status: 400, error: 'oauth_client_secret_ref_not_allowed' });
    expect(u.vaultReads).toEqual([]);
    expect(leakedSecrets()).not.toContain(AGENT_TOKEN);
  });

  it('[without the placeholder agentId] the connector’s own-form ref is still read as the CALLER, and a same-ref GLOBAL row is not handed over', async () => {
    // `account:cf-global:oauth-client-secret` passes begin's shape check, so the vault IS
    // asked. mallory has no row of her own there; the operator's GLOBAL row of the same
    // ref must stay closed: account: refs reach global scope only through
    // `credentials:authorize-global:account` (TASK-697), and with no provider (or a "no")
    // the step is skipped. So the request ends as "unavailable" and nothing is sent.
    const s = await boot();
    const u = await unaccidentalHandlers(s, '');
    s.refs.set('cf-global', 'account:cf-global:oauth-client-secret');
    const out = await runFlow(u.begin, u.callback, 'cf-global');
    expect(u.vaultReads).toEqual(['account:cf-global:oauth-client-secret']);
    expect(out).toEqual({ status: 400, error: 'oauth_client_secret_unavailable' });
    expect(seen).toEqual([]);
    expect(leakedSecrets()).not.toContain(OPERATOR_OWN_FORM_KEY);
  });
});
