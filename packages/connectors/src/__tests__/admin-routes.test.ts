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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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

    currentActor = { id: 'userB', isAdmin: false };
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

  it('test: unreachable when an MCP-backed connector has neither url nor command', async () => {
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
            transport: 'stdio',
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
// down: the connector is forced PRIVATE, admin-only fields (visibility:shared,
// defaultAttached:true) are REJECTED (400 — not silently dropped), and a
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

  it('POST forces the connector private (a body visibility is ignored when absent)', async () => {
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
          // No visibility supplied — the route must force it private.
          capabilities: mcpCaps(),
        },
      }),
      res,
    );
    expect(captured.status).toBe(201);
    const connector = (captured.body as { connector: { visibility: string } })
      .connector;
    expect(connector.visibility).toBe('private');
  });

  it('POST rejects visibility:shared (admin-only) with 400 — never silently downgrades', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'sneaky',
          name: 'Sneaky',
          keyMode: 'personal',
          visibility: 'shared',
          capabilities: mcpCaps(),
        },
      }),
      res,
    );
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain('admin-only');
    // It must NOT have landed downgraded — the GET 404s.
    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'sneaky' } }), gRes);
    expect(gCap.status).toBe(404);
  });

  it('POST rejects defaultAttached:true (admin-only) with 400', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'userU', isAdmin: false };
    const { res, captured } = makeRes();
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'sneaky',
          name: 'Sneaky',
          keyMode: 'personal',
          visibility: 'private',
          defaultAttached: true,
          capabilities: mcpCaps(),
        },
      }),
      res,
    );
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain('admin-only');
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

  it('PATCH cannot flip an owned private connector to shared (admin-only field rejected)', async () => {
    const h = await makeHarness();
    const handlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    currentActor = { id: 'userU', isAdmin: false };
    await handlers.create(
      makeReq({
        body: {
          connectorId: 'mine',
          name: 'Mine',
          keyMode: 'personal',
          visibility: 'private',
          capabilities: mcpCaps(),
        },
      }),
      makeRes().res,
    );
    const { res, captured } = makeRes();
    await handlers.update(
      makeReq({ params: { id: 'mine' }, body: { visibility: 'shared' } }),
      res,
    );
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain('admin-only');
    // Still private — the rejected patch never landed.
    const { res: gRes, captured: gCap } = makeRes();
    await handlers.show(makeReq({ params: { id: 'mine' } }), gRes);
    expect((gCap.body as { connector: { visibility: string } }).connector.visibility).toBe(
      'private',
    );
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

  it('PATCH on a DEFAULT-ON connector is read-only — 403', async () => {
    const h = await makeHarness();
    currentActor = { id: 'userU', isAdmin: true };
    await adminSeed(h.bus, {
      connectorId: 'default-conn',
      name: 'Default',
      keyMode: 'personal',
      visibility: 'private',
      defaultAttached: true,
      capabilities: mcpCaps(),
    });
    currentActor = { id: 'userU', isAdmin: false };
    const userHandlers = createConnectorRouteHandlers({ bus: h.bus, mode: 'user' });
    const { res, captured } = makeRes();
    await userHandlers.update(
      makeReq({ params: { id: 'default-conn' }, body: { name: 'hijack' } }),
      res,
    );
    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({ error: 'read-only' });
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
