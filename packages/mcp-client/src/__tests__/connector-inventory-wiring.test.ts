import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { sql, type Kysely } from 'kysely';
import { createTestHarness, startTestContainer, stopPostgresContainer, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createConnectorsPlugin } from '@ax/connectors';
import type { ResolveOutput, UpsertInput } from '@ax/connectors';
import { createMcpClientPlugin } from '../plugin.js';
import { createToolDispatcherPlugin } from '../tool-dispatcher-plugin.js';
import { listServerTools, type ListServerToolsOptions } from '../connector-inventory/list-tools.js';
import type { DescribeToolsOutput } from '../connector-inventory/types.js';

// ---------------------------------------------------------------------------
// TASK-747 — `connectors:describe-tools` through the REAL `connectors:resolve`.
//
// Every other describe-tools suite hands mcp-client a hand-written resolve
// fixture. This one boots the plugins the k8s preset boots for this path —
// database-postgres, storage-postgres, credentials-store-db + credentials,
// @ax/connectors and @ax/mcp-client with `connectorToolInventory: true` — seeds
// a connector through `connectors:upsert`, stores its key the way the connect
// flow does, and lists a real MCP server (the SDK's own McpServer).
//
// So a wiring regression between the two plugins reddens here: toolNamespaces
// not reaching the inventory (→ `unreachable`/no toolKey), the wrong namespace
// paired with a server, the credential plan's ref or header binding drifting.
//
// The ONE seam: the connector URL is `https://mcp.inventory.test/...`, which
// the SSRF guard requires (https, public address). `baseFetch` — the guard's
// documented test seam — forwards each request to the loopback server over
// plain http. The guard's https / origin / redirect / body-cap checks, the MCP
// client, tools/list paging, normalization, toolKey and cache all run as
// production. NOT covered here: the guard's connect-time IP vetting (the
// seam drops its pinned-lookup dispatcher) — that lives in
// connector-inventory-safe-fetch.test.ts. This is wiring coverage, not SSRF
// coverage. No external network.
// ---------------------------------------------------------------------------

const USER = 'user-747';
const CONNECTOR_ID = 'inventory-fake';
const HOST = 'mcp.inventory.test';
const SECRET = 'sk-test-747';
/** The agent `h.ctx()` names when a test does not pick one. */
const DEFAULT_AGENT = 'test-agent';

let container: StartedPostgreSqlContainer;
let connectionString: string;
let mcpHttp: Server;
let mcpPort: number;
let savedCredentialsKey: string | undefined;
const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
const harnesses: TestHarness[] = [];

/** One stateless MCP server per path, each with its own tool set. */
function mcpServerFor(path: string): McpServer {
  const server = new McpServer({ name: `fake${path}`, version: '0.0.0' });
  if (path === '/primary') {
    server.registerTool(
      'search_issues',
      {
        title: 'Search issues',
        description: 'Find issues',
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async () => ({ content: [] }),
    );
    server.registerTool(
      'create_issue',
      { description: 'Open a new issue', annotations: { readOnlyHint: false, openWorldHint: true } },
      async () => ({ content: [] }),
    );
  } else {
    server.registerTool('ping', { description: 'Ping' }, async () => ({ content: [] }));
  }
  return server;
}

beforeAll(async () => {
  savedCredentialsKey = process.env.AX_CREDENTIALS_KEY;
  process.env.AX_CREDENTIALS_KEY = '47'.repeat(32);
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();

  mcpHttp = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    seen.push({ path, headers: req.headers });
    if (path !== '/primary' && path !== '/secondary') {
      res.writeHead(404).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = mcpServerFor(path);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((resolve) => mcpHttp.listen(0, '127.0.0.1', resolve));
  mcpPort = (mcpHttp.address() as AddressInfo).port;
}, 60_000);

afterEach(async () => {
  seen.length = 0;
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    try {
      const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>('database:get-instance', h.ctx(), {});
      await sql`DROP TABLE IF EXISTS mcp_client_v1_tool_inventory`.execute(db);
      await sql`DROP TABLE IF EXISTS connectors_v1_connectors`.execute(db);
      // The vault lives in the KV table: drop it so no test sees another's key.
      await sql`DROP TABLE IF EXISTS storage_postgres_v1_kv`.execute(db);
    } catch {
      /* best effort */
    }
    await h.close({ onError: () => {} });
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => (mcpHttp ? mcpHttp.close(() => resolve()) : resolve()));
  if (container) await stopPostgresContainer(container);
  if (savedCredentialsKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
  else process.env.AX_CREDENTIALS_KEY = savedCredentialsKey;
});

/** The guard's socket-level test seam: forward to loopback, nothing else. */
async function loopbackFetch(url: string, init: Record<string, unknown>): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== HOST) {
    throw new Error(`fake MCP host only serves https://${HOST}, got ${url}`);
  }
  const { dispatcher: _dispatcher, ...rest } = init;
  return fetch(`http://127.0.0.1:${mcpPort}${target.pathname}${target.search}`, rest as RequestInit);
}

async function boot(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      // describe-tools calls it only when an agentId is named; the TASK-842
      // case below names one (the session's agent), attached to the connector.
      'agents:resolve': async () => ({
        agent: { connectorAttachments: [CONNECTOR_ID], connectorExclusions: [] },
      }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createStoragePostgresPlugin(),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      createConnectorsPlugin(),
      createToolDispatcherPlugin(),
      createMcpClientPlugin({
        connectorToolInventory: true,
        connectorInventoryListTools: (opts: ListServerToolsOptions) =>
          listServerTools({ ...opts, baseFetch: loopbackFetch }),
      }),
    ],
  });
  harnesses.push(h);
  return h;
}

/** The documented derivation (pinned in @ax/connectors' tool-namespace suite),
 *  recomputed here so a namespace paired with the wrong server is caught. */
function expectedNamespace(owner: string, connectorId: string, server: string): string {
  return (
    'c' +
    createHash('sha256')
      .update(`ax-connector-tool-namespace/v1\0${owner}\0${connectorId}\0${server}`)
      .digest('hex')
      .slice(0, 10)
  );
}

async function seedConnector(h: TestHarness): Promise<ResolveOutput> {
  const input: UpsertInput = {
    userId: USER,
    connectorId: CONNECTOR_ID,
    name: 'Inventory fake',
    keyMode: 'personal',
    // Shared: a personal connector's key lives on the AGENT it is added to, and
    // an agent-scope `account:` key is readable only through the one shared
    // definition (TASK-711) that is attached to that agent (the stub above).
    visibility: 'shared',
    capabilities: {
      allowedHosts: [HOST],
      // Bound to `primary` only: `secondary` must be listed without it.
      credentials: [{ slot: 'key', kind: 'api-key', headerName: 'X-Api-Key', server: 'primary' }],
      mcpServers: [
        { name: 'primary', transport: 'http', url: `https://${HOST}/primary`, allowedHosts: [HOST], credentials: [] },
        { name: 'secondary', transport: 'http', url: `https://${HOST}/secondary`, allowedHosts: [HOST], credentials: [] },
      ],
      packages: { npm: [], pypi: [] },
      services: [],
    },
  };
  await h.bus.call('connectors:upsert', h.ctx({ userId: USER }), input);
  return h.bus.call<{ userId: string; connectorId: string }, ResolveOutput>(
    'connectors:resolve',
    h.ctx({ userId: USER }),
    { userId: USER, connectorId: CONNECTOR_ID },
  );
}

/** Store the key the way an agent's Add does: at the plan's scope (the agent) + ref. */
async function storeKey(h: TestHarness, resolved: ResolveOutput, agentId = DEFAULT_AGENT): Promise<void> {
  const entry = resolved.credentialPlan.find((p) => p.slot === 'key');
  expect(entry).toMatchObject({ scope: 'agent' });
  await h.bus.call('credentials:set', h.ctx({ userId: USER, agentId }), {
    scope: 'agent',
    ownerId: agentId,
    ref: entry!.ref,
    kind: 'api-key',
    payload: new TextEncoder().encode(SECRET),
  });
}

// Keys live on the agent (slice 5), so the check names the agent that holds them.
function describeTools(h: TestHarness, force = false): Promise<DescribeToolsOutput> {
  return h.bus.call<unknown, DescribeToolsOutput>('connectors:describe-tools', h.ctx({ userId: USER, agentId: DEFAULT_AGENT }), {
    userId: USER,
    agentId: DEFAULT_AGENT,
    connectorId: CONNECTOR_ID,
    ...(force ? { force: true } : {}),
  });
}

describe('connectors:describe-tools through the real connectors:resolve (TASK-747)', () => {
  it('lists every http server with its own namespace, hints, and the plan-bound credential', async () => {
    const h = await boot();
    const resolved = await seedConnector(h);
    await storeKey(h, resolved);

    const nsPrimary = expectedNamespace(USER, CONNECTOR_ID, 'primary');
    const nsSecondary = expectedNamespace(USER, CONNECTOR_ID, 'secondary');
    // Sanity on the producer side: what @ax/connectors mints is what we expect.
    expect(resolved.toolNamespaces).toEqual([
      { server: 'primary', toolNamespace: nsPrimary },
      { server: 'secondary', toolNamespace: nsSecondary },
    ]);

    const out = await describeTools(h);
    expect(out.status).toBe('ok');
    expect(Number.isNaN(Date.parse(out.checkedAt))).toBe(false);
    expect([...out.tools].sort((a, b) => a.toolKey.localeCompare(b.toolKey))).toEqual(
      [
        {
          name: 'search_issues',
          title: 'Search issues',
          description: 'Find issues',
          readOnly: true,
          outward: false,
          toolKey: `mcp.${nsPrimary}.search_issues`,
        },
        {
          name: 'create_issue',
          title: 'create_issue',
          description: 'Open a new issue',
          readOnly: false,
          outward: true,
          toolKey: `mcp.${nsPrimary}.create_issue`,
        },
        {
          name: 'ping',
          title: 'ping',
          description: 'Ping',
          readOnly: null,
          outward: null,
          toolKey: `mcp.${nsSecondary}.ping`,
        },
      ].sort((a, b) => a.toolKey.localeCompare(b.toolKey)),
    );

    // The credential plan reached the wire: the vaulted key on `primary` (and
    // every request to it), never on `secondary`.
    const primary = seen.filter((r) => r.path === '/primary');
    const secondary = seen.filter((r) => r.path === '/secondary');
    expect(primary.length).toBeGreaterThan(0);
    expect(secondary.length).toBeGreaterThan(0);
    for (const r of primary) expect(r.headers['x-api-key']).toBe(SECRET);
    for (const r of secondary) expect(r.headers['x-api-key']).toBeUndefined();

    // Served from the inventory table on the next call — and (TASK-756) a
    // `force` inside the check window is too: the server was just asked, so
    // asking it again is what the window exists to stop.
    const before = seen.length;
    expect(await describeTools(h)).toEqual(out);
    expect(seen.length).toBe(before);
    const forced = await describeTools(h, true);
    expect(forced).toEqual(out);
    expect(seen.length).toBe(before);
  });

  it('reports needs-auth (and never lists the key-bound server) before the key is stored', async () => {
    const h = await boot();
    await seedConnector(h);
    const out = await describeTools(h);
    expect(out.status).toBe('needs-auth');
    expect(seen.some((r) => r.path === '/primary')).toBe(false);
  });

  it('a key at person scope is refused by the vault, so it never reaches the wire', async () => {
    const h = await boot();
    const resolved = await seedConnector(h);
    const ref = resolved.credentialPlan.find((p) => p.slot === 'key')!.ref;
    await expect(
      h.bus.call('credentials:set', h.ctx({ userId: USER }), {
        scope: 'user',
        ownerId: USER,
        ref,
        kind: 'api-key',
        payload: new TextEncoder().encode(SECRET),
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    const out = await describeTools(h);
    expect(out.status).toBe('needs-auth');
    expect(seen.some((r) => r.path === '/primary')).toBe(false);
  });
});

describe('a runner-reported connector auth failure re-checks it host-side (TASK-842)', () => {
  it('connectors:auth-failure-reported maps the namespace through the real effective set and checks that connector for the session agent', async () => {
    const h = await boot();
    const agentId = 'agent-842';
    const resolved = await seedConnector(h);
    await storeKey(h, resolved, agentId);
    const nsPrimary = expectedNamespace(USER, CONNECTOR_ID, 'primary');
    const sessionCtx = h.ctx({ userId: USER, agentId });

    await h.bus.fire('connectors:auth-failure-reported', sessionCtx, {
      servers: [{ toolNamespace: nsPrimary, status: 'failed' }],
    });

    // The subscriber asked the server itself, with the vaulted key.
    const primary = seen.filter((r) => r.path === '/primary');
    expect(primary.length).toBeGreaterThan(0);
    for (const r of primary) expect(r.headers['x-api-key']).toBe(SECRET);
    // And the answer landed on the (user, session agent, connector) row the
    // rail reads.
    const batch = await h.bus.call<unknown, { statuses: Array<{ connectorId: string; status: string }> }>(
      'connectors:inventory-status-batch',
      h.ctx({ userId: USER }),
      { userId: USER, agentId, connectorIds: [CONNECTOR_ID] },
    );
    expect(batch.statuses).toMatchObject([{ connectorId: CONNECTOR_ID, status: 'ok' }]);

    // A namespace the agent does not have reaches no server.
    const before = seen.length;
    await h.bus.fire('connectors:auth-failure-reported', sessionCtx, {
      servers: [{ toolNamespace: 'c0000000000', status: 'failed' }],
    });
    expect(seen.length).toBe(before);
  });
});
