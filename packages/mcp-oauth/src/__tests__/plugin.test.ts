import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestHarness,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import type { ServiceHandler } from '@ax/core';
import type { Kysely } from 'kysely';
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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
    expect(off.manifest.subscribes).toEqual([]);

    const on = createMcpOAuthPlugin({
      mountRoutes: true,
      publicOrigin: 'https://example.com',
    });
    // Always registers the resolver sub-service.
    expect(on.manifest.registers).toContain('credentials:resolve:mcp-oauth');
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

    // mcp_oauth_v1_clients
    await store.putClient({
      clientKey: 'c|https://auth.example.com',
      clientId: 'cid',
      clientSecret: undefined,
      dynamic: true,
    });
    const client = await store.getClient('c|https://auth.example.com');
    expect(client?.clientId).toBe('cid');

    // mcp_oauth_v1_pending
    await store.putPending({
      state: 'st1',
      userId: 'u',
      agentId: 'a',
      connectorId: 'conn',
      slot: 'gdrive',
      codeVerifier: 'cv',
      authServerUrl: 'https://auth.example.com',
      clientKey: 'c|https://auth.example.com',
      resource: 'https://mcp.example.com',
      scope: 'read',
      createdAt: Date.now(),
    });
    const pending = await store.getPending('st1');
    expect(pending?.userId).toBe('u');
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
      path: '/api/connectors/oauth/begin',
    });
    expect(recorded).toContainEqual({
      method: 'GET',
      path: '/api/connectors/oauth/callback',
    });
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
