import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError, type Plugin } from '@ax/core';
import {
  createTestHarness,
  stopPostgresContainer,
  type TestHarness,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConnectorsPlugin } from '../plugin.js';
import {
  createAdminConnectorRouteHandlers,
  createConnectorRouteHandlers,
  ADMIN_BODY_MAX_BYTES,
  type RouteRequest,
  type RouteResponse,
} from '../admin-routes.js';
import type { Capabilities } from '../types.js';
import { createConnectorStore } from '../store.js';
import type { ConnectorDatabase } from '../migrations.js';
import type { Kysely } from 'kysely';

// ---------------------------------------------------------------------------
// Admin connector endpoints — GET/POST /admin/connectors,
// GET/PATCH/DELETE /admin/connectors/:id.
//
// These handlers bridge the `connectors:*` hooks to HTTP for the channel-web
// registry UI. We drive the handlers DIRECTLY with duck-typed RouteRequest /
// RouteResponse objects against a REAL connector store (postgres testcontainer
// via the harness) — the same store the bus hooks use, so the test exercises the
// full create → read → patch → delete round-trip plus the auth gate and the
// cross-tenant 404. `auth:require-user` is stubbed in the harness to return a
// chosen actor (the http-server / auth-better stack is integration-tested in
// the channel-web suite; here we isolate the bridge logic).
//
// Cross-tenant (mandatory): User A creates a connector; User B's list must NOT
// include it and User B's GET/PATCH/DELETE :id must 404 — proving the actor id
// is forced from the (stubbed) session, never the body.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

// Mutable actor the stubbed auth hook returns. `null` ⟹ unauthenticated (the
// stub throws, so requireUser returns a 401).
let currentActor: { id: string; isAdmin: boolean } | null = null;

function authStubPlugin(): Plugin {
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

// Stubbed credential metadata the connector Test probe reads via
// `credentials:list` (TASK-108). METADATA ONLY — the probe never touches a
// secret value, and neither does this stub. Each row is `{ scope, ownerId,
// ref }`; the stub filters by the (scope, ownerId) the probe asks for, mirroring
// the real @ax/credentials list scoping. Mutable so a test can seed / clear the
// vault. `credentialsListThrows` lets a test force the read-failure branch.
let credentialRows: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
let credentialsListThrows = false;

function credentialsStubPlugin(): Plugin {
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
          if (credentialsListThrows) {
            throw new PluginError({
              code: 'unavailable',
              plugin: 'credentials-stub',
              hookName: 'credentials:list',
              message: 'vault down',
            });
          }
          const credentials = credentialRows.filter(
            (r) =>
              (input.scope === undefined || r.scope === input.scope) &&
              (input.ownerId === undefined || r.ownerId === input.ownerId),
          );
          return { credentials };
        },
      );
    },
  };
}

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      authStubPlugin(),
      credentialsStubPlugin(),
      createConnectorsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  // Use the shared helper (TASK-104) so the benign 57P01 teardown race can't
  // red the suite, matching every sibling postgres-testcontainer test.
  if (container) await stopPostgresContainer(container);
});

afterEach(async () => {
  currentActor = null;
  credentialRows = [];
  credentialsListThrows = false;
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) await h.close();
  }
  // Shared definitions are visible across actors, so isolate each scenario.
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('TRUNCATE connectors_v1_connectors, connectors_v1_authored');
  } finally {
    await cleanup.end();
  }

});

function mcpCaps(): Capabilities {
  return {
    allowedHosts: ['drive.googleapis.com'],
    // No share-by-service `account` tag — keyed by the connector id.
    credentials: [{ slot: 'gdrive', kind: 'api-key' }],
    mcpServers: [
      {
        name: 'gdrive',
        transport: 'http',
        url: 'https://mcp.example.com/gdrive',
        allowedHosts: ['mcp.example.com'],
        credentials: [],
      },
    ],
    packages: { npm: [], pypi: [] },
  };
}

// --- duck-typed request/response stubs ------------------------------------

function makeReq(opts: {
  params?: Record<string, string>;
  body?: unknown;
}): RouteRequest {
  const bodyBuf =
    opts.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(
          typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
          'utf8',
        );
  return {
    headers: {},
    body: bodyBuf,
    cookies: {},
    query: {},
    params: opts.params ?? {},
    signedCookie: () => null,
  };
}

interface Captured {
  status: number;
  body: unknown;
  ended: boolean;
}

function makeRes(): { res: RouteResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined, ended: false };
  const res: RouteResponse = {
    status(n: number) {
      captured.status = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text(s: string) {
      captured.body = s;
    },
    end() {
      captured.ended = true;
    },
  };
  return { res, captured };
}

describe('admin connector routes', () => {
  it('401 when unauthenticated', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = null;
    const { res, captured } = makeRes();
    await handlers.list(makeReq({}), res);
    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
  });

  it('POST creates a connector (201) and GET round-trips it', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };

    const { res: cRes, captured: cCap } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'gdrive',
          name: 'Google Drive',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      cRes,
    );
    expect(cCap.status).toBe(201);
    expect((cCap.body as { created: boolean }).created).toBe(true);

    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'gdrive' } }), gRes);
    expect(gCap.status).toBe(200);
    const connector = (gCap.body as { connector: { id: string; name: string; capabilities: Capabilities } })
      .connector;
    expect(connector.id).toBe('gdrive');
    expect(connector.name).toBe('Google Drive');
    expect(connector.capabilities.mcpServers).toHaveLength(1);

    const { res: lRes, captured: lCap } = makeRes();
    await handlers.list(makeReq({}), lRes);
    expect(lCap.status).toBe(200);
    const list = (lCap.body as { connectors: Array<{ id: string }> }).connectors;
    expect(list.map((c) => c.id)).toContain('gdrive');
  });

  it('round-trips a `services` capability proposal through the store (TASK-154)', async () => {
    // A "service bundle" connector DECLARES dev services on its capability
    // proposal. The store re-validates capabilities (incl. `services`) on
    // write+read via `CapabilitiesSchema`; the detail response must surface the
    // declared services (name/image/ports/env/writablePaths). Service `env` is
    // author-declared CONFIG, NOT a secret — secrets live in
    // `capabilities.credentials` (credential SLOT names only). So surfacing the
    // service env here is correct and leaks nothing.
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userSvc', isAdmin: true };

    const pinned = 'docker.io/library/postgres@sha256:' + 'a'.repeat(64);
    const caps: Capabilities = {
      allowedHosts: [],
      credentials: [],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
      services: [
        {
          name: 'db',
          image: pinned,
          ports: [5432],
          env: { POSTGRES_PASSWORD: 'x' },
          writablePaths: ['/var/lib/postgresql/data'],
        },
      ],
    };

    const { res: cRes, captured: cCap } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'pg-bundle',
          name: 'Postgres bundle',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: caps,
        },
      }),
      cRes,
    );
    expect(cCap.status).toBe(201);

    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'pg-bundle' } }), gRes);
    expect(gCap.status).toBe(200);
    const got = (gCap.body as { connector: { capabilities: Capabilities } }).connector;
    expect(got.capabilities.services).toEqual([
      {
        name: 'db',
        image: pinned,
        ports: [5432],
        env: { POSTGRES_PASSWORD: 'x' },
        writablePaths: ['/var/lib/postgresql/data'],
      },
    ]);
  });

  it('forces actor id from session — a body-supplied userId cannot impersonate', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    const { res, captured } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          userId: 'someoneElse',
          connectorId: 'sf',
          name: 'Salesforce',
          keyMode: 'workspace',
          visibility: 'shared',
          capabilities: {
            allowedHosts: ['login.salesforce.com'],
            credentials: [{ slot: 'sf', kind: 'api-key' }],
            mcpServers: [],
            packages: { npm: ['@salesforce/cli'], pypi: [] },
          } satisfies Capabilities,
        },
      }),
      res,
    );
    expect(captured.status).toBe(201);
    // The connector landed under userA, not "someoneElse": userA can read it.
    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'sf' } }), gRes);
    expect(gCap.status).toBe(200);
  });

  it('PATCH updates an owned connector (200)', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'gdrive',
          name: 'Drive',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      makeRes().res,
    );
    const { res, captured } = makeRes();
    await handlers.update(
      makeReq({ params: { id: 'gdrive' }, body: { name: 'Google Drive (renamed)' } }),
      res,
    );
    expect(captured.status).toBe(200);
    expect((captured.body as { connector: { name: string } }).connector.name).toBe(
      'Google Drive (renamed)',
    );
    // capabilities preserved through the merge (not wiped by the partial patch).
    expect(
      (captured.body as { connector: { capabilities: Capabilities } }).connector
        .capabilities.mcpServers,
    ).toHaveLength(1);
  });

  it('TASK-827: PATCH that switches keyMode is refused (400, clear message); the row keeps its mode', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'gdrive',
          name: 'Drive',
          keyMode: 'personal',
          visibility: 'shared',
          capabilities: mcpCaps(),
        },
      }),
      makeRes().res,
    );
    const { res, captured } = makeRes();
    await handlers.update(
      makeReq({ params: { id: 'gdrive' }, body: { keyMode: 'workspace' } }),
      res,
    );
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toMatch(/create a new connector/i);
    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'gdrive' } }), gRes);
    expect((gCap.body as { connector: { keyMode: string } }).connector.keyMode).toBe('personal');
    // Re-sending the SAME keyMode (the editors send the whole record) is fine.
    const same = makeRes();
    await handlers.update(
      makeReq({ params: { id: 'gdrive' }, body: { keyMode: 'personal', name: 'Drive 2' } }),
      same.res,
    );
    expect(same.captured.status).toBe(200);
  });

  it('DELETE removes an owned connector (204), then GET 404s', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'gdrive',
          name: 'Drive',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      makeRes().res,
    );
    const { res, captured } = makeRes();
    await handlers.destroy(makeReq({ params: { id: 'gdrive' } }), res);
    expect(captured.status).toBe(204);
    expect(captured.ended).toBe(true);

    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'gdrive' } }), gRes);
    expect(gCap.status).toBe(404);
  });

  it('cross-tenant: User B never sees User A’s connector and 404s on its id', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'gdrive',
          name: 'Drive',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      makeRes().res,
    );

    // User B is an ADMIN too: `/admin/connectors*` 403s a non-admin before
    // ownership is ever looked at (TASK-698, admin-route-gate.test.ts), so the
    // cross-tenant 404 is only reachable — and only worth proving — for another admin.
    currentActor = { id: 'userB', isAdmin: true };
    const { res: lRes, captured: lCap } = makeRes();
    await handlers.list(makeReq({}), lRes);
    expect((lCap.body as { connectors: Array<{ id: string }> }).connectors).toHaveLength(0);

    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'gdrive' } }), gRes);
    expect(gCap.status).toBe(404);

    const { res: pRes, captured: pCap } = makeRes();
    await handlers.update(
      makeReq({ params: { id: 'gdrive' }, body: { name: 'hijack' } }),
      pRes,
    );
    expect(pCap.status).toBe(404);

    const { res: dRes, captured: dCap } = makeRes();
    await handlers.destroy(makeReq({ params: { id: 'gdrive' } }), dRes);
    expect(dCap.status).toBe(404);
  });

  it('POST 409 connector-id-taken when another owner holds the id as a private connector', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    const body = {
      connectorId: 'gmail',
      name: 'Gmail',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: mcpCaps(),
    };
    currentActor = { id: 'admin1', isAdmin: true };
    const first = makeRes();
    await handlers.create(makeReq({ body }), first.res);
    expect(first.captured.status).toBe(201);

    currentActor = { id: 'admin2', isAdmin: true };
    const second = makeRes();
    await handlers.create(makeReq({ body }), second.res);
    expect(second.captured.status).toBe(409);
    expect(second.captured.body).toEqual({ error: 'connector-id-taken' });
  });

  describe('any admin may edit or delete a SHARED connector, whoever owns it', () => {
    const crm = {
      connectorId: 'crm',
      name: 'CRM',
      keyMode: 'personal',
      visibility: 'shared',
      capabilities: mcpCaps(),
    };

    async function rowOwners(h: TestHarness, id: string): Promise<string[]> {
      const { db } = await h.bus.call<unknown, { db: Kysely<ConnectorDatabase> }>(
        'database:get-instance',
        h.ctx(),
        {},
      );
      return (await createConnectorStore(db).listAllLive(() => {}))
        .filter((r) => r.connectorId === id)
        .map((r) => r.ownerUserId);
    }

    it('a client-supplied updateOnly never reaches the store: admin POST of a NEW id still creates it (201)', async () => {
      const h = await makeHarness();
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'admin1', isAdmin: true };
      const created = makeRes();
      await handlers.create(makeReq({ body: { ...crm, connectorId: 'fresh-one', updateOnly: true } }), created.res);
      expect(created.captured.status).toBe(201);
      expect(await rowOwners(h, 'fresh-one')).toEqual(['admin1']);
    });

    it('admin2 PATCHes admin1’s shared connector: 200, the change sticks, admin1 still owns it', async () => {
      const h = await makeHarness();
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'admin1', isAdmin: true };
      const created = makeRes();
      await handlers.create(makeReq({ body: crm }), created.res);
      expect(created.captured.status).toBe(201);

      currentActor = { id: 'admin2', isAdmin: true };
      const patched = makeRes();
      await handlers.update(
        makeReq({ params: { id: 'crm' }, body: { name: 'CRM (edited)', userId: 'admin2' } }),
        patched.res,
      );
      expect(patched.captured.status).toBe(200);

      const shown = makeRes();
      await handlers.show(makeReq({ params: { id: 'crm' } }), shown.res);
      expect(shown.captured.body).toMatchObject({ connector: { name: 'CRM (edited)' } });
      // Ownership never changes on edit, and the owner id never reaches the wire.
      expect(await rowOwners(h, 'crm')).toEqual(['admin1']);
      expect((shown.captured.body as { connector: object }).connector).not.toHaveProperty(
        'ownerUserId',
      );

      currentActor = { id: 'admin1', isAdmin: true };
      const ownerView = makeRes();
      await handlers.show(makeReq({ params: { id: 'crm' } }), ownerView.res);
      expect(ownerView.captured.body).toMatchObject({
        connector: { name: 'CRM (edited)', canEdit: true },
      });
    });

    it('the admin surface reports a foreign shared connector as editable', async () => {
      const h = await makeHarness();
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'admin1', isAdmin: true };
      await handlers.create(makeReq({ body: crm }), makeRes().res);

      currentActor = { id: 'admin2', isAdmin: true };
      const list = makeRes();
      await handlers.list(makeReq({}), list.res);
      expect(list.captured.body).toMatchObject({ connectors: [{ id: 'crm', canEdit: true }] });
      const shown = makeRes();
      await handlers.show(makeReq({ params: { id: 'crm' } }), shown.res);
      expect(shown.captured.body).toMatchObject({ connector: { id: 'crm', canEdit: true } });
    });

    it('admin2 DELETEs admin1’s shared connector: 204, and admin1 then 404s on it', async () => {
      const h = await makeHarness();
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'admin1', isAdmin: true };
      await handlers.create(makeReq({ body: crm }), makeRes().res);

      currentActor = { id: 'admin2', isAdmin: true };
      const deleted = makeRes();
      await handlers.destroy(makeReq({ params: { id: 'crm' } }), deleted.res);
      expect(deleted.captured.status).toBe(204);

      currentActor = { id: 'admin1', isAdmin: true };
      const shown = makeRes();
      await handlers.show(makeReq({ params: { id: 'crm' } }), shown.res);
      expect(shown.captured.status).toBe(404);
      expect(await rowOwners(h, 'crm')).toEqual([]);
    });

    it('admin2 POSTing admin1’s shared id is a create, not an edit: 409, nothing changes', async () => {
      const h = await makeHarness();
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'admin1', isAdmin: true };
      await handlers.create(makeReq({ body: crm }), makeRes().res);

      currentActor = { id: 'admin2', isAdmin: true };
      const post = makeRes();
      await handlers.create(makeReq({ body: { ...crm, name: 'Hijack' } }), post.res);
      expect(post.captured.status).toBe(409);
      expect(post.captured.body).toEqual({ error: 'connector-id-taken' });
      expect(await rowOwners(h, 'crm')).toEqual(['admin1']);
    });

    it('a non-admin PATCH/DELETE through /admin/connectors/crm is 403 and changes nothing', async () => {
      const h = await makeHarness();
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'admin1', isAdmin: true };
      await handlers.create(makeReq({ body: crm }), makeRes().res);

      currentActor = { id: 'member', isAdmin: false };
      const patched = makeRes();
      await handlers.update(
        makeReq({ params: { id: 'crm' }, body: { name: 'Hijack' } }),
        patched.res,
      );
      expect(patched.captured).toMatchObject({ status: 403, body: { error: 'forbidden' } });
      const deleted = makeRes();
      await handlers.destroy(makeReq({ params: { id: 'crm' } }), deleted.res);
      expect(deleted.captured.status).toBe(403);

      currentActor = { id: 'admin1', isAdmin: true };
      const shown = makeRes();
      await handlers.show(makeReq({ params: { id: 'crm' } }), shown.res);
      expect(shown.captured.body).toMatchObject({ connector: { name: 'CRM' } });
    });

    it('the user surface still refuses a foreign shared connector, even for an admin', async () => {
      const h = await makeHarness();
      currentActor = { id: 'admin1', isAdmin: true };
      await createAdminConnectorRouteHandlers({ bus: h.bus }).create(
        makeReq({ body: crm }),
        makeRes().res,
      );
      currentActor = { id: 'admin2', isAdmin: true };
      const userHandlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
      const patched = makeRes();
      await userHandlers.update(
        makeReq({ params: { id: 'crm' }, body: { name: 'Hijack' } }),
        patched.res,
      );
      expect(patched.captured).toMatchObject({ status: 403, body: { error: 'read-only' } });
      const deleted = makeRes();
      await userHandlers.destroy(makeReq({ params: { id: 'crm' } }), deleted.res);
      expect(deleted.captured.status).toBe(403);
      const listed = makeRes();
      await userHandlers.list(makeReq({}), listed.res);
      expect(listed.captured.body).toMatchObject({ connectors: [{ id: 'crm', canEdit: false }] });
    });

    it('admin2 still cannot see or touch admin1’s PRIVATE connector (404)', async () => {
      const h = await makeHarness();
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'admin1', isAdmin: true };
      await handlers.create(makeReq({ body: { ...crm, visibility: 'private' } }), makeRes().res);

      currentActor = { id: 'admin2', isAdmin: true };
      const patched = makeRes();
      await handlers.update(
        makeReq({ params: { id: 'crm' }, body: { name: 'Hijack' } }),
        patched.res,
      );
      expect(patched.captured.status).toBe(404);
      const deleted = makeRes();
      await handlers.destroy(makeReq({ params: { id: 'crm' } }), deleted.res);
      expect(deleted.captured.status).toBe(404);

      currentActor = { id: 'admin1', isAdmin: true };
      const shown = makeRes();
      await handlers.show(makeReq({ params: { id: 'crm' } }), shown.res);
      expect(shown.captured.body).toMatchObject({ connector: { name: 'CRM' } });
    });

    // A NON-OWNER admin may relabel a shared connector, never retarget it — an endpoint / host / slot change would send every
    // agent's stored sign-ins and the shared key somewhere new.
    describe('a non-owner admin cannot change where it connects or who it is for', () => {
      async function seedAndShow(h: TestHarness) {
        const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
        currentActor = { id: 'admin1', isAdmin: true };
        const created = makeRes();
        await handlers.create(makeReq({ body: crm }), created.res);
        expect(created.captured.status).toBe(201);
        const shown = makeRes();
        await handlers.show(makeReq({ params: { id: 'crm' } }), shown.res);
        return {
          handlers,
          before: (shown.captured.body as { connector: Record<string, unknown> }).connector,
        };
      }

      const caps = mcpCaps();
      const server = caps.mcpServers[0]!;
      const changes: Array<[string, Record<string, unknown>]> = [
        ['a server url', {
          capabilities: { ...caps, mcpServers: [{ ...server, url: 'https://evil.example.com/mcp' }] },
        }],
        ['allowedHosts', { capabilities: { ...caps, allowedHosts: ['evil.example.com'] } }],
        ['a server’s allowedHosts', {
          capabilities: { ...caps, mcpServers: [{ ...server, allowedHosts: ['evil.example.com'] }] },
        }],
        ['a credential slot', {
          capabilities: { ...caps, credentials: [{ slot: 'gdrive', kind: 'api-key', headerName: 'x-leak' }] },
        }],
        ['packages', { capabilities: { ...caps, packages: { npm: ['evil-pkg'], pypi: [] } } }],
        ['keyMode', { keyMode: 'workspace' }],
        ['visibility (shared → private)', { visibility: 'private' }],
      ];

      for (const [what, patch] of changes) {
        it(`refuses ${what}: 403 owner-only-change, the stored row unchanged`, async () => {
          const h = await makeHarness();
          const { handlers, before } = await seedAndShow(h);
          currentActor = { id: 'admin2', isAdmin: true };
          const patched = makeRes();
          await handlers.update(
            makeReq({ params: { id: 'crm' }, body: { name: 'Renamed', ...patch } }),
            patched.res,
          );
          expect(patched.captured).toMatchObject({
            status: 403,
            body: { error: 'owner-only-change' },
          });
          currentActor = { id: 'admin1', isAdmin: true };
          const after = makeRes();
          await handlers.show(makeReq({ params: { id: 'crm' } }), after.res);
          expect((after.captured.body as { connector: unknown }).connector).toEqual(before);
        });
      }

      it('accepts the whole unchanged form plus a new name: 200, canEdit, no owner id', async () => {
        const h = await makeHarness();
        const { handlers, before } = await seedAndShow(h);
        currentActor = { id: 'admin2', isAdmin: true };
        const patched = makeRes();
        await handlers.update(
          makeReq({ params: { id: 'crm' }, body: { ...before, name: 'CRM (relabelled)', description: 'New words' } }),
          patched.res,
        );
        expect(patched.captured.status).toBe(200);
        const body = patched.captured.body as { connector: Record<string, unknown> };
        expect(body.connector).toMatchObject({
          name: 'CRM (relabelled)',
          description: 'New words',
          canEdit: true,
          capabilities: before.capabilities,
        });
        expect(body.connector).not.toHaveProperty('ownerUserId');
        expect(body).not.toHaveProperty('ownerUserId');
        expect(await rowOwners(h, 'crm')).toEqual(['admin1']);
      });

      // An OAuth slot stored WITHOUT `clientRegistration` /
      // `scopes` means the same as one carrying their defaults (a pinned
      // clientId → 'custom'; no scopes → []). Editors fill those in, so a
      // non-owner admin's rename must not read as a retarget. A real change of
      // either value still must.
      describe('OAuth slot defaults', () => {
        const oauthSlot = {
          slot: 'TOKEN',
          kind: 'oauth' as const,
          server: 'gdrive',
          clientId: 'pinned-client',
          authServerUrl: 'https://auth.example.com',
        };
        const oauthCrm = {
          ...crm,
          capabilities: { ...mcpCaps(), credentials: [oauthSlot] },
        };
        async function seedOAuth(h: TestHarness) {
          const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
          currentActor = { id: 'admin1', isAdmin: true };
          const created = makeRes();
          await handlers.create(makeReq({ body: oauthCrm }), created.res);
          expect(created.captured.status).toBe(201);
          const shown = makeRes();
          await handlers.show(makeReq({ params: { id: 'crm' } }), shown.res);
          const before = (shown.captured.body as { connector: { capabilities: Capabilities } })
            .connector;
          // Stored exactly as sent: neither field present.
          expect(before.capabilities.credentials[0]).not.toHaveProperty('clientRegistration');
          expect(before.capabilities.credentials[0]).not.toHaveProperty('scopes');
          return { handlers, before };
        }
        const withSlot = (before: { capabilities: Capabilities }, slot: Record<string, unknown>) => ({
          ...before.capabilities,
          credentials: [{ ...oauthSlot, ...slot }],
        });

        it('accepts a rename whose slot spells out the defaults: 200, renamed, owner unchanged', async () => {
          const h = await makeHarness();
          const { handlers, before } = await seedOAuth(h);
          currentActor = { id: 'admin2', isAdmin: true };
          const patched = makeRes();
          await handlers.update(
            makeReq({
              params: { id: 'crm' },
              body: {
                name: 'CRM (renamed)',
                keyMode: 'personal',
                capabilities: withSlot(before, { clientRegistration: 'custom', scopes: [] }),
              },
            }),
            patched.res,
          );
          expect(patched.captured.status).toBe(200);
          expect(patched.captured.body).toMatchObject({ connector: { name: 'CRM (renamed)' } });
          expect(await rowOwners(h, 'crm')).toEqual(['admin1']);
        });

        // The stored reach is what a non-owner admin's
        // save writes back, byte for byte; the body's (defaults-filled) copy
        // only decides whether to refuse.
        it('a 200 rename leaves capabilities byte-identical to the stored row, not the defaults-filled body', async () => {
          const h = await makeHarness();
          const { handlers, before } = await seedOAuth(h);
          currentActor = { id: 'admin2', isAdmin: true };
          const patched = makeRes();
          await handlers.update(
            makeReq({
              params: { id: 'crm' },
              body: {
                name: 'CRM (renamed)',
                capabilities: withSlot(before, { clientRegistration: 'custom', scopes: [] }),
              },
            }),
            patched.res,
          );
          expect(patched.captured.status).toBe(200);
          currentActor = { id: 'admin1', isAdmin: true };
          const after = makeRes();
          await handlers.show(makeReq({ params: { id: 'crm' } }), after.res);
          const stored = (after.captured.body as { connector: { name: string; capabilities: Capabilities } })
            .connector;
          expect(stored.name).toBe('CRM (renamed)');
          expect(stored.capabilities).toStrictEqual(before.capabilities);
          expect(stored.capabilities.credentials[0]).not.toHaveProperty('clientRegistration');
          expect(stored.capabilities.credentials[0]).not.toHaveProperty('scopes');
        });

        it('an empty pinned clientId: whatever the guard answers, the stored reach never changes', async () => {
          const h = await makeHarness();
          const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
          currentActor = { id: 'admin1', isAdmin: true };
          const emptyClient = { ...oauthSlot, clientId: '' };
          const created = makeRes();
          await handlers.create(
            makeReq({ body: { ...oauthCrm, capabilities: { ...mcpCaps(), credentials: [emptyClient] } } }),
            created.res,
          );
          expect(created.captured.status).toBe(201);
          const shown = makeRes();
          await handlers.show(makeReq({ params: { id: 'crm' } }), shown.res);
          const before = (shown.captured.body as { connector: { name: string; capabilities: Capabilities } })
            .connector;

          currentActor = { id: 'admin2', isAdmin: true };
          const patched = makeRes();
          await handlers.update(
            makeReq({
              params: { id: 'crm' },
              body: {
                name: 'CRM (renamed)',
                capabilities: {
                  ...before.capabilities,
                  credentials: [{ ...emptyClient, clientRegistration: 'custom' }],
                },
              },
            }),
            patched.res,
          );
          const status = patched.captured.status;
          expect([200, 403]).toContain(status);

          currentActor = { id: 'admin1', isAdmin: true };
          const after = makeRes();
          await handlers.show(makeReq({ params: { id: 'crm' } }), after.res);
          const stored = (after.captured.body as { connector: { name: string; capabilities: Capabilities } })
            .connector;
          expect(stored.capabilities).toStrictEqual(before.capabilities);
          expect(stored.name).toBe(status === 200 ? 'CRM (renamed)' : before.name);
          expect(await rowOwners(h, 'crm')).toEqual(['admin1']);
        });

        const realChanges: Array<[string, Record<string, unknown>]> = [
          ['adds a scope', { scopes: ['read'] }],
          ['changes clientRegistration away from its default', { clientRegistration: 'dcr' }],
          ['changes clientRegistration and leaves the rest default', { clientRegistration: 'auto', scopes: [] }],
          ['changes the clientId', { clientId: 'other-client' }],
        ];
        for (const [what, slot] of realChanges) {
          it(`refuses a rename that ${what}: 403 owner-only-change`, async () => {
            const h = await makeHarness();
            const { handlers, before } = await seedOAuth(h);
            currentActor = { id: 'admin2', isAdmin: true };
            const patched = makeRes();
            await handlers.update(
              makeReq({
                params: { id: 'crm' },
                body: { name: 'CRM (renamed)', capabilities: withSlot(before, slot) },
              }),
              patched.res,
            );
            expect(patched.captured).toMatchObject({
              status: 403,
              body: { error: 'owner-only-change' },
            });
            expect(await rowOwners(h, 'crm')).toEqual(['admin1']);
          });
        }
      });

      it('the owner may still change their own server url', async () => {
        const h = await makeHarness();
        const { handlers } = await seedAndShow(h);
        const patched = makeRes();
        await handlers.update(
          makeReq({ params: { id: 'crm' }, body: changes[0]![1] }),
          patched.res,
        );
        expect(patched.captured.status).toBe(200);
        expect(patched.captured.body).toMatchObject({
          connector: { capabilities: { mcpServers: [{ url: 'https://evil.example.com/mcp' }] } },
        });
      });
    });

    // A write body must be a JSON object. A primitive used to reach the
    // owner-only guard's `in` checks (500 on the cross-owner path) or get
    // spread into the row on the owner path; an array is no field map either.
    describe('a body that is not a JSON object is a 400, and writes nothing', () => {
      const bodies = ['"x"', '5', 'true', 'null', '[]', '["name"]'];
      for (const raw of bodies) {
        for (const who of ['owner', 'non-owner admin'] as const) {
          it(`PATCH ${raw} as the ${who}: 400`, async () => {
            const h = await makeHarness();
            const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
            currentActor = { id: 'admin1', isAdmin: true };
            await handlers.create(makeReq({ body: crm }), makeRes().res);
            const shown = makeRes();
            await handlers.show(makeReq({ params: { id: 'crm' } }), shown.res);
            const before = (shown.captured.body as { connector: unknown }).connector;

            currentActor = { id: who === 'owner' ? 'admin1' : 'admin2', isAdmin: true };
            const patched = makeRes();
            await handlers.update(makeReq({ params: { id: 'crm' }, body: raw }), patched.res);
            expect(patched.captured).toMatchObject({
              status: 400,
              body: { error: 'body must be a JSON object' },
            });

            currentActor = { id: 'admin1', isAdmin: true };
            const after = makeRes();
            await handlers.show(makeReq({ params: { id: 'crm' } }), after.res);
            expect((after.captured.body as { connector: unknown }).connector).toEqual(before);
            expect(await rowOwners(h, 'crm')).toEqual(['admin1']);
          });
        }
        it(`POST ${raw}: 400, nothing created`, async () => {
          const h = await makeHarness();
          const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
          currentActor = { id: 'admin1', isAdmin: true };
          const created = makeRes();
          await handlers.create(makeReq({ body: raw }), created.res);
          expect(created.captured).toMatchObject({
            status: 400,
            body: { error: 'body must be a JSON object' },
          });
          const listed = makeRes();
          await handlers.list(makeReq({}), listed.res);
          expect(listed.captured.body).toEqual({ connectors: [] });
        });
      }
    });

    // The PATCH route sets `updateOnly`, so a delete that lands between the
    // route's read and the write wins (404) instead of being undone. The seam:
    // `connectors:upsert` reads the prior row, then (for a non-OAuth server,
    // which `mcpCaps()` has) calls `tool-policy:set-ceiling-sources` BEFORE
    // `store.upsert`. A stub there soft-deletes the row, deterministically.
    describe('a delete racing a PATCH wins (updateOnly)', () => {
      for (const who of ['owner', 'non-owner admin'] as const) {
        it(`as the ${who}: 404, and the row stays deleted`, async () => {
          let armed = false;
          let fired = 0;
          const ceilingStub: Plugin = {
            manifest: {
              name: 'ceiling-stub',
              version: '0.0.0',
              registers: ['tool-policy:set-ceiling-sources'],
              calls: [],
              subscribes: [],
            },
            async init({ bus }) {
              bus.registerService('tool-policy:set-ceiling-sources', 'ceiling-stub', async () => {
                if (!armed) return {};
                armed = false;
                fired += 1;
                const pg = new (await import('pg')).default.Client({ connectionString });
                await pg.connect();
                try {
                  await pg.query(
                    "UPDATE connectors_v1_connectors SET deleted_at = now() WHERE connector_id = 'crm'",
                  );
                } finally {
                  await pg.end();
                }
                return {};
              });
            },
          };
          const h = await createTestHarness({
            plugins: [
              createDatabasePostgresPlugin({ connectionString }),
              authStubPlugin(),
              credentialsStubPlugin(),
              ceilingStub,
              createConnectorsPlugin(),
            ],
          });
          harnesses.push(h);
          const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
          currentActor = { id: 'admin1', isAdmin: true };
          const created = makeRes();
          await handlers.create(makeReq({ body: crm }), created.res);
          expect(created.captured.status).toBe(201);

          currentActor = { id: who === 'owner' ? 'admin1' : 'admin2', isAdmin: true };
          armed = true;
          const patched = makeRes();
          await handlers.update(
            makeReq({ params: { id: 'crm' }, body: { name: 'After the delete' } }),
            patched.res,
          );
          expect(fired).toBe(1);
          expect(patched.captured).toMatchObject({ status: 404, body: { error: 'not-found' } });
          expect(await rowOwners(h, 'crm')).toEqual([]);
          currentActor = { id: 'admin1', isAdmin: true };
          const shown = makeRes();
          await handlers.show(makeReq({ params: { id: 'crm' } }), shown.res);
          expect(shown.captured.status).toBe(404);
        });
      }
    });

    // What the admin editor (LegacyConnectorEditDialog) sends for an unchanged
    // connector with no MCP servers, plus a new name: the whole form, with
    // `capabilities` rebuilt from the form (channel-web's connector-form test
    // pins that this round trip reproduces the stored capabilities). A
    // non-owner admin's rename must not read as a retarget.
    const noServerCaps: Array<[string, Capabilities]> = [
      ['direct API', {
        allowedHosts: ['api.billing.example.com'],
        credentials: [{ slot: 'BILLING_KEY', kind: 'api-key', description: 'API key' }],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      }],
      ['command-line tool', {
        allowedHosts: ['registry.npmjs.org', 'api.billing.example.com'],
        credentials: [{ slot: 'BILLING_KEY', kind: 'api-key' }],
        mcpServers: [],
        packages: { npm: ['billing-cli'], pypi: [] },
      }],
    ];
    for (const [kind, capabilities] of noServerCaps) {
      it(`a non-owner admin renaming a ${kind} connector through the editor’s full-form body: 200`, async () => {
        const h = await makeHarness();
        const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
        const noServer = {
          connectorId: 'billing',
          name: 'Billing',
          description: 'Invoices.',
          usageNote: 'Read invoices.',
          keyMode: 'workspace',
          visibility: 'shared',
          capabilities,
        };
        currentActor = { id: 'admin1', isAdmin: true };
        const created = makeRes();
        await handlers.create(makeReq({ body: noServer }), created.res);
        expect(created.captured.status).toBe(201);
        const shown = makeRes();
        await handlers.show(makeReq({ params: { id: 'billing' } }), shown.res);
        const before = (shown.captured.body as { connector: { capabilities: Capabilities } }).connector;

        currentActor = { id: 'admin2', isAdmin: true };
        const patched = makeRes();
        await handlers.update(
          // The dialog's body shape: every field, no `services` key when there are none.
          makeReq({ params: { id: 'billing' }, body: { ...noServer, name: 'Billing (renamed)' } }),
          patched.res,
        );
        expect(patched.captured.status).toBe(200);
        currentActor = { id: 'admin1', isAdmin: true };
        const after = makeRes();
        await handlers.show(makeReq({ params: { id: 'billing' } }), after.res);
        const stored = (after.captured.body as { connector: { name: string; capabilities: Capabilities } })
          .connector;
        expect(stored.name).toBe('Billing (renamed)');
        expect(stored.capabilities).toStrictEqual(before.capabilities);
      });
    }

    it('same-id shared rows from two owners, none the admin’s: PATCH and DELETE 404 (fail closed)', async () => {
      const h = await makeHarness();
      for (const owner of ['ownerA', 'ownerB']) {
        await h.bus.call('connectors:upsert', h.ctx({ userId: owner }), {
          ...crm,
          userId: owner,
        });
      }
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'admin3', isAdmin: true };
      const patched = makeRes();
      await handlers.update(makeReq({ params: { id: 'crm' }, body: { name: 'X' } }), patched.res);
      expect(patched.captured.status).toBe(404);
      const deleted = makeRes();
      await handlers.destroy(makeReq({ params: { id: 'crm' } }), deleted.res);
      expect(deleted.captured.status).toBe(404);
      expect((await rowOwners(h, 'crm')).sort()).toEqual(['ownerA', 'ownerB']);
    });

    it('an edit never resurrects a connector deleted after it was read (updateOnly)', async () => {
      const h = await makeHarness();
      await h.bus.call('connectors:upsert', h.ctx({ userId: 'admin1' }), {
        ...crm,
        userId: 'admin1',
      });
      // The PATCH read happened; then the owner deletes; then the PATCH writes.
      await h.bus.call('connectors:delete', h.ctx({ userId: 'admin1' }), {
        userId: 'admin1',
        connectorId: 'crm',
        purgeGlobal: true,
      });
      await expect(
        h.bus.call('connectors:upsert', h.ctx({ userId: 'admin1' }), {
          ...crm,
          name: 'Late edit',
          userId: 'admin1',
          updateOnly: true,
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
      expect(await rowOwners(h, 'crm')).toEqual([]);

      // The store's own guard (the write itself is conditional on a live row),
      // which closes the window after the hook's pre-check.
      const { db } = await h.bus.call<unknown, { db: Kysely<ConnectorDatabase> }>(
        'database:get-instance',
        h.ctx(),
        {},
      );
      await expect(
        createConnectorStore(db).upsert({
          userId: 'admin1',
          connectorId: 'crm',
          name: 'Late edit',
          description: '',
          usageNote: '',
          keyMode: 'personal',
          visibility: 'shared',
          capabilities: mcpCaps(),
          updateOnly: true,
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
      expect(await rowOwners(h, 'crm')).toEqual([]);
    });
  });

  it('400 on invalid JSON body', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    const { res, captured } = makeRes();
    await handlers.create(makeReq({ body: '{ not json' }), res);
    expect(captured.status).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-json' });
  });

  it('413 on an oversized body', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    const big = 'x'.repeat(ADMIN_BODY_MAX_BYTES + 1);
    const { res, captured } = makeRes();
    await handlers.create(makeReq({ body: JSON.stringify({ pad: big }) }), res);
    expect(captured.status).toBe(413);
    expect(captured.body).toEqual({ error: 'body-too-large' });
  });

  it('400 on a malformed connector payload (bad keyMode)', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    const { res, captured } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'bad',
          name: 'Bad',
          keyMode: 'nonsense',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      res,
    );
    expect(captured.status).toBe(400);
  });

  describe('stdio MCP servers are rejected (invalid-payload -> 400)', () => {
    const STDIO_MSG =
      'Local (stdio) MCP servers are no longer supported. Use a remote MCP server URL.';
    function stdioCaps(): Capabilities {
      return {
        ...mcpCaps(),
        mcpServers: [
          { name: 'local', transport: 'stdio', command: 'mcp-local', args: [] },
        ],
      } as unknown as Capabilities;
    }

    it('POST create with a stdio mcpServer -> 400 carrying the message; nothing stored', async () => {
      const h = await makeHarness();
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'userA', isAdmin: true };
      const { res, captured } = makeRes();
      await handlers.create(
        makeReq({
          body: {
            connectorId: 'local',
            name: 'Local',
            keyMode: 'personal',
            visibility: 'private',
            capabilities: stdioCaps(),
          },
        }),
        res,
      );
      expect(captured.status).toBe(400);
      expect(JSON.stringify(captured.body)).toContain(STDIO_MSG);
      const { res: gRes, captured: gCap } = makeRes();
      await handlers.show(makeReq({ params: { id: 'local' } }), gRes);
      expect(gCap.status).toBe(404);
    });

    it('PATCH update to a stdio mcpServer -> 400 carrying the message; row unchanged', async () => {
      const h = await makeHarness();
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'userA', isAdmin: true };
      await handlers.create(
        makeReq({
          body: {
            connectorId: 'gdrive',
            name: 'Drive',
            keyMode: 'personal',
            visibility: 'private',
            capabilities: mcpCaps(),
          },
        }),
        makeRes().res,
      );
      const { res, captured } = makeRes();
      await handlers.update(
        makeReq({ params: { id: 'gdrive' }, body: { capabilities: stdioCaps() } }),
        res,
      );
      expect(captured.status).toBe(400);
      expect(JSON.stringify(captured.body)).toContain(STDIO_MSG);
      const { res: gRes, captured: gCap } = makeRes();
      await handlers.show(makeReq({ params: { id: 'gdrive' } }), gRes);
      expect(gCap.status).toBe(200);
      const servers = (gCap.body as { connector: { capabilities: Capabilities } }).connector
        .capabilities.mcpServers;
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/gdrive' });
    });
  });

  // --- connector Test probe (TASK-108) ------------------------------------
  //
  // POST /admin/connectors/:id/test → 200 { status, detail? } where status is
  // reachable | unreachable | needs-key. Probe = credential-slot presence (read
  // metadata-only via the stubbed credentials:list) + config sanity. NO outbound
  // connection is opened.

  async function seedConnector(
    handlers: ReturnType<typeof createAdminConnectorRouteHandlers>,
    body: Record<string, unknown>,
  ): Promise<void> {
    const { res, captured } = makeRes();
    await handlers.create(makeReq({ body }), res);
    if (captured.status !== 201 && captured.status !== 200) {
      throw new Error(`seed failed: ${captured.status} ${JSON.stringify(captured.body)}`);
    }
  }

  it('test: 401 when unauthenticated', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = null;
    const { res, captured } = makeRes();
    await handlers.test(makeReq({ params: { id: 'gdrive' } }), res);
    expect(captured.status).toBe(401);
  });

  it('test: 404 for a connector the actor does not own', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await seedConnector(handlers, {
      connectorId: 'gdrive',
      name: 'Google Drive',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: mcpCaps(),
    });
    // userB cannot probe userA's connector.
    currentActor = { id: 'userB', isAdmin: true };
    const { res, captured } = makeRes();
    await handlers.test(makeReq({ params: { id: 'gdrive' } }), res);
    expect(captured.status).toBe(404);
  });

  it('test: needs-key when a declared slot has no key in the vault', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await seedConnector(handlers, {
      connectorId: 'gdrive',
      name: 'Google Drive',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: mcpCaps(),
    });
    // No credential rows seeded ⟹ the `gdrive` slot is unfilled.
    const { res, captured } = makeRes();
    await handlers.test(makeReq({ params: { id: 'gdrive' } }), res);
    expect(captured.status).toBe(200);
    expect((captured.body as { status: string }).status).toBe('needs-key');
    expect((captured.body as { detail?: string }).detail).toContain('gdrive');
  });

  it('test: reachable when the personal slot is filled in the actor vault', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await seedConnector(handlers, {
      connectorId: 'gdrive',
      name: 'Google Drive',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: mcpCaps(),
    });
    // The connector owns its own key: the ref is account:<connectorId>
    // (account:gdrive) — the slot's legacy account tag is ignored. A personal
    // connector resolves it at scope:'user' under the actor's id.
    credentialRows = [{ scope: 'user', ownerId: 'userA', ref: 'account:gdrive' }];
    const { res, captured } = makeRes();
    await handlers.test(makeReq({ params: { id: 'gdrive' } }), res);
    expect(captured.status).toBe(200);
    expect((captured.body as { status: string }).status).toBe('reachable');
  });

  it('test: a workspace connector resolves its slot at scope:global (ownerId:null)', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await seedConnector(handlers, {
      connectorId: 'gdrive',
      name: 'Google Drive',
      keyMode: 'workspace',
      visibility: 'private',
      capabilities: mcpCaps(),
    });
    // A user-scoped row under the actor must NOT satisfy a workspace slot — the
    // workspace key lives at scope:'global' / ownerId:null. Ref is account:gdrive.
    credentialRows = [{ scope: 'user', ownerId: 'userA', ref: 'account:gdrive' }];
    const { res: r1, captured: c1 } = makeRes();
    await handlers.test(makeReq({ params: { id: 'gdrive' } }), r1);
    expect((c1.body as { status: string }).status).toBe('needs-key');
    // Seed the global key → now reachable.
    credentialRows = [{ scope: 'global', ownerId: null, ref: 'account:gdrive' }];
    const { res: r2, captured: c2 } = makeRes();
    await handlers.test(makeReq({ params: { id: 'gdrive' } }), r2);
    expect((c2.body as { status: string }).status).toBe('reachable');
  });

  it('test: reachable for a slotless CLI/package connector (no key required)', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await seedConnector(handlers, {
      connectorId: 'sf',
      name: 'Salesforce',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: {
        allowedHosts: ['login.salesforce.com'],
        credentials: [],
        mcpServers: [],
        packages: { npm: ['@salesforce/cli'], pypi: [] },
      },
    });
    const { res, captured } = makeRes();
    await handlers.test(makeReq({ params: { id: 'sf' } }), res);
    expect(captured.status).toBe(200);
    expect((captured.body as { status: string }).status).toBe('reachable');
  });

  it('test: unreachable when an MCP-backed connector has no url', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await seedConnector(handlers, {
      connectorId: 'broken',
      name: 'Broken MCP',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: {
        allowedHosts: [],
        credentials: [],
        mcpServers: [
          {
            name: 'broken',
            transport: 'http',
            allowedHosts: [],
            credentials: [],
          },
        ],
        packages: { npm: [], pypi: [] },
      },
    });
    const { res, captured } = makeRes();
    await handlers.test(makeReq({ params: { id: 'broken' } }), res);
    expect(captured.status).toBe(200);
    expect((captured.body as { status: string }).status).toBe('unreachable');
  });

  it('test: unreachable when the credential read fails (conservative — never a false reachable)', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'userA', isAdmin: true };
    await seedConnector(handlers, {
      connectorId: 'gdrive',
      name: 'Google Drive',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: mcpCaps(),
    });
    credentialsListThrows = true;
    const { res, captured } = makeRes();
    await handlers.test(makeReq({ params: { id: 'gdrive' } }), res);
    expect(captured.status).toBe(200);
    expect((captured.body as { status: string }).status).toBe('unreachable');
  });
});

// ---------------------------------------------------------------------------
// User-authoring routes — GET/POST /settings/connectors,
// GET/PATCH/DELETE /settings/connectors/:id (TASK-129, mode:'user').
//
// Same owner-scoped bridge as the admin routes, but the write policy is locked
// down: admin-only fields (keyMode:workspace) are REJECTED (400 — not silently
// dropped), and a
// catalog/shared connector is READ-ONLY (editing/deleting it 403s). These are
// SERVER-SIDE policy proofs — never UI-only — driven against the same real
// connector store via the duck-typed req/res.
// ---------------------------------------------------------------------------

describe('user connector routes (/settings/connectors)', () => {
  /** Seed a connector directly through the ADMIN route so we can construct a
   *  catalog/shared row a user must NOT be able to edit (the user route can't
   *  create one — that's the point of these tests). */
  async function adminSeed(
    bus: TestHarness['bus'],
    body: Record<string, unknown>,
  ): Promise<void> {
    const handlers = createAdminConnectorRouteHandlers({ bus });
    const { res, captured } = makeRes();
    await handlers.create(makeReq({ body }), res);
    if (captured.status !== 201 && captured.status !== 200) {
      throw new Error(
        `admin seed failed: ${captured.status} ${JSON.stringify(captured.body)}`,
      );
    }
  }

  it('401 when unauthenticated', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = null;
    const { res, captured } = makeRes();
    await handlers.list(makeReq({}), res);
    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
  });

  // Slice 2a: the `/settings/connectors` bundle is READS only. These pin that
  // its WRITE handlers (never routed) also refuse a non-admin, so wiring one up
  // by mistake could not reopen non-admin authoring.
  it('a non-admin on the user bundle: every write handler 403s, and nothing is stored or purged', async () => {
    const h = await makeHarness();
    currentActor = { id: 'admin-own', isAdmin: true };
    await adminSeed(h.bus, {
      connectorId: 'user-bundle-shared',
      name: 'Shared',
      keyMode: 'workspace',
      visibility: 'shared',
      capabilities: mcpCaps(),
    });
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'plain-user', isAdmin: false };
    const body = { connectorId: 'plain-new', name: 'Mine', keyMode: 'personal', capabilities: mcpCaps() };
    const results = [
      (r: ReturnType<typeof makeRes>) => handlers.create(makeReq({ body }), r.res),
      (r: ReturnType<typeof makeRes>) => handlers.update(makeReq({ params: { id: 'user-bundle-shared' }, body: { name: 'x' } }), r.res),
      (r: ReturnType<typeof makeRes>) => handlers.destroy(makeReq({ params: { id: 'user-bundle-shared' } }), r.res),
      (r: ReturnType<typeof makeRes>) => handlers.setToolPermissions(makeReq({ params: { id: 'user-bundle-shared' }, body: { verdicts: [] } }), r.res),
    ];
    for (const run of results) {
      const r = makeRes();
      await run(r);
      expect(r.captured.status).toBe(403);
      expect(r.captured.body).toEqual({ error: 'forbidden' });
    }
    const list = makeRes();
    await handlers.list(makeReq({}), list.res);
    expect((list.captured.body as { connectors: Array<{ id: string }> }).connectors.map((c) => c.id)).toEqual([
      'user-bundle-shared',
    ]);
  });

  it('a shared connector is readable, never editable, for another user on the user bundle (reads)', async () => {
    const h = await makeHarness();
    currentActor = { id: 'author', isAdmin: true };
    await adminSeed(h.bus, {
      connectorId: 'shared-personal', name: 'Shared', keyMode: 'personal',
      visibility: 'shared', capabilities: mcpCaps(),
    });
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'reader', isAdmin: false };
    const list = makeRes();
    await handlers.list(makeReq({}), list.res);
    expect(list.captured.body).toMatchObject({ connectors: [{ id: 'shared-personal', canEdit: false }] });
    const shown = makeRes();
    await handlers.show(makeReq({ params: { id: 'shared-personal' } }), shown.res);
    expect(shown.captured.status).toBe(200);
    expect(shown.captured.body).toMatchObject({ connector: { name: 'Shared', canEdit: false } });
    expect((shown.captured.body as { connector: object }).connector).not.toHaveProperty('ownerUserId');
  });

  it('admin create defaults to shared; editing and POST upserts preserve the saved visibility and key mode', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'root', isAdmin: true };
    const fresh = makeRes();
    await handlers.create(makeReq({ body: { connectorId: 'fresh', name: 'Fresh', keyMode: 'personal', capabilities: mcpCaps() } }), fresh.res);
    expect(fresh.captured.body).toMatchObject({ connector: { visibility: 'shared' } });
    await handlers.create(makeReq({ body: { connectorId: 'legacy', name: 'Legacy', keyMode: 'workspace', visibility: 'private', capabilities: mcpCaps() } }), makeRes().res);
    const patch = makeRes();
    await handlers.update(makeReq({ params: { id: 'legacy' }, body: { name: 'Edited' } }), patch.res);
    expect(patch.captured.body).toMatchObject({ connector: { visibility: 'private', keyMode: 'workspace' } });
    const post = makeRes();
    await handlers.create(makeReq({ body: { connectorId: 'legacy', name: 'Upserted', keyMode: 'workspace', capabilities: mcpCaps() } }), post.res);
    expect(post.captured.body).toMatchObject({ connector: { visibility: 'private', keyMode: 'workspace' } });
  });

  // TASK-808 — "Set default" is gone. A stale client that still sends the field
  // fails LOUDLY (400) instead of being silently dropped, for ONE release, on
  // every admin write route, whatever the value (it no longer means
  // anything, so `false` is as stale as `true`). Nothing is stored.
  describe('defaultAttached is rejected (TASK-808)', () => {
    const MESSAGE = 'defaultAttached is no longer supported';

    for (const mode of ['admin'] as const) {
      for (const value of [true, false, null, 'yes']) {
        it(`${mode} POST with defaultAttached: ${JSON.stringify(value)} -> 400 and nothing is stored`, async () => {
          const h = await makeHarness();
          const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
          currentActor = { id: 'userU', isAdmin: true };
          const { res, captured } = makeRes();
          await handlers.create(
            makeReq({
              body: {
                connectorId: 'stale',
                name: 'Stale client',
                keyMode: 'personal',
                visibility: 'private',
                defaultAttached: value,
                capabilities: mcpCaps(),
              },
            }),
            res,
          );
          expect(captured.status).toBe(400);
          expect((captured.body as { error: string }).error).toContain(MESSAGE);
          const list = makeRes();
          await handlers.list(makeReq({}), list.res);
          expect(list.captured.body).toEqual({ connectors: [] });
        });

        it(`${mode} PATCH with defaultAttached: ${JSON.stringify(value)} -> 400 and the connector is unchanged`, async () => {
          const h = await makeHarness();
          const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
          currentActor = { id: 'userU', isAdmin: true };
          await handlers.create(
            makeReq({ body: { connectorId: 'kept', name: 'Kept', keyMode: 'personal', visibility: 'private', capabilities: mcpCaps() } }),
            makeRes().res,
          );
          const { res, captured } = makeRes();
          await handlers.update(
            makeReq({ params: { id: 'kept' }, body: { name: 'Renamed', defaultAttached: value } }),
            res,
          );
          expect(captured.status).toBe(400);
          expect((captured.body as { error: string }).error).toContain(MESSAGE);
          const shown = makeRes();
          await handlers.show(makeReq({ params: { id: 'kept' } }), shown.res);
          expect(shown.captured.body).toMatchObject({ connector: { name: 'Kept' } });
        });
      }
    }

    it('the message tells the person what to do instead', async () => {
      const h = await makeHarness();
      const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
      currentActor = { id: 'root', isAdmin: true };
      const { res, captured } = makeRes();
      await handlers.create(
        makeReq({ body: { connectorId: 'x', name: 'X', keyMode: 'personal', defaultAttached: true, capabilities: mcpCaps() } }),
        res,
      );
      expect(captured.status).toBe(400);
      expect((captured.body as { error: string }).error).toMatch(/add connectors to each agent/i);
    });
  });

  it('an admin deleting ANOTHER admin’s shared connector still purges its state (owner-keyed, purgeGlobal)', async () => {
    const deleteCalls: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
    const h = await createTestHarness({
      services: {
        'credentials:delete': async (_c, input) => {
          deleteCalls.push(input as (typeof deleteCalls)[number]);
        },
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        authStubPlugin(),
        credentialsStubPlugin(),
        createConnectorsPlugin(),
      ],
    });
    harnesses.push(h);
    const adminHandlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'admin' });
    currentActor = { id: 'admin1', isAdmin: true };
    const created = makeRes();
    await adminHandlers.create(makeReq({ body: {
      connectorId: 'ws-shared', name: 'Workspace svc', keyMode: 'workspace',
      visibility: 'shared', capabilities: mcpCaps(),
    } }), created.res);
    expect(created.captured.status).toBe(201);

    currentActor = { id: 'admin2', isAdmin: true };
    const deleted = makeRes();
    await adminHandlers.destroy(makeReq({ params: { id: 'ws-shared' } }), deleted.res);
    expect(deleted.captured.status).toBe(204);
    expect(deleteCalls).toEqual([
      { scope: 'global', ownerId: null, ref: 'account:ws-shared' },
    ]);
  });

});

// ---------------------------------------------------------------------------
// Slice 2c — agent proposals go to admins. GET /admin/connectors/authored lists
// every person's pending proposals (labelled with who asked, via
// `auth:get-user`, fail-soft to the id); DELETE /admin/connectors/authored/:id
// is Dismiss (clears that id for everyone). There is no approve route: an
// admin approves by creating the connector (POST /admin/connectors), and
// creation clears the proposals.
// ---------------------------------------------------------------------------
describe('admin proposal routes (/admin/connectors/authored)', () => {
  // auth:get-user behaviour per user id: a user record, null, or a throw.
  let users: Record<string, { displayName: string | null; email: string | null } | null | 'throw'>;

  async function makeProposalHarness(): Promise<TestHarness> {
    users = {};
    const h = await createTestHarness({
      services: {
        'auth:get-user': async (_ctx, input: unknown) => {
          const id = (input as { userId: string }).userId;
          const u = users[id];
          if (u === 'throw') throw new Error('auth down');
          if (u === undefined || u === null) return null;
          return { id, isAdmin: false, ...u };
        },
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        authStubPlugin(),
        credentialsStubPlugin(),
        createConnectorsPlugin(),
      ],
    });
    harnesses.push(h);
    return h;
  }

  async function propose(
    h: TestHarness,
    over: { userId: string; agentId: string; connectorId: string; name?: string },
  ): Promise<void> {
    await h.bus.call('connectors:install-authored', h.ctx({ userId: over.userId }), {
      ownerUserId: over.userId,
      agentId: over.agentId,
      connectorId: over.connectorId,
      name: over.name ?? over.connectorId,
      hosts: ['api.linear.app'],
      slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
      usageNote: 'Track issues',
      keyMode: 'personal',
    });
  }

  type Listed = {
    drafts: Array<{
      connectorId: string;
      name: string;
      usageNote: string;
      keyMode: string;
      proposal: Capabilities;
      updatedAt: string;
      proposedBy: { userId: string; label: string };
    }>;
  };

  async function list(h: TestHarness): Promise<Listed['drafts']> {
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'root', isAdmin: true };
    const { res, captured } = makeRes();
    await handlers.listAuthoredProposals(makeReq({}), res);
    expect(captured.status).toBe(200);
    return (captured.body as Listed).drafts;
  }

  it('GET lists every proposer’s pending requests, labelled with who asked', async () => {
    const h = await makeProposalHarness();
    users = {
      alice: { displayName: 'Alice Doe', email: 'alice@example.com' },
      bob: { displayName: null, email: 'bob@example.com' },
    };
    await propose(h, { userId: 'alice', agentId: 'a1', connectorId: 'linear', name: 'Linear' });
    await propose(h, { userId: 'bob', agentId: 'b1', connectorId: 'linear', name: 'Linear please' });
    await propose(h, { userId: 'bob', agentId: 'b1', connectorId: 'notion', name: 'Notion' });

    const drafts = await list(h);
    expect(drafts.map((d) => [d.connectorId, d.name, d.proposedBy])).toEqual([
      ['linear', 'Linear', { userId: 'alice', label: 'Alice Doe' }],
      ['linear', 'Linear please', { userId: 'bob', label: 'bob@example.com' }],
      ['notion', 'Notion', { userId: 'bob', label: 'bob@example.com' }],
    ]);
    expect(drafts[0]).toMatchObject({ usageNote: 'Track issues', keyMode: 'personal' });
    expect(drafts[0]!.proposal.allowedHosts).toEqual(['api.linear.app']);
    // The agent is not named, and no agent id leaves the host.
    expect(drafts[0]).not.toHaveProperty('agentId');
  });

  it('one row per person per id, however many of their agents asked', async () => {
    const h = await makeProposalHarness();
    users = { alice: { displayName: 'Alice', email: null } };
    await propose(h, { userId: 'alice', agentId: 'a1', connectorId: 'linear' });
    await propose(h, { userId: 'alice', agentId: 'a2', connectorId: 'linear' });
    expect((await list(h)).map((d) => d.proposedBy.label)).toEqual(['Alice']);
  });

  it('the proposer label fails soft to the user id when the lookup returns null or throws', async () => {
    const h = await makeProposalHarness();
    users = { ghost: null, flaky: 'throw' };
    await propose(h, { userId: 'ghost', agentId: 'g1', connectorId: 'gmail' });
    await propose(h, { userId: 'flaky', agentId: 'f1', connectorId: 'linear' });
    const drafts = await list(h);
    expect(drafts.map((d) => d.proposedBy)).toEqual([
      { userId: 'ghost', label: 'ghost' },
      { userId: 'flaky', label: 'flaky' },
    ]);
  });

  it('GET and DELETE are admin-only (401 signed out, 403 non-admin)', async () => {
    const h = await makeProposalHarness();
    await propose(h, { userId: 'alice', agentId: 'a1', connectorId: 'linear' });
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    for (const actor of [null, { id: 'alice', isAdmin: false }]) {
      currentActor = actor;
      const g = makeRes();
      await handlers.listAuthoredProposals(makeReq({}), g.res);
      expect(g.captured.status).toBe(actor === null ? 401 : 403);
      const d = makeRes();
      await handlers.dismissAuthoredProposal(makeReq({ params: { connectorId: 'linear' } }), d.res);
      expect(d.captured.status).toBe(actor === null ? 401 : 403);
    }
    // Nothing was dismissed.
    expect(await list(h)).toHaveLength(1);
  });

  it('DELETE dismisses the request for everyone who asked (204), and is idempotent', async () => {
    const h = await makeProposalHarness();
    await propose(h, { userId: 'alice', agentId: 'a1', connectorId: 'linear' });
    await propose(h, { userId: 'bob', agentId: 'b1', connectorId: 'linear' });
    await propose(h, { userId: 'bob', agentId: 'b1', connectorId: 'notion' });
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'root', isAdmin: true };
    const first = makeRes();
    await handlers.dismissAuthoredProposal(makeReq({ params: { connectorId: 'linear' } }), first.res);
    expect(first.captured.status).toBe(204);
    expect(first.captured.ended).toBe(true);
    expect((await list(h)).map((d) => d.connectorId)).toEqual(['notion']);
    const again = makeRes();
    await handlers.dismissAuthoredProposal(makeReq({ params: { connectorId: 'linear' } }), again.res);
    expect(again.captured.status).toBe(204);
  });

  it('DELETE 400 on a malformed id', async () => {
    const h = await makeProposalHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'root', isAdmin: true };
    const { res, captured } = makeRes();
    await handlers.dismissAuthoredProposal(makeReq({ params: { connectorId: 'Bad Id!' } }), res);
    expect(captured.status).toBe(400);
  });

  it('POST /admin/connectors creating the id clears both proposers’ requests; an edit does not', async () => {
    const h = await makeProposalHarness();
    await propose(h, { userId: 'alice', agentId: 'a1', connectorId: 'gdrive' });
    await propose(h, { userId: 'bob', agentId: 'b1', connectorId: 'gdrive' });
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'root', isAdmin: true };
    const body = { connectorId: 'gdrive', name: 'Drive', keyMode: 'personal', capabilities: mcpCaps() };
    const created = makeRes();
    await handlers.create(makeReq({ body }), created.res);
    expect(created.captured.status).toBe(201);
    expect(await list(h)).toEqual([]);

    // A request that arrives behind the dedup (drift) survives an edit.
    const pg = new (await import('pg')).default.Client({ connectionString });
    await pg.connect();
    try {
      await pg.query(
        `INSERT INTO connectors_v1_authored (owner_user_id, agent_id, connector_id, name, usage_note, key_mode, capability_proposal, status)
         VALUES ('carol', 'c1', 'gdrive', 'Drive', '', 'personal', '{"allowedHosts":[],"credentials":[],"mcpServers":[],"packages":{"npm":[],"pypi":[]}}'::jsonb, 'pending')`,
      );
    } finally {
      await pg.end();
    }
    currentActor = { id: 'root', isAdmin: true };
    const edited = makeRes();
    await handlers.create(makeReq({ body: { ...body, name: 'Drive (renamed)' } }), edited.res);
    expect(edited.captured.status).toBe(200);
    // The queue drops it (the id is live), but the row itself was not cleared.
    const rows = await h.bus.call<{ ownerUserId: string; agentId: string }, { drafts: unknown[] }>(
      'connectors:list-authored', h.ctx({ userId: 'carol' }), { ownerUserId: 'carol', agentId: 'c1' },
    );
    expect(rows.drafts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TASK-712 — an OAuth slot's `clientSecretRef` may name only THIS connector's own
// account key (`account:<connectorId>:<tag>`).
//
// The ref is author-controlled and @ax/mcp-oauth's `begin` resolves it with
// `credentials:get`, then posts the value to a token endpoint the same author chose.
// Any signed-in user can author a connector, so `provider:anthropic` (the operator's
// model key) or an env-fallback name would have been an exfiltration channel. It was
// only closed on main by an accident in `begin`'s ctx; this is the authoring half of
// the real control (mcp-oauth re-checks at `begin`).
//
// Enforced at `connectors:upsert`, so it binds the user route, the admin route, the
// PATCH merge and the model-authored approve path alike. NOT enforced on READ: a row
// stored before this check must stay openable so its owner can fix it.
// ---------------------------------------------------------------------------
describe('oauth clientSecretRef is the connector’s own account key (TASK-712)', () => {
  function oauthCaps(clientSecretRef?: string): Record<string, unknown> {
    return {
      allowedHosts: ['mcp.example.com', 'auth.example.com'],
      credentials: [
        {
          slot: 'oauth-main',
          kind: 'oauth',
          server: 'srv',
          scopes: ['read'],
          clientId: 'client-a',
          ...(clientSecretRef !== undefined ? { clientSecretRef } : {}),
          authServerUrl: 'https://auth.example.com',
        },
      ],
      mcpServers: [
        {
          name: 'srv',
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          allowedHosts: ['mcp.example.com'],
          credentials: [],
        },
      ],
      packages: { npm: [], pypi: [] },
    };
  }

  const create = (id: string, clientSecretRef?: string, keyMode = 'personal') => ({
    connectorId: id,
    name: id,
    keyMode,
    visibility: 'private',
    capabilities: oauthCaps(clientSecretRef),
  });

  /** Everything a non-admin could name that is NOT their own connector's account key. */
  const FOREIGN_REFS = [
    'provider:anthropic', // the operator's model key: the onboarding wizard's ref
    'provider:probe',
    'mcp:srv:env:API_KEY',
    'skill:some-skill:SLOT',
    'anthropic-api', // an env-fallback name as wired in the k8s preset
    'account:opskey', // someone else's company key
    'account:zendesk:oauth-client-secret',
    'account:mine-x:oauth-client-secret', // another connector of ours
    'account:mine', // our own TOKEN ref: bare, never a client secret
    'account:mine:a:b',
  ];

  it.each(FOREIGN_REFS)('admin route POST refuses %j (400) and stores nothing', async (ref) => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'mallory-712', isAdmin: true };
    const { res, captured } = makeRes();
    await handlers.create(makeReq({ body: create('mine', ref) }), res);
    expect(captured.status).toBe(400);
    // A fixed message naming the slot and the allowed shape: the rejected ref (author
    // text, possibly a pasted credential) is not echoed back.
    expect(captured.body).toEqual({
      error:
        "oauth slot 'oauth-main': clientSecretRef must be this connector's own account key, 'account:mine:<name>'",
    });
    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'mine' } }), gRes);
    expect(gCap.status).toBe(404);
  });

  it('admin route POST accepts the connector’s own ref and it round-trips', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'own-712', isAdmin: true };
    const own = 'account:mine:oauth-client-secret';
    const { res, captured } = makeRes();
    await handlers.create(makeReq({ body: create('mine', own) }), res);
    expect(captured.status).toBe(201);
    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'mine' } }), gRes);
    const slot = (
      gCap.body as { connector: { capabilities: { credentials: Array<Record<string, unknown>> } } }
    ).connector.capabilities.credentials[0]!;
    expect(slot.clientSecretRef).toBe(own);
  });

  it('a connector without a clientSecretRef (DCR) is unaffected', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'dcr-712', isAdmin: true };
    const { res, captured } = makeRes();
    await handlers.create(makeReq({ body: create('mine') }), res);
    expect(captured.status).toBe(201);
  });

  it('admin route PATCH cannot introduce a foreign ref; the stored row is untouched', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'patch-712', isAdmin: true };
    const own = 'account:mine:oauth-client-secret';
    const { res: cRes, captured: cCap } = makeRes();
    await handlers.create(makeReq({ body: create('mine', own) }), cRes);
    expect(cCap.status).toBe(201);

    const { res, captured } = makeRes();
    await handlers.update(
      makeReq({
        params: { id: 'mine' },
        body: { capabilities: oauthCaps('provider:anthropic') },
      }),
      res,
    );
    expect(captured.status).toBe(400);
    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'mine' } }), gRes);
    const slot = (
      gCap.body as { connector: { capabilities: { credentials: Array<Record<string, unknown>> } } }
    ).connector.capabilities.credentials[0]!;
    expect(slot.clientSecretRef).toBe(own);
  });

  it('the admin route enforces it too (an admin’s connector is not a different rule)', async () => {
    const h = await makeHarness();
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'admin-712', isAdmin: true };
    for (const [ref, status] of [
      ['provider:anthropic', 400],
      ['account:opskey', 400],
      ['account:ws:oauth-client-secret', 201],
    ] as const) {
      const { res, captured } = makeRes();
      await handlers.create(makeReq({ body: create('ws', ref, 'workspace') }), res);
      expect(captured.status).toBe(status);
    }
  });

  it('the connectors:upsert hook itself refuses a foreign ref, wherever the call comes from', async () => {
    // The model-authored approve path and the skill-capability migration call the
    // hook directly, with no route in front of them.
    const h = await makeHarness();
    await expect(
      h.bus.call('connectors:upsert', h.ctx({ userId: 'hook-712' }), {
        userId: 'hook-712',
        connectorId: 'mine',
        name: 'mine',
        keyMode: 'personal',
        visibility: 'private',
        capabilities: oauthCaps('provider:anthropic'),
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('a row stored BEFORE this check stays readable, and its owner can fix it', async () => {
    // Write-time only, on purpose: were this a refine in CapabilitiesSchema (which
    // also parses on read), an existing row with a foreign ref would fail to load
    // and its owner could not even open it. @ax/mcp-oauth refuses it at `begin`.
    const h = await makeHarness();
    const { db } = await h.bus.call<unknown, { db: Kysely<ConnectorDatabase> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const legacyCaps = oauthCaps('provider:anthropic') as unknown as Capabilities;
    await createConnectorStore(db).upsert({
      userId: 'legacy-712',
      connectorId: 'mine',
      name: 'mine',
      description: '',
      usageNote: '',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: legacyCaps,
    });

    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    currentActor = { id: 'legacy-712', isAdmin: true };
    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'mine' } }), gRes);
    expect(gCap.status).toBe(200);
    const { res: lRes, captured: lCap } = makeRes();
    await handlers.list(makeReq({}), lRes);
    expect(lCap.status).toBe(200);

    // Re-saving it as-is is refused (it would re-store the foreign ref)...
    const { res: sRes, captured: sCap } = makeRes();
    await handlers.update(makeReq({ params: { id: 'mine' }, body: { name: 'renamed' } }), sRes);
    expect(sCap.status).toBe(400);
    // ...and pointing it at its own key repairs it.
    const { res: fRes, captured: fCap } = makeRes();
    await handlers.update(
      makeReq({
        params: { id: 'mine' },
        body: { capabilities: oauthCaps('account:mine:oauth-client-secret') },
      }),
      fRes,
    );
    expect(fCap.status).toBe(200);
  });
});
