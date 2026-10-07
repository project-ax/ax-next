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

  it('POST ignores a client-supplied requireUniqueId (no existence probe of other owners\' private ids)', async () => {
    const h = await makeHarness();
    currentActor = { id: 'admin1', isAdmin: true };
    await adminSeed(h.bus, {
      connectorId: 'x',
      name: 'X',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: mcpCaps(),
    });
    currentActor = { id: 'plainUser', isAdmin: false };
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    const { res, captured } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'x',
          name: 'X',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: mcpCaps(),
          requireUniqueId: true,
        },
      }),
      res,
    );
    expect(captured.status).toBe(201);
  });

  it('POST defaults a new connector to shared and requiring explicit attachment', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'mine',
          name: 'My connector',
          keyMode: 'personal',
          // No visibility supplied — new definitions default to shared.
          capabilities: mcpCaps(),
        },
      }),
      res,
    );
    expect(captured.status).toBe(201);
    const connector = (captured.body as { connector: { visibility: string } })
      .connector;
    expect(connector.visibility).toBe('shared');
    // TASK-808 — the workspace-default flag is gone from the connector shape.
    expect(connector).not.toHaveProperty('defaultAttached');
  });

  it('a shared personal connector supports owner edits and is read-only for other users', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'author', isAdmin: false };
    const created = makeRes();
    await handlers.create(makeReq({ body: {
      connectorId: 'shared-personal', name: 'Shared', keyMode: 'personal',
      visibility: 'shared', capabilities: mcpCaps(),
    } }), created.res);
    expect(created.captured.status).toBe(201);
    const edited = makeRes();
    await handlers.update(makeReq({ params: { id: 'shared-personal' }, body: { name: 'Updated', requiresAttachment: false } }), edited.res);
    expect(edited.captured.status).toBe(200);
    expect(edited.captured.body).toMatchObject({ connector: { visibility: 'shared', requiresAttachment: true } });
    expect((edited.captured.body as { connector: object }).connector).not.toHaveProperty('defaultAttached');

    currentActor = { id: 'reader', isAdmin: false };
    const list = makeRes();
    await handlers.list(makeReq({}), list.res);
    expect(list.captured.body).toMatchObject({ connectors: [{ id: 'shared-personal', canEdit: false }] });
    const shown = makeRes();
    await handlers.show(makeReq({ params: { id: 'shared-personal' } }), shown.res);
    expect(shown.captured.status).toBe(200);
    expect(shown.captured.body).toMatchObject({ connector: { name: 'Updated', canEdit: false } });
    const patch = makeRes();
    await handlers.update(makeReq({ params: { id: 'shared-personal' }, body: { name: 'Hijack', canEdit: true } }), patch.res);
    expect(patch.captured.status).toBe(403);
    const post = makeRes();
    await handlers.create(makeReq({ body: { connectorId: 'shared-personal', name: 'Hijack', keyMode: 'personal', capabilities: mcpCaps(), canEdit: true } }), post.res);
    expect(post.captured.status).toBe(403);
    const del = makeRes();
    await handlers.destroy(makeReq({ params: { id: 'shared-personal' } }), del.res);
    expect(del.captured.status).toBe(403);

    // An admin, on the ADMIN surface, may edit any shared connector (slice 2a).
    currentActor = { id: 'reader', isAdmin: true };
    const adminHandlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    const adminPatch = makeRes();
    await adminHandlers.update(makeReq({ params: { id: 'shared-personal' }, body: { name: 'Curated' } }), adminPatch.res);
    expect(adminPatch.captured.status).toBe(200);

    currentActor = { id: 'author', isAdmin: false };
    const ownDelete = makeRes();
    await handlers.destroy(makeReq({ params: { id: 'shared-personal' } }), ownDelete.res);
    expect(ownDelete.captured.status).toBe(204);
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
  // every write route, in both modes, whatever the value (it no longer means
  // anything, so `false` is as stale as `true`). Nothing is stored.
  describe('defaultAttached is rejected (TASK-808)', () => {
    const MESSAGE = 'defaultAttached is no longer supported';

    for (const mode of ['admin', 'user'] as const) {
      for (const value of [true, false, null, 'yes']) {
        it(`${mode} POST with defaultAttached: ${JSON.stringify(value)} -> 400 and nothing is stored`, async () => {
          const h = await makeHarness();
          const handlers = mode === 'admin'
            ? createAdminConnectorRouteHandlers({ bus: h.bus })
            : createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
          currentActor = { id: 'userU', isAdmin: mode === 'admin' };
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
          const handlers = mode === 'admin'
            ? createAdminConnectorRouteHandlers({ bus: h.bus })
            : createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
          currentActor = { id: 'userU', isAdmin: mode === 'admin' };
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

  it('POST rejects keyMode:workspace (admin-only) — a non-admin must never own a workspace (global-keyed) connector', async () => {
    // SECURITY (purge-on-delete): a workspace connector derives a GLOBAL credential
    // ref (account:<id>, owner-independent). If a non-admin could own one, deleting
    // it would tombstone the SHARED company key. The global credential WRITE is
    // admin-gated (/admin/destinations); the connector that drives the global purge
    // must be too. So the user route rejects keyMode:workspace.
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'company-sf',
          name: 'Salesforce',
          keyMode: 'workspace',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      res,
    );
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain('admin-only');
    // It must NOT have landed — the GET 404s, so there is no workspace connector
    // for the non-admin to later delete (and thus no global purge they can trigger).
    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'company-sf' } }), gRes);
    expect(gCap.status).toBe(404);
  });

  it('PATCH cannot flip an owned private connector to keyMode:workspace (admin-only)', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'userFlipWs', isAdmin: false };
    // Seed an owned PRIVATE personal connector (unique id — the container persists
    // rows across this file's tests).
    const { res: cRes, captured: cCap } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'flip-to-ws',
          name: 'Flip',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      cRes,
    );
    expect(cCap.status).toBe(201);
    // Attempt to flip it to workspace via PATCH → rejected.
    const { res, captured } = makeRes();
    await handlers.update(
      makeReq({ params: { id: 'flip-to-ws' }, body: { keyMode: 'workspace' } }),
      res,
    );
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain('admin-only');
  });

  it('destroy passes purgeGlobal=actor.isAdmin: an admin purges the GLOBAL key, a non-admin does not', async () => {
    // Defense at the dangerous primitive: even if a non-admin somehow OWNS a
    // workspace (global-keyed) connector — e.g. via the authored-connector approve
    // path, which bypasses the HTTP keyMode gate — their delete must NOT purge the
    // shared company key. The route passes actor.isAdmin as purgeGlobal; the hook
    // skips the global-scope purge unless authorized. We seed the owned-state
    // directly via the upsert hook (the user route would reject keyMode:workspace).
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
    // Two same-id workspace connectors, one owned by a non-admin, one by an admin.
    for (const owner of ['mallory', 'adminX']) {
      await h.bus.call('connectors:upsert', h.ctx({ userId: owner }), {
        userId: owner,
        connectorId: 'ws-route',
        name: 'Workspace svc',
        keyMode: 'workspace',
        visibility: 'private',
        capabilities: mcpCaps(),
      });
    }
    const userHandlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    const adminHandlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'admin' });

    // Non-admin destroy → purgeGlobal:false → the shared global key is untouched.
    currentActor = { id: 'mallory', isAdmin: false };
    const { res: r1, captured: c1 } = makeRes();
    await userHandlers.destroy(makeReq({ params: { id: 'ws-route' } }), r1);
    expect(c1.status).toBe(204);
    expect(deleteCalls).toEqual([]);

    // Admin destroy → purgeGlobal:true → the shared global key IS purged.
    currentActor = { id: 'adminX', isAdmin: true };
    const { res: r2, captured: c2 } = makeRes();
    await adminHandlers.destroy(makeReq({ params: { id: 'ws-route' } }), r2);
    expect(c2.status).toBe(204);
    expect(deleteCalls).toEqual([
      { scope: 'global', ownerId: null, ref: 'account:ws-route' },
    ]);
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

  it('full CRUD on an owned private connector: create → edit → delete', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    // Unique id per test — the postgres container persists rows across the file's
    // tests, so a reused id would make a "create" return 200 (update) not 201.
    currentActor = { id: 'userCrud', isAdmin: false };

    const { res: cRes, captured: cCap } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'crud-conn',
          name: 'My connector',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      cRes,
    );
    expect(cCap.status).toBe(201);

    const { res: pRes, captured: pCap } = makeRes();
    await handlers.update(
      makeReq({ params: { id: 'crud-conn' }, body: { name: 'Renamed' } }),
      pRes,
    );
    expect(pCap.status).toBe(200);
    expect((pCap.body as { connector: { name: string } }).connector.name).toBe(
      'Renamed',
    );
    // Still private after the edit.
    expect(
      (pCap.body as { connector: { visibility: string } }).connector.visibility,
    ).toBe('private');

    const { res: dRes, captured: dCap } = makeRes();
    await handlers.destroy(makeReq({ params: { id: 'crud-conn' } }), dRes);
    expect(dCap.status).toBe(204);

    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'crud-conn' } }), gRes);
    expect(gCap.status).toBe(404);
  });

  it('PATCH on a SHARED (catalog) connector is read-only — 403', async () => {
    const h = await makeHarness();
    currentActor = { id: 'userU', isAdmin: true };
    // Admin-seed a SHARED connector owned by userU (a catalog item).
    await adminSeed(h.bus, {
      connectorId: 'catalog-conn',
      name: 'Catalog',
      keyMode: 'workspace',
      visibility: 'shared',
      capabilities: mcpCaps(),
    });
    // Now the SAME user hits the user route — the shared connector is read-only.
    currentActor = { id: 'userU', isAdmin: false };
    const userHandlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    const { res, captured } = makeRes();
    await userHandlers.update(
      makeReq({ params: { id: 'catalog-conn' }, body: { name: 'hijack' } }),
      res,
    );
    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({ error: 'read-only' });
  });

  it('POST cannot demote an existing catalog/shared connector to private (read-only — 403)', async () => {
    const h = await makeHarness();
    currentActor = { id: 'userU', isAdmin: true };
    // Admin-seed a SHARED connector owned by userU.
    await adminSeed(h.bus, {
      connectorId: 'demote-target',
      name: 'Shared',
      keyMode: 'workspace',
      visibility: 'shared',
      capabilities: mcpCaps(),
    });
    // The same user POSTs the SAME id via the user route — create-or-update must
    // NOT silently demote the shared connector to private; it 403s (read-only).
    currentActor = { id: 'userU', isAdmin: false };
    const userHandlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    const { res, captured } = makeRes();
    await userHandlers.create(
      makeReq({
        body: {
          connectorId: 'demote-target',
          name: 'Sneaky private',
          keyMode: 'personal',
          capabilities: mcpCaps(),
        },
      }),
      res,
    );
    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({ error: 'read-only' });
    // The connector is STILL shared — the demote never landed.
    currentActor = { id: 'userU', isAdmin: true };
    const { res: gRes, captured: gCap } = makeRes();
    await createAdminConnectorRouteHandlers({ bus: h.bus }).show(
      makeReq({ params: { id: 'demote-target' } }),
      gRes,
    );
    expect(
      (gCap.body as { connector: { visibility: string } }).connector.visibility,
    ).toBe('shared');
  });

  it('DELETE on a catalog (shared) connector is read-only — 403', async () => {
    const h = await makeHarness();
    currentActor = { id: 'userU', isAdmin: true };
    await adminSeed(h.bus, {
      connectorId: 'catalog-conn',
      name: 'Catalog',
      keyMode: 'workspace',
      visibility: 'shared',
      capabilities: mcpCaps(),
    });
    currentActor = { id: 'userU', isAdmin: false };
    const userHandlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    const { res, captured } = makeRes();
    await userHandlers.destroy(makeReq({ params: { id: 'catalog-conn' } }), res);
    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({ error: 'read-only' });
  });

  it('forces actor id from session — a body-supplied userId cannot impersonate', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'userImp', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          userId: 'someoneElse',
          connectorId: 'imp-conn',
          name: 'Mine',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      res,
    );
    expect(captured.status).toBe(201);
    // The connector landed under userImp, not "someoneElse".
    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'imp-conn' } }), gRes);
    expect(gCap.status).toBe(200);
  });

  it('cross-tenant: user B cannot edit / delete user A’s private connector (404)', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'userA', isAdmin: false };
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'a-conn',
          name: 'A',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      makeRes().res,
    );
    currentActor = { id: 'userB', isAdmin: false };
    const { res: pRes, captured: pCap } = makeRes();
    await handlers.update(
      makeReq({ params: { id: 'a-conn' }, body: { name: 'hijack' } }),
      pRes,
    );
    expect(pCap.status).toBe(404);
    const { res: dRes, captured: dCap } = makeRes();
    await handlers.destroy(makeReq({ params: { id: 'a-conn' } }), dRes);
    expect(dCap.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// User connector AUTHORED-draft routes (2026-06-03) — the Settings "Proposed by
// your assistant" fallback: GET /settings/connectors/authored (list pending) +
// POST /settings/connectors/authored/:id/approve (approve outside chat). The
// approve route forces userId from the session, ACL-gates agents:resolve, and
// calls the orchestrator's authored-connector grant with NO conversationId
// (approve-ahead). Both stubbed here; the real grant is tested in
// @ax/chat-orchestrator.
// ---------------------------------------------------------------------------
describe('user connector AUTHORED routes (/settings/connectors/authored)', () => {
  // Captured grant calls + a configurable verdict the stub returns.
  let grantCalls: Array<Record<string, unknown>>;
  let grantApplied: boolean;
  // When set, the grant stub throws this instead of returning a verdict.
  let grantThrows: Error | null;
  // agents:resolve verdict: 'ok' | 'forbidden' | 'not-found'.
  let agentsResolveVerdict: 'ok' | 'forbidden' | 'not-found';

  async function makeAuthoredHarness(): Promise<TestHarness> {
    grantCalls = [];
    grantApplied = true;
    grantThrows = null;
    agentsResolveVerdict = 'ok';
    const h = await createTestHarness({
      services: {
        'agents:resolve': async (_ctx, input: unknown) => {
          if (agentsResolveVerdict === 'forbidden') {
            throw new PluginError({
              code: 'forbidden',
              plugin: 'agents-stub',
              hookName: 'agents:resolve',
              message: 'no',
            });
          }
          if (agentsResolveVerdict === 'not-found') {
            throw new PluginError({
              code: 'not-found',
              plugin: 'agents-stub',
              hookName: 'agents:resolve',
              message: 'gone',
            });
          }
          return { agent: { id: (input as { agentId: string }).agentId } };
        },
        'agent:apply-authored-connector-grant': async (_ctx, input: unknown) => {
          grantCalls.push(input as Record<string, unknown>);
          if (grantThrows !== null) throw grantThrows;
          return grantApplied
            ? { applied: true, respawned: false }
            : { applied: false, reason: 'not-authored' };
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

  /** Seed a PENDING authored draft via the install-authored hook. */
  async function seedDraft(
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
      usageNote: '',
      keyMode: 'personal',
    });
  }

  it('GET authored lists the session user’s pending drafts across agents (owner-scoped)', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    await seedDraft(h, { userId: 'userU', agentId: 'agent2', connectorId: 'linear' });
    await seedDraft(h, { userId: 'userU', agentId: 'agent1', connectorId: 'gmail' });
    await seedDraft(h, { userId: 'other', agentId: 'agent1', connectorId: 'notion' });

    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.listAuthoredPending(makeReq({}), res);
    expect(captured.status).toBe(200);
    const drafts = (captured.body as { drafts: Array<{ connectorId: string; agentId: string }> }).drafts;
    // userU's two drafts only (owner-scoped), sorted by connector_id; never 'notion'.
    expect(drafts.map((d) => ({ connectorId: d.connectorId, agentId: d.agentId }))).toEqual([
      { connectorId: 'gmail', agentId: 'agent1' },
      { connectorId: 'linear', agentId: 'agent2' },
    ]);
  });

  it('GET authored 401 when unauthenticated', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = null;
    const { res, captured } = makeRes();
    await handlers.listAuthoredPending(makeReq({}), res);
    expect(captured.status).toBe(401);
  });

  it('POST approve forces userId from session, omits conversationId, returns 200', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    await seedDraft(h, { userId: 'userU', agentId: 'agent1', connectorId: 'linear' });

    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.approveAuthored(
      makeReq({
        params: { id: 'linear' },
        body: { agentId: 'agent1', shown: { hosts: ['api.linear.app'], slots: ['LINEAR_API_KEY'], npm: [], pypi: [] } },
      }),
      res,
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ applied: true });
    // The grant was called with the session userId + body agentId + url id, the
    // shown guard forwarded, and NO conversationId (approve-ahead).
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0]).toMatchObject({
      userId: 'userU',
      agentId: 'agent1',
      connectorId: 'linear',
      shown: { hosts: ['api.linear.app'], slots: ['LINEAR_API_KEY'], npm: [], pypi: [] },
    });
    expect(grantCalls[0]).not.toHaveProperty('conversationId');
  });

  it('POST approve 400 when agentId is missing', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.approveAuthored(makeReq({ params: { id: 'linear' }, body: {} }), res);
    expect(captured.status).toBe(400);
    expect(grantCalls).toHaveLength(0);
  });

  it('POST approve 403 when the agent ACL gate forbids', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    agentsResolveVerdict = 'forbidden';
    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.approveAuthored(
      makeReq({ params: { id: 'linear' }, body: { agentId: 'agentX' } }),
      res,
    );
    expect(captured.status).toBe(403);
    // The grant is never reached when the ACL gate rejects.
    expect(grantCalls).toHaveLength(0);
  });

  it('POST approve 409 when the grant reports not-authored (unknown/foreign draft)', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    grantApplied = false;
    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.approveAuthored(
      makeReq({ params: { id: 'ghost' }, body: { agentId: 'agent1' } }),
      res,
    );
    expect(captured.status).toBe(409);
    expect((captured.body as { error: string }).error).toBe('not-authored');
  });

  // TASK-771 — approving promotes the draft via connectors:upsert, which refuses
  // an endpoint move whose tool-permission reset failed (TASK-758). The Settings
  // approve dialog keys its message on this exact 503 body.
  it('POST approve 503 tool-permissions-reset-failed when the promotion’s reset fails', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    grantThrows = new PluginError({
      code: 'tool-permissions-reset-failed',
      plugin: '@ax/connectors',
      hookName: 'connectors:upsert',
      message: 'internal detail that must not reach the client',
    });
    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.approveAuthored(
      makeReq({ params: { id: 'linear' }, body: { agentId: 'agent1' } }),
      res,
    );
    expect(captured.status).toBe(503);
    expect(captured.body).toEqual({ error: 'tool-permissions-reset-failed' });
  });

  // DELETE /settings/connectors/authored/:id — the "Dismiss" action on the
  // "Proposed by your assistant" shelf (2026-06-04). Lets a user reject a draft
  // their assistant proposed WITHOUT first approving it (the old trap: the only
  // shelf action was Approve, so dismissing meant entering a real/fake key just
  // to promote it into the registry where Delete finally appeared). Reuses the
  // dormant `connectors:clear-authored` hook. Owner-scoped from the session.
  it('DELETE authored clears the session user’s pending draft, returns 204', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    // A test-unique userId keeps this assertion isolated from drafts other tests
    // seed into the shared DB (the list is owner-scoped).
    await seedDraft(h, { userId: 'ru-clear', agentId: 'agent1', connectorId: 'linear' });

    currentActor = { id: 'ru-clear', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.rejectAuthored(
      makeReq({ params: { id: 'linear' }, body: { agentId: 'agent1' } }),
      res,
    );
    expect(captured.status).toBe(204);
    expect(captured.ended).toBe(true);

    // The draft is gone from this user's "Proposed" shelf.
    const { res: lRes, captured: lCap } = makeRes();
    await handlers.listAuthoredPending(makeReq({}), lRes);
    expect((lCap.body as { drafts: unknown[] }).drafts).toEqual([]);
  });

  it('DELETE authored 404 when the draft belongs to another user (owner-scoped)', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    await seedDraft(h, { userId: 'ru-owner', agentId: 'agent1', connectorId: 'linear' });

    // A different user cannot clear ru-owner's draft — the clear is scoped to the
    // session owner, so zero rows match → not-found.
    currentActor = { id: 'ru-other', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.rejectAuthored(
      makeReq({ params: { id: 'linear' }, body: { agentId: 'agent1' } }),
      res,
    );
    expect(captured.status).toBe(404);

    // ru-owner's draft is untouched.
    currentActor = { id: 'ru-owner', isAdmin: false };
    const { res: lRes, captured: lCap } = makeRes();
    await handlers.listAuthoredPending(makeReq({}), lRes);
    expect((lCap.body as { drafts: Array<{ connectorId: string }> }).drafts).toHaveLength(1);
  });

  it('DELETE authored 400 when agentId is missing', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.rejectAuthored(makeReq({ params: { id: 'linear' }, body: {} }), res);
    expect(captured.status).toBe(400);
  });

  it('DELETE authored 401 when unauthenticated', async () => {
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = null;
    const { res, captured } = makeRes();
    await handlers.rejectAuthored(
      makeReq({ params: { id: 'linear' }, body: { agentId: 'agent1' } }),
      res,
    );
    expect(captured.status).toBe(401);
  });

  it('DELETE authored succeeds even when agents:resolve would forbid (no ACL gate)', async () => {
    // Rejecting your OWN draft must never be blocked by agent reachability — a
    // draft authored under an agent you can no longer reach (deleted / access
    // revoked) would otherwise be un-dismissable, the exact trap we’re fixing.
    const h = await makeAuthoredHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    await seedDraft(h, { userId: 'ru-nogate', agentId: 'agent1', connectorId: 'linear' });
    agentsResolveVerdict = 'forbidden';

    currentActor = { id: 'ru-nogate', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.rejectAuthored(
      makeReq({ params: { id: 'linear' }, body: { agentId: 'agent1' } }),
      res,
    );
    expect(captured.status).toBe(204);
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

  it.each(FOREIGN_REFS)('user route POST refuses %j (400) and stores nothing', async (ref) => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'mallory-712', isAdmin: false };
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

  it('user route POST accepts the connector’s own ref and it round-trips', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'own-712', isAdmin: false };
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
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'dcr-712', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.create(makeReq({ body: create('mine') }), res);
    expect(captured.status).toBe(201);
  });

  it('user route PATCH cannot introduce a foreign ref; the stored row is untouched', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'patch-712', isAdmin: false };
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

    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'legacy-712', isAdmin: false };
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
