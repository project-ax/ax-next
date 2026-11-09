import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import pg from 'pg';

import { HookBus, PluginError, bootstrap, type Plugin } from '@ax/core';
import type { ConnectorDirectoryPlugin } from '@ax/connector-directory';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-1100 -- @ax/connector-directory composition canary (Invariant 3: no
// half-wired plugins).
//
// Drives the admin route through the preset's OWN plugins: the real
// @ax/connectors (the route and its optional `connectors:directory-search`
// call), the real @ax/connector-directory (sync + search on real Postgres) and
// @ax/database-postgres. The registry is a fake behind `fetchImpl`, and the
// global `fetch` throws, so the test cannot reach the network by accident.
//
// TASK-1102 adds the provenance leg: a connector created from a listing leaves
// a row in the directory's own table, a name-only edit keeps it unedited, an
// address edit marks it, and a delete drops it (the directory's
// `connectors:deleted` subscriber). A hand-entered connector records nothing.
//
// Stubbed: `http:register-route` (records the routes so the test can call a
// handler directly), `auth:require-user` (the test picks the actor) and
// `credentials:list` (the connectors plugin's Test probe; unused here).
// ---------------------------------------------------------------------------

const DIRECTORY_PLUGIN = '@ax/connector-directory';
const KEEP = new Set<string>([
  '@ax/database-postgres',
  '@ax/connectors',
  DIRECTORY_PLUGIN,
]);

const REGISTRY_ORIGIN = 'https://registry.test';

interface CapturedRoute {
  method: string;
  path: string;
  handler: (req: unknown, res: unknown) => Promise<void>;
}

const routes: CapturedRoute[] = [];
let actor: { id: string; isAdmin: boolean } | null = null;

function createStubsPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/connector-directory-stubs';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['http:register-route', 'auth:require-user', 'credentials:list'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<CapturedRoute, { unregister(): void }>(
        'http:register-route',
        name,
        async (_ctx, route) => {
          routes.push(route);
          return { unregister() {} };
        },
      );
      bus.registerService('auth:require-user', name, async () => {
        if (actor === null) {
          throw new PluginError({ code: 'unauthenticated', plugin: name, message: 'no session' });
        }
        return { user: actor };
      });
      bus.registerService('credentials:list', name, async () => ({ credentials: [] }));
    },
  };
}

function remote(url: string): Record<string, unknown> {
  return { type: 'streamable-http', url };
}

function listing(name: string, title: string, remotes: unknown[], packages?: unknown[]): unknown {
  return {
    server: {
      name,
      title,
      description: `${title} test listing`,
      version: '1.0.0',
      remotes,
      ...(packages !== undefined ? { packages } : {}),
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: 'active',
        isLatest: true,
        publishedAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
      },
    },
  };
}

const requests: URL[] = [];

const fetchImpl = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  requests.push(url);
  const servers = [
    listing('app.linear/linear', 'Linear', [remote('https://mcp.linear.app/mcp')]),
    listing('io.github.someone/linear-tools', 'Linear tools', [remote('https://tools.example.org/mcp')]),
    // Package-only: never stored.
    listing('com.example/pkg', 'Linear package', [], [
      { registryType: 'npm', identifier: '@example/mcp', version: '1.0.0', transport: { type: 'stdio' } },
    ]),
  ];
  return new Response(JSON.stringify({ servers, metadata: { count: servers.length } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

interface Captured {
  status: number;
  body: unknown;
}

interface RouteArgs {
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
}

async function callRoute(method: string, path: string, args: RouteArgs = {}): Promise<Captured> {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (route === undefined) throw new Error(`route ${method} ${path} was not registered`);
  const captured: Captured = { status: 0, body: undefined };
  const res = {
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
    end() {},
  };
  await route.handler(
    {
      headers: {},
      body: args.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(args.body)),
      cookies: {},
      query: args.query ?? {},
      params: args.params ?? {},
      signedCookie: () => null,
    },
    res,
  );
  return captured;
}

function connectorBody(connectorId: string, url: string): Record<string, unknown> {
  return {
    connectorId,
    name: 'Linear',
    keyMode: 'personal',
    capabilities: {
      allowedHosts: [],
      credentials: [],
      mcpServers: [
        { name: connectorId, transport: 'http', url, allowedHosts: [], credentials: [] },
      ],
      packages: { npm: [], pypi: [] },
    },
  };
}

describe('@ax/preset-k8s connector directory composition (TASK-1100)', () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let shutdown: (() => Promise<void>) | null = null;
  let directory: ConnectorDirectoryPlugin | null = null;

  async function query(text: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    const client = new pg.Client({ connectionString: pgContainer!.getConnectionUri() });
    await client.connect();
    try {
      return (await client.query(text, params)).rows;
    } finally {
      await client.end().catch(() => {});
    }
  }

  function provenanceRows(connectorId: string): Promise<Array<Record<string, unknown>>> {
    return query(
      'SELECT connector_id, directory_id, version, edited FROM connector_directory_v1_provenance WHERE connector_id = $1',
      [connectorId],
    );
  }

  function presetConfig(connectionString: string): K8sPresetConfig {
    return {
      database: { connectionString },
      eventbus: { connectionString: 'postgres://stub:5432/stub' },
      session: { connectionString: 'postgres://stub:5432/stub' },
      blob: { backend: 'fs', root: '/tmp/ax-connector-directory-unused' },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      chat: { runnerBinaries: {}, chatTimeoutMs: 60_000 },
      http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
      connectorDirectory: { enabled: true, registryUrl: REGISTRY_ORIGIN, fetchImpl },
    };
  }

  beforeAll(async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('network is off in tests');
    });
    pgContainer = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    const presetPlugins = createK8sPlugins(presetConfig(pgContainer.getConnectionUri()));
    const kept = presetPlugins.filter((p) => KEEP.has(p.manifest.name));
    expect(kept.map((p) => p.manifest.name).sort()).toEqual([...KEEP].sort());
    directory = kept.find((p) => p.manifest.name === DIRECTORY_PLUGIN) as unknown as ConnectorDirectoryPlugin;

    const bus = new HookBus();
    const handle = await bootstrap({
      bus,
      plugins: [...kept, createStubsPlugin()],
      config: {},
    });
    shutdown = () => handle.shutdown();
  }, 180_000);

  afterAll(async () => {
    if (shutdown !== null) await shutdown();
    vi.unstubAllGlobals();
    await stopPostgresContainer(pgContainer);
  }, 60_000);

  it('route -> hook -> table: an admin search returns the synced listings, domain first', async () => {
    actor = { id: 'admin-1', isAdmin: true };
    const result = await directory!.sync();
    expect(result.outcome).toBe('ok');
    // Every registry request went to the configured origin's list endpoint.
    expect(requests.length).toBeGreaterThan(0);
    for (const url of requests) {
      expect(url.origin).toBe(REGISTRY_ORIGIN);
      expect(url.pathname).toBe('/v0.1/servers');
    }

    const out = await callRoute('GET', '/admin/connectors/directory', { query: { q: 'linear' } });
    expect(out.status).toBe(200);
    const body = out.body as {
      enabled: boolean;
      syncedAt: string | null;
      entries: Array<Record<string, unknown>>;
    };
    expect(body.enabled).toBe(true);
    expect(body.syncedAt).not.toBeNull();
    expect(body.entries.map((e) => e['id'])).toEqual([
      'app.linear/linear',
      'io.github.someone/linear-tools',
    ]);
    expect(body.entries[0]).toMatchObject({
      publisherProof: 'domain',
      publisher: 'linear.app',
      url: 'https://mcp.linear.app/mcp',
      auth: 'none',
    });
  });

  it('a non-admin is refused', async () => {
    actor = { id: 'user-1', isAdmin: false };
    const out = await callRoute('GET', '/admin/connectors/directory', { query: { q: 'linear' } });
    expect(out.status).toBe(403);
  });

  it('create from the directory records provenance; an address edit marks it; delete removes it (TASK-1102)', async () => {
    actor = { id: 'admin-1', isAdmin: true };
    await directory!.sync();
    const id = 'linear-0a1b2c3d';

    const created = await callRoute('POST', '/admin/connectors', {
      body: {
        ...connectorBody(id, 'https://mcp.linear.app/mcp'),
        fromDirectory: { directoryId: 'app.linear/linear', version: '1.0.0' },
      },
    });
    expect(created.status).toBe(201);
    // The listing rides beside the connector, never inside it.
    expect((created.body as { connector: Record<string, unknown> }).connector).not.toHaveProperty(
      'fromDirectory',
    );
    expect(await provenanceRows(id)).toEqual([
      { connector_id: id, directory_id: 'app.linear/linear', version: '1.0.0', edited: false },
    ]);
    const stored = await query(
      'SELECT capabilities::text AS caps FROM connectors_v1_connectors WHERE connector_id = $1',
      [id],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!['caps']).not.toContain('app.linear/linear');

    // A label edit leaves the address alone: still matches its listing.
    const renamed = await callRoute('PATCH', '/admin/connectors/:id', {
      params: { id },
      body: { name: 'Linear (renamed)' },
    });
    expect(renamed.status).toBe(200);
    expect(await provenanceRows(id)).toEqual([
      expect.objectContaining({ connector_id: id, edited: false }),
    ]);

    // A moved address no longer matches it.
    const moved = await callRoute('PATCH', '/admin/connectors/:id', {
      params: { id },
      body: connectorBody(id, 'https://mcp.linear.app/v2'),
    });
    expect(moved.status).toBe(200);
    expect(await provenanceRows(id)).toEqual([
      expect.objectContaining({ connector_id: id, directory_id: 'app.linear/linear', edited: true }),
    ]);

    const removed = await callRoute('DELETE', '/admin/connectors/:id', { params: { id } });
    expect(removed.status).toBe(204);
    expect(await provenanceRows(id)).toEqual([]);
  });

  it('a hand-entered connector records no provenance (TASK-1102)', async () => {
    actor = { id: 'admin-1', isAdmin: true };
    await directory!.sync();
    const id = 'hand-1a2b3c4d';
    const created = await callRoute('POST', '/admin/connectors', {
      body: connectorBody(id, 'https://mcp.example.com/mcp'),
    });
    expect(created.status).toBe(201);
    expect(await provenanceRows(id)).toEqual([]);
  });
});
