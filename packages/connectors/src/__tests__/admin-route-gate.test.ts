import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError, type Plugin } from '@ax/core';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createMemoryEgressAllowlistStore,
  createMemoryVerdictStore,
  createToolPolicyPlugin,
} from '@ax/tool-policy';
import { createConnectorsPlugin } from '../plugin.js';
import {
  createConnectorRouteHandlers,
  type RouteRequest,
  type RouteResponse,
} from '../admin-routes.js';
import type {
  Capabilities,
  ListOutput,
  UpsertInput,
  UpsertOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-698 regression: `/admin/connectors*` must be admin-only.
//
// THE BUG. Every handler behind `/admin/connectors*` called only `requireUser`, so
// a signed-in NON-admin could list / create / read / patch / test / delete through
// the admin bundle. The visible damage: `POST /admin/connectors` with
// `keyMode: workspace` (then also `visibility: shared`) returned 201 and
// stored exactly that row for a non-admin, while the same body on the locked-down
// `/settings/connectors` twin 400s (`visibility: shared is admin-only`). And
// `POST /admin/connectors/:id/test` told a non-admin which global `account:` keys
// exist (names only). Every other `/admin/*` surface answers 403.
//
// REAL PIECES: the postgres connectors store and the route table exactly as the
// plugin registers it (captured off a stub `http:register-route`, so the handler
// under test has no wrapper in front of it -- a gate that lived in the test
// instead of the registration would not survive this). STUBS: `auth:require-user`
// (a chosen actor) and `credentials:list` (records every call so the /test leak
// can be asserted absent).
// ---------------------------------------------------------------------------

type Actor = { id: string; isAdmin: boolean };
const ROOT: Actor = { id: 'root', isAdmin: true };
const MALLORY: Actor = { id: 'mallory', isAdmin: false }; // signed-in NON-admin

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

/** The session the stubbed `auth:require-user` returns; null = signed out. */
let currentActor: Actor | null = null;
/** Every `credentials:list` the /test probe made (scope, ownerId). */
let credentialListCalls: Array<{ scope?: string; ownerId?: string | null }> = [];

type Handler = (req: RouteRequest, res: RouteResponse) => Promise<void>;
const routes = new Map<string, Handler>();

function authStub(): Plugin {
  return {
    manifest: {
      name: 'auth-stub',
      version: '0.0.0',
      registers: ['auth:require-user'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService('auth:require-user', 'auth-stub', async () => {
        if (currentActor === null) {
          throw new PluginError({
            code: 'unauthenticated',
            plugin: 'auth-stub',
            hookName: 'auth:require-user',
            message: 'no session',
          });
        }
        return { user: currentActor };
      });
    },
  };
}

function httpCaptureStub(): Plugin {
  return {
    manifest: {
      name: 'http-capture',
      version: '0.0.0',
      registers: ['http:register-route'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService(
        'http:register-route',
        'http-capture',
        async (_ctx, r: { method: string; path: string; handler: Handler }) => {
          routes.set(`${r.method} ${r.path}`, r.handler);
          return { unregister: () => routes.delete(`${r.method} ${r.path}`) };
        },
      );
    },
  };
}

function credentialsStub(): Plugin {
  return {
    manifest: {
      name: 'credentials-stub',
      version: '0.0.0',
      registers: ['credentials:list'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService(
        'credentials:list',
        'credentials-stub',
        async (_ctx, input: { scope?: string; ownerId?: string | null }) => {
          credentialListCalls.push(input);
          // A company key exists under the derived ref of `ws-conn`: what a
          // non-admin must not be able to learn through the probe.
          return {
            credentials:
              input.scope === 'global'
                ? [{ scope: 'global', ownerId: null, ref: 'account:ws-conn' }]
                : [],
          };
        },
      );
    },
  };
}

async function makeHarness(): Promise<TestHarness> {
  routes.clear();
  credentialListCalls = [];
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      authStub(),
      httpCaptureStub(),
      credentialsStub(),
      createConnectorsPlugin({ mountAdminRoutes: true }),
      // TASK-737 — the tool-permissions routes need a permission store.
      createToolPolicyPlugin({
        egressStore: createMemoryEgressAllowlistStore(),
        verdictStore: createMemoryVerdictStore(),
      }),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  currentActor = null;
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // Every test starts from an empty connectors table.
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS connectors_v1_connectors');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function caps(host: string): Capabilities {
  return {
    allowedHosts: [host],
    credentials: [{ slot: 'API_KEY', kind: 'api-key' }],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
    services: [],
  };
}

async function call(
  method: string,
  path: string,
  actor: Actor | null,
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const handler = routes.get(`${method} ${path}`);
  if (handler === undefined) throw new Error(`route not registered: ${method} ${path}`);
  currentActor = actor;
  const cap = { status: 0, body: undefined as unknown };
  const res: RouteResponse = {
    status(n) {
      cap.status = n;
      return res;
    },
    json(v) {
      cap.body = v;
    },
    text(s) {
      cap.body = s;
    },
    end() {
      /* 204 */
    },
  };
  const req: RouteRequest = {
    headers: {},
    cookies: {},
    query: {},
    params: opts.params ?? {},
    body: opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body)),
    signedCookie: () => null,
  };
  await handler(req, res);
  return cap;
}

/** Seed a connector straight through the hook (NOT the route), so the fixture is
 *  independent of the gate under test. */
async function seed(h: TestHarness, owner: string, connectorId: string, keyMode: 'personal' | 'workspace' = 'personal') {
  await h.bus.call<UpsertInput, UpsertOutput>(
    'connectors:upsert',
    h.ctx({ userId: owner }),
    {
      userId: owner,
      connectorId,
      name: `${connectorId} (seeded)`,
      keyMode,
      capabilities: caps(`${connectorId}.example.com`),
    },
  );
}

async function listIds(h: TestHarness, userId: string): Promise<string[]> {
  const out = await h.bus.call<{ userId: string }, ListOutput>(
    'connectors:list',
    h.ctx({ userId }),
    { userId },
  );
  return out.connectors.map((c) => c.id).sort();
}

interface RouteCase {
  label: string;
  method: string;
  path: string;
  /** Builds the request for an owned connector id. */
  opts: (id: string) => { params?: Record<string, string>; body?: unknown };
  /** What an ADMIN gets for the same request (proves the gate lets admins in). */
  adminStatus: number;
}

const ADMIN_ROUTES: RouteCase[] = [
  { label: 'GET /admin/connectors', method: 'GET', path: '/admin/connectors', opts: () => ({}), adminStatus: 200 },
  // Slice 2c — the agent-proposal queue and its Dismiss.
  { label: 'GET /admin/connectors/authored', method: 'GET', path: '/admin/connectors/authored', opts: () => ({}), adminStatus: 200 },
  {
    label: 'DELETE /admin/connectors/authored/:connectorId',
    method: 'DELETE',
    path: '/admin/connectors/authored/:connectorId',
    opts: (id) => ({ params: { connectorId: id } }),
    adminStatus: 204,
  },
  {
    label: 'POST /admin/connectors',
    method: 'POST',
    path: '/admin/connectors',
    opts: (id) => ({
      body: { connectorId: `new-${id}`, name: 'New', keyMode: 'personal', capabilities: caps('n.example.com') },
    }),
    adminStatus: 201,
  },
  { label: 'GET /admin/connectors/:id', method: 'GET', path: '/admin/connectors/:id', opts: (id) => ({ params: { id } }), adminStatus: 200 },
  {
    label: 'PATCH /admin/connectors/:id',
    method: 'PATCH',
    path: '/admin/connectors/:id',
    opts: (id) => ({ params: { id }, body: { name: 'renamed' } }),
    adminStatus: 200,
  },
  { label: 'POST /admin/connectors/:id/test', method: 'POST', path: '/admin/connectors/:id/test', opts: (id) => ({ params: { id } }), adminStatus: 200 },
  { label: 'DELETE /admin/connectors/:id', method: 'DELETE', path: '/admin/connectors/:id', opts: (id) => ({ params: { id } }), adminStatus: 204 },
  // TASK-737 — per-tool default permissions.
  {
    label: 'GET /admin/connectors/:id/tool-permissions',
    method: 'GET',
    path: '/admin/connectors/:id/tool-permissions',
    opts: (id) => ({ params: { id } }),
    adminStatus: 200,
  },
  {
    label: 'PUT /admin/connectors/:id/tool-permissions',
    method: 'PUT',
    path: '/admin/connectors/:id/tool-permissions',
    opts: (id) => ({ params: { id }, body: { verdicts: [] } }),
    adminStatus: 200,
  },
];

describe('/admin/connectors* is admin-only (TASK-698)', () => {
  it('registers exactly the admin routes this matrix covers (a new admin route must join the matrix)', async () => {
    await makeHarness();
    const registered = [...routes.keys()].filter((k) => k.split(' ')[1]?.startsWith('/admin/connectors')).sort();
    expect(registered).toEqual(ADMIN_ROUTES.map((r) => `${r.method} ${r.path}`).sort());
  });

  describe.each(ADMIN_ROUTES)('$label', (route) => {
    it('401 when signed out', async () => {
      const h = await makeHarness();
      await seed(h, ROOT.id, 'root-conn');
      const r = await call(route.method, route.path, null, route.opts('root-conn'));
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'unauthenticated' });
    });

    it('403 for a signed-in NON-admin, even against a connector they own', async () => {
      const h = await makeHarness();
      // Mallory OWNS `mal-own`, so a 404 here would mean "not found"; only the gate
      // can turn this into a 403.
      await seed(h, MALLORY.id, 'mal-own');
      const r = await call(route.method, route.path, MALLORY, route.opts('mal-own'));
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'forbidden' });
      // Nothing happened: still there, still under its seeded name.
      expect(await listIds(h, MALLORY.id)).toEqual(['mal-own']);
      const got = await h.bus.call<{ userId: string; connectorId: string }, { connector: { name: string } }>(
        'connectors:get',
        h.ctx({ userId: MALLORY.id }),
        { userId: MALLORY.id, connectorId: 'mal-own' },
      );
      expect(got.connector.name).toBe('mal-own (seeded)');
    });

    it('lets an admin through', async () => {
      const h = await makeHarness();
      await seed(h, ROOT.id, 'root-conn');
      const r = await call(route.method, route.path, ROOT, route.opts('root-conn'));
      expect(r.status).toBe(route.adminStatus);
    });
  });

  it('the shared / workspace-key bypass body is refused for a non-admin and stores nothing', async () => {
    const h = await makeHarness();
    const body = {
      connectorId: 'mal-shared',
      name: 'Mal shared',
      keyMode: 'workspace',
      capabilities: caps('m.example.com'),
    };
    // The locked-down twin no longer exists, and the admin route refuses a non-admin.
    expect(routes.has('POST /settings/connectors')).toBe(false);
    const viaAdmin = await call('POST', '/admin/connectors', MALLORY, { body });
    expect(viaAdmin.status).toBe(403);
    expect(await listIds(h, MALLORY.id)).toEqual([]);
  });

  it('POST /admin/connectors/:id/test does not reveal which global keys exist to a non-admin', async () => {
    const h = await makeHarness();
    await seed(h, MALLORY.id, 'ws-conn', 'workspace');
    const r = await call('POST', '/admin/connectors/:id/test', MALLORY, { params: { id: 'ws-conn' } });
    expect(r.status).toBe(403);
    // No verdict (`needs-key` would name the missing slot; `reachable` would prove
    // the global key exists) and, more to the point, the vault was never asked.
    expect(r.body).toEqual({ error: 'forbidden' });
    expect(credentialListCalls).toEqual([]);
  });

  it('an admin still gets the probe verdict, reads a connector someone else defined, and 404s an unknown id', async () => {
    const h = await makeHarness();
    await seed(h, ROOT.id, 'ws-conn', 'workspace');
    await seed(h, MALLORY.id, 'mal-only');
    const ok = await call('POST', '/admin/connectors/:id/test', ROOT, { params: { id: 'ws-conn' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'reachable' });
    // SIGNINS-9 — every connector is shared, so an admin reads (and curates)
    // one another person defined; an id nobody defined is still a 404.
    const foreign = await call('GET', '/admin/connectors/:id', ROOT, { params: { id: 'mal-only' } });
    expect(foreign.status).toBe(200);
    const missing = await call('GET', '/admin/connectors/:id', ROOT, { params: { id: 'nobody-made-this' } });
    expect(missing.status).toBe(404);
  });

  it('only the two READ /settings/connectors routes exist: no write or authored route is registered (production answers 405 or 404)', async () => {
    const h = await makeHarness();
    const settings = [...routes.keys()].filter((k) => k.split(' ')[1]?.startsWith('/settings/connectors')).sort();
    expect(settings).toEqual(['GET /settings/connectors', 'GET /settings/connectors/:id']);
    // The removed writes and (slice 2c) the per-person proposal routes: a
    // signed-in non-admin finds no handler. Proposals now go to admins.
    const removed = [
      'GET /settings/connectors/authored',
      'POST /settings/connectors/authored/:id/approve',
      'DELETE /settings/connectors/authored/:id',
      'POST /settings/connectors',
      'PATCH /settings/connectors/:id',
      'DELETE /settings/connectors/:id',
      'PUT /settings/connectors/:id/tool-permissions',
      'GET /settings/connectors/:id/tool-permissions',
    ];
    for (const key of removed) {
      await expect(call(key.split(' ')[0]!, key.split(' ')[1]!, MALLORY, { params: { id: 'x' }, body: {} })).rejects.toThrow(
        /route not registered/,
      );
    }
    // What production answers for them: @ax/http-server's router replies 405
    // (Allow: <the other methods>) when another method is registered on the same
    // path, else 404. A GET still shares the first three paths; nothing is
    // registered on the tool-permissions path any more.
    const methodsOn = (path: string) =>
      [...routes.keys()].filter((k) => k.split(' ')[1] === path).map((k) => k.split(' ')[0]);
    expect(methodsOn('/settings/connectors')).toEqual(['GET']);
    expect(methodsOn('/settings/connectors/:id')).toEqual(['GET']);
    expect(methodsOn('/settings/connectors/:id/tool-permissions')).toEqual([]);
    // The reads stay open to a non-admin (the agent rail's Add list).
    await seed(h, MALLORY.id, 'mal-mine');
    expect((await call('GET', '/settings/connectors', MALLORY)).status).toBe(200);
    expect((await call('GET', '/settings/connectors/:id', MALLORY, { params: { id: 'mal-mine' } })).status).toBe(200);
    expect(await listIds(h, MALLORY.id)).toEqual(['mal-mine']);
  });

  it('the Test probe is admin-only even on a user-mode bundle, and is not mounted under /settings', async () => {
    const h = await makeHarness();
    expect(routes.has('POST /settings/connectors/:id/test')).toBe(false);
    await seed(h, MALLORY.id, 'ws-conn', 'workspace');
    // Never registered today; if someone ever bundles it there it must not become
    // the non-admin probe the admin route just stopped being.
    const userBundle = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = MALLORY;
    const cap = { status: 0, body: undefined as unknown };
    const res: RouteResponse = {
      status(n) {
        cap.status = n;
        return res;
      },
      json(v) {
        cap.body = v;
      },
      text() {},
      end() {},
    };
    await userBundle.test(
      { headers: {}, cookies: {}, query: {}, params: { id: 'ws-conn' }, body: Buffer.alloc(0), signedCookie: () => null },
      res,
    );
    expect(cap.status).toBe(403);
    expect(credentialListCalls).toEqual([]);
  });
});
