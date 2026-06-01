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

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      authStubPlugin(),
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
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) await h.close();
  }
});

function mcpCaps(): Capabilities {
  return {
    allowedHosts: ['drive.googleapis.com'],
    credentials: [{ slot: 'gdrive', kind: 'api-key', account: 'google' }],
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
});
