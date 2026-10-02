import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestHarness,
  stopPostgresContainer,
  type TestHarness,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createLogger, type ServiceHandler } from '@ax/core';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { createMcpOAuthPlugin } from '../plugin.js';
import { createMcpOAuthStore } from '../store.js';
import type { McpOAuthDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// @ax/mcp-oauth plugin factory: migration + resolver service + (optional)
// begin/callback HTTP routes. Driven through the bus against a real postgres
// testcontainer (mirrors @ax/connectors hooks.test.ts).
//
// The resolver service is registered ALWAYS (harmless even when @ax/credentials
// isn't loaded — nothing calls it then). The routes are mounted only when
// `mountRoutes:true`, which additionally requires `publicOrigin`.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

/** Stubs for every required `calls` hook the routes declare. The route handlers
 *  aren't invoked in these tests — the stubs only need to EXIST so bootstrap's
 *  post-init `verifyCalls` doesn't fail the boot on a missing producer. */
type RouteRecord = { method: string; path: string };

function routeStubServices(recorded: RouteRecord[]): Record<string, ServiceHandler> {
  return {
    // Records the {method, path} so we can assert the routes were registered.
    'http:register-route': (async (_ctx, input) => {
      const { method, path } = input as RouteRecord;
      recorded.push({ method, path });
      return { unregister: () => {} };
    }) as ServiceHandler,
    'auth:require-user': (async () => ({
      user: { id: 'u', isAdmin: false },
    })) as ServiceHandler,
    'connectors:get': (async () => ({ connector: {} })) as ServiceHandler,
    'agents:resolve': (async () => ({ agent: {} })) as ServiceHandler,
    'credentials:get': (async () => '') as ServiceHandler,
    'credentials:set': (async () => undefined) as ServiceHandler,
  };
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS mcp_oauth_v1_clients');
    await cleanup.query('DROP TABLE IF EXISTS mcp_oauth_v1_pending');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/mcp-oauth plugin manifest', () => {
  it('registers credentials:resolve:mcp-oauth and hard-calls database:get-instance; mountRoutes extends calls', () => {
    const off = createMcpOAuthPlugin();
    expect(off.manifest.name).toBe('@ax/mcp-oauth');
    expect(off.manifest.registers).toContain('credentials:resolve:mcp-oauth');
    expect(off.manifest.calls).toEqual(['database:get-instance']);
    // TASK-718: a deleted agent's in-flight handshakes go with it. Subscribed
    // whether or not the routes are mounted — the table exists either way.
    expect(off.manifest.subscribes).toEqual(['agents:deleted']);

    const on = createMcpOAuthPlugin({
      mountRoutes: true,
      publicOrigin: 'https://example.com',
    });
    // Always registers the resolver sub-service.
    expect(on.manifest.registers).toContain('credentials:resolve:mcp-oauth');
    expect(on.manifest.subscribes).toEqual(['agents:deleted']);
    // The route handlers call these; mountRoutes pushes them onto `calls`.
    expect(on.manifest.calls).toEqual([
      'database:get-instance',
      'http:register-route',
      'auth:require-user',
      'connectors:get',
      'agents:resolve',
      'credentials:get',
      'credentials:set',
    ]);
  });
});

describe('@ax/mcp-oauth plugin init (mountRoutes:false)', () => {
  it('registers the resolver service and runs its migration (both tables exist)', async () => {
    const h = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createMcpOAuthPlugin(),
      ],
    });
    harnesses.push(h);

    expect(h.bus.hasService('credentials:resolve:mcp-oauth')).toBe(true);

    // The migration ran: both owned tables exist AND are usable. We exercise
    // them through the store (a write + read round-trip) rather than peeking at
    // information_schema — that proves the migrated columns line up with what
    // the store expects, not merely that a table of the right name exists.
    const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const store = createMcpOAuthStore(db);

    // mcp_oauth_v1_clients — a READ-ONLY legacy fallback: the store can no longer
    // write it, so seed a row directly (as the pre-TASK-696 code would have) and
    // prove the migrated table lines up with what `getClient` reads.
    await db
      .insertInto('mcp_oauth_v1_clients')
      .values({
        client_key: 'c|https://auth.example.com',
        client_id: 'cid',
        client_secret: null,
        dynamic: true,
        created_at: new Date(),
      })
      .execute();
    const client = await store.getClient('c|https://auth.example.com');
    expect(client?.clientId).toBe('cid');

    // mcp_oauth_v1_pending — including the client_id / client_secret columns the
    // migration adds (a token is redeemed as the client its authorization started with).
    await store.putPending({
      state: 'st1',
      userId: 'u',
      agentId: 'a',
      connectorId: 'conn',
      slot: 'gdrive',
      codeVerifier: 'cv',
      authServerUrl: 'https://auth.example.com',
      clientKey: 'c|https://auth.example.com',
      clientId: 'pending-cid',
      clientSecret: 'pending-secret',
      resource: 'https://mcp.example.com',
      scope: 'read',
      credScope: 'agent',
      createdAt: Date.now(),
    });
    const pending = await store.getPending('st1');
    expect(pending?.userId).toBe('u');
    expect(pending?.clientId).toBe('pending-cid');
    expect(pending?.clientSecret).toBe('pending-secret');
  });
});

describe('@ax/mcp-oauth plugin init (mountRoutes:true)', () => {
  it('registers the begin (POST) + callback (GET) routes', async () => {
    const recorded: RouteRecord[] = [];
    const h = await createTestHarness({
      services: routeStubServices(recorded),
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createMcpOAuthPlugin({
          mountRoutes: true,
          publicOrigin: 'https://example.com',
        }),
      ],
    });
    harnesses.push(h);

    expect(recorded).toContainEqual({
      method: 'POST',
      path: '/api/connectors/oauth/discover-hosts',
    });
    expect(recorded).toContainEqual({
      method: 'POST',
      path: '/api/connectors/oauth/begin',
    });
    expect(recorded).toContainEqual({
      method: 'GET',
      path: '/api/connectors/oauth/callback',
    });
  });

  it('wires the authenticated host preview through the running plugin', async () => {
    const services = routeStubServices([]);
    let previewHandler!: (req: unknown, res: unknown) => Promise<void>;
    services['http:register-route'] = (async (_ctx, input) => {
      const route = input as { path: string; handler: typeof previewHandler };
      if (route.path === '/api/connectors/oauth/discover-hosts') previewHandler = route.handler;
      return { unregister: () => {} };
    }) as ServiceHandler;
    const preview = vi.fn(async () => ({ hosts: ['accounts.google.com', 'gmailmcp.googleapis.com', 'oauth2.googleapis.com'] }));
    const h = await createTestHarness({
      services,
      plugins: [createDatabasePostgresPlugin({ connectionString }), createMcpOAuthPlugin({
        mountRoutes: true, publicOrigin: 'https://example.com', testOverrides: { discoverHosts: preview },
      })],
    });
    harnesses.push(h);
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await previewHandler({ body: Buffer.from(JSON.stringify({ url: 'https://gmailmcp.googleapis.com/mcp/v1' })) }, response);
    expect(preview).toHaveBeenCalledWith({ resourceUrl: 'https://gmailmcp.googleapis.com/mcp/v1' });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(await preview.mock.results[0]!.value);
  });

  it.each([
    ['a branding plugin is loaded', { name: '  Canopy\u202e AI ' }, 'Canopy AI'],
    ['branding has no name set', { name: null }, 'AX'],
    ['the branding read fails', new Error('storage down'), 'AX'],
    ['no branding plugin is loaded', undefined, 'AX'],
  ] as const)('names the published OAuth client when %s', async (_case, branding, expected) => {
    const services = routeStubServices([]);
    let metadataHandler!: (req: unknown, res: unknown) => Promise<void>;
    services['http:register-route'] = (async (_ctx, input) => {
      const route = input as { path: string; handler: typeof metadataHandler };
      if (route.path === '/api/connectors/oauth/client-metadata') metadataHandler = route.handler;
      return { unregister: () => {} };
    }) as ServiceHandler;
    if (branding !== undefined) {
      services['branding:get'] = (async () => {
        if (branding instanceof Error) throw branding;
        return branding;
      }) as ServiceHandler;
    }
    const h = await createTestHarness({
      services,
      plugins: [createDatabasePostgresPlugin({ connectionString }), createMcpOAuthPlugin({
        mountRoutes: true, publicOrigin: 'https://example.com',
      })],
    });
    harnesses.push(h);
    const response = { status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), json: vi.fn() };
    await metadataHandler({}, response);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ client_name: expected }));
  });

  it('throws a clear error when mountRoutes is set without publicOrigin', async () => {
    await expect(
      createTestHarness({
        services: routeStubServices([]),
        plugins: [
          createDatabasePostgresPlugin({ connectionString }),
          createMcpOAuthPlugin({ mountRoutes: true }),
        ],
      }),
    ).rejects.toThrow(/publicOrigin/);
  });
});

// TASK-718 — `@ax/agents` fires `agents:deleted` AFTER the agent row is gone.
// `mcp_oauth_v1_pending` carries `agent_id` with no FK to the agents table
// (deliberately), so nothing but this subscriber ever removes an in-flight
// handshake for a deleted agent. Tokens live in the credentials store and are
// purged there; `mcp_oauth_v1_clients` has no `agent_id` and is left alone.
describe('@ax/mcp-oauth agents:deleted subscriber (TASK-718)', () => {
  async function boot(): Promise<TestHarness> {
    const h = await createTestHarness({
      plugins: [createDatabasePostgresPlugin({ connectionString }), createMcpOAuthPlugin()],
    });
    harnesses.push(h);
    return h;
  }

  function pendingFor(state: string, agentId: string, userId: string, over: Record<string, unknown> = {}) {
    return {
      state,
      userId,
      agentId,
      connectorId: 'my-connector',
      slot: 'default',
      codeVerifier: 'verifier',
      authServerUrl: 'https://auth.example.com',
      clientKey: 'my-connector|https://auth.example.com',
      resource: 'https://api.example.com',
      scope: 'read',
      credScope: 'agent' as const,
      createdAt: Date.now(),
      ...over,
    };
  }

  async function seed(h: TestHarness): Promise<void> {
    const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const store = createMcpOAuthStore(db);
    // agt_del: handshakes started by three different people, both cred scopes,
    // one with a confidential client's secret in the row.
    await store.putPending(pendingFor('d1', 'agt_del', 'u1'));
    await store.putPending(pendingFor('d2', 'agt_del', 'u2', { credScope: 'user' }));
    await store.putPending(
      pendingFor('d3', 'agt_del', 'u3', { clientId: 'cid', clientSecret: 'plaintext-secret' }),
    );
    await store.putPending(pendingFor('k1', 'agt_keep', 'u1'));
    await store.putPending(pendingFor('k2', 'agt_keep', 'u2', { credScope: 'user' }));
    // The legacy shared client row is not agent-keyed; it must survive.
    await db
      .insertInto('mcp_oauth_v1_clients')
      .values({ client_key: 'k|a', client_id: 'cid', client_secret: null, dynamic: true, created_at: new Date(0) })
      .execute();
  }

  async function countPending(agentId: string): Promise<number> {
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      const r = await c.query(
        'SELECT COUNT(*)::int AS n FROM mcp_oauth_v1_pending WHERE agent_id = $1',
        [agentId],
      );
      return r.rows[0].n as number;
    } finally {
      await c.end().catch(() => {});
    }
  }

  async function countClients(): Promise<number> {
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      const r = await c.query('SELECT COUNT(*)::int AS n FROM mcp_oauth_v1_clients');
      return r.rows[0].n as number;
    } finally {
      await c.end().catch(() => {});
    }
  }

  /** A ctx whose logger writes into `lines`, so a test can read what was logged. */
  function loggedCtx(h: TestHarness, lines: string[]) {
    return h.ctx({ logger: createLogger({ reqId: 'req-del', writer: (l) => lines.push(l) }) });
  }

  const parse = (lines: string[]): Array<Record<string, unknown>> =>
    lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  const deleted = (agentId: unknown) => ({ agentId, ownerId: 'u1', ownerType: 'user' });

  it('removes every pending handshake for the deleted agent, and only those', async () => {
    const h = await boot();
    await seed(h);
    expect(await countPending('agt_del')).toBe(3);
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    expect(await countPending('agt_del')).toBe(0);
    expect(await countPending('agt_keep')).toBe(2);
    // No `agent_id` column on the legacy clients table: not this plugin's to purge.
    expect(await countClients()).toBe(1);
    expect(
      parse(lines).find((e) => e.msg === 'mcp_oauth_purged_for_deleted_agent'),
    ).toMatchObject({ level: 'info', agentId: 'agt_del', deleted: 3 });
  });

  it('firing again for the same agent is a no-op that neither throws nor touches other agents', async () => {
    const h = await boot();
    await seed(h);
    await h.bus.fire('agents:deleted', loggedCtx(h, []), deleted('agt_del'));
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    expect(await countPending('agt_del')).toBe(0);
    expect(await countPending('agt_keep')).toBe(2);
    const events = parse(lines);
    expect(events.find((e) => e.msg === 'mcp_oauth_purged_for_deleted_agent')).toMatchObject({
      deleted: 0,
    });
    expect(events.some((e) => e.level === 'error')).toBe(false);
  });

  it('a malformed payload deletes nothing, warns, and does not throw', async () => {
    const h = await boot();
    await seed(h);
    for (const bad of [{}, { agentId: '' }, { agentId: 42 }, { agentId: null }, null, 'agt_del']) {
      const lines: string[] = [];
      const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), bad);
      expect(res.rejected).toBe(false);
      const events = parse(lines);
      expect(events.filter((e) => e.level === 'warn').map((e) => e.msg)).toEqual([
        'mcp_oauth_purge_for_deleted_agent_skipped',
      ]);
      // The subscriber handled it itself: the bus never had to catch a throw.
      expect(events.some((e) => e.msg === 'hook_subscriber_failed')).toBe(false);
    }
    expect(await countPending('agt_del')).toBe(3);
    expect(await countPending('agt_keep')).toBe(2);
  });

  it('a failing store is logged at error and swallowed — the subscriber never throws', async () => {
    const h = await boot();
    await seed(h);
    // Break the store out from under the subscriber: the DELETE now fails with
    // "relation does not exist".
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      await c.query('DROP TABLE mcp_oauth_v1_pending');
    } finally {
      await c.end().catch(() => {});
    }
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    const events = parse(lines);
    expect(events.filter((e) => e.level === 'error').map((e) => e.msg)).toEqual([
      'mcp_oauth_purge_for_deleted_agent_failed',
    ]);
    expect(events.find((e) => e.level === 'error')).toMatchObject({ agentId: 'agt_del' });
    // The bus's own isolation did NOT have to catch anything: we swallowed it.
    expect(events.some((e) => e.msg === 'hook_subscriber_failed')).toBe(false);
  });
});
