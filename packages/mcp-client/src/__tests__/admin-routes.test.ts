import { randomBytes } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { HookBus, bootstrap, makeAgentContext, type Plugin } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAuthPlugin } from '@ax/auth-oidc';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createToolDispatcherPlugin } from '@ax/tool-dispatcher';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createMcpClientPlugin } from '../plugin.js';
import { ADMIN_BODY_MAX_BYTES } from '../admin-routes.js';
import type { McpClientTransport } from '../transports.js';
import { saveConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Admin MCP-server endpoints — POST/GET/PATCH/DELETE/POST:test
// /admin/mcp-servers[/:id][/test].
//
// Test stack mirrors @ax/agents/admin-routes.test.ts: real http-server +
// real auth (signed cookies) + real postgres for auth's session store.
// MCP storage itself goes through @ax/credentials' storage hooks (which we
// bind to an in-memory map) — the postgres dependency is purely for the
// auth tables.
//
// Cross-tenant test (Acceptance 6) is mandatory: User A creates a config,
// User B's GET /admin/mcp-servers MUST NOT include it; User B's GET
// /admin/mcp-servers/:id MUST 404.
//
// The /test happy path uses a paired InMemoryTransport so we never reach
// out of process — both the real and the test code paths exercise the
// SAME `McpConnection.connect() + listTools()` code, just with the
// transport seam shimmed.
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const DEV_TOKEN = 'mcp-admin-routes-test-bootstrap-token';
const CREDENTIALS_KEY_HEX = '42'.repeat(32);

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  if (container) await container.stop();
});

interface BootedStack {
  harness: TestHarness;
  http: HttpServerPlugin;
  port: number;
  /** Transport map keyed by config id — populated per test for /test happy
   *  paths and the connection-failure path. */
  transports: Map<string, McpClientTransport>;
  /** Server-side handles to dispose once the test ends. */
  serverDisposers: Array<() => Promise<void>>;
}

async function dropAllTables(): Promise<void> {
  const pgmod = await import('pg');
  const c = new pgmod.default.Client({ connectionString });
  await c.connect();
  try {
    await c.query('DROP TABLE IF EXISTS auth_v1_sessions');
    await c.query('DROP TABLE IF EXISTS auth_v1_users');
  } finally {
    await c.end().catch(() => {});
  }
}

/**
 * In-memory storage plugin — the mcp-client config layer reads/writes via
 * storage:get / storage:set, so we don't need a sqlite/postgres backend
 * for the MCP rows themselves. Mirrors the helper used by mcp-client's
 * existing plugin.test.ts.
 */
function memStoragePlugin(): Plugin {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: ['storage:get', 'storage:set'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService(
        'storage:get',
        'mem-storage',
        async (_ctx, input) => {
          const { key } = input as { key: string };
          return { value: store.get(key) };
        },
      );
      bus.registerService(
        'storage:set',
        'mem-storage',
        async (_ctx, input) => {
          const { key, value } = input as { key: string; value: Uint8Array };
          store.set(key, value);
        },
      );
    },
  };
}

async function bootStack(opts: {
  testTimeoutMs?: number;
  failingTransport?: boolean;
} = {}): Promise<BootedStack> {
  await dropAllTables();
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  process.env.AX_CREDENTIALS_KEY = CREDENTIALS_KEY_HEX;

  const transports = new Map<string, McpClientTransport>();
  const serverDisposers: Array<() => Promise<void>> = [];

  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });

  const mcp = createMcpClientPlugin({
    mountAdminRoutes: true,
    // Boot-time transportFactory: mcp-client tries to connect to enabled
    // configs at init. We have none yet (storage is empty), so this is
    // unreachable on init — but it's also the seam used for the /test
    // endpoint when testTransportFactory is undefined. We point both at
    // the test-managed map.
    transportFactory: async ({ config }) => {
      const t = transports.get(config.id);
      if (t === undefined) throw new Error(`no fake transport for ${config.id}`);
      return t;
    },
    testTransportFactory: opts.failingTransport
      ? async () => {
          // Returns a transport whose start() throws — exercises the
          // /test failure path (200 ok:false).
          return {
            async start() {
              throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
            },
            async send() {},
            async close() {},
          } as unknown as McpClientTransport;
        }
      : async ({ config }) => {
          const t = transports.get(config.id);
          if (t === undefined) throw new Error(`no fake transport for ${config.id}`);
          return t;
        },
    ...(opts.testTimeoutMs !== undefined ? { testTimeoutMs: opts.testTimeoutMs } : {}),
  });

  const harness = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      memStoragePlugin(),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      createToolDispatcherPlugin(),
      http,
      createAuthPlugin({ providers: {}, devBootstrap: { token: DEV_TOKEN } }),
      mcp,
    ],
  });

  return { harness, http, port: http.boundPort(), transports, serverDisposers };
}

async function makeFakeMcpServer(opts: {
  tools: Array<{ name: string; description?: string; inputSchema: object }>;
}): Promise<{
  clientTransport: McpClientTransport;
  dispose: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: 'fake-mcp', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: opts.tools }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text' as const, text: 'unused' }],
  }));
  await server.connect(serverTransport);
  return {
    clientTransport: clientTransport as unknown as McpClientTransport,
    dispose: async () => {
      await server.close();
    },
  };
}

async function signIn(stack: BootedStack): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${stack.port}/auth/dev-bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
    },
    body: JSON.stringify({ token: DEV_TOKEN, displayName: 'User A' }),
  });
  expect(r.status).toBe(200);
  const setCookie =
    r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
  const cookieHeader = setCookie.find((c) => c.startsWith('ax_auth_session='));
  if (cookieHeader === undefined) throw new Error('no session cookie returned');
  return cookieHeader.split(';')[0]!;
}

/** Mint a SECOND user via raw SQL (separate user_id, distinct subject) and
 *  forge a signed session cookie for them. Mirrors the agents admin test. */
async function mintSecondUserCookie(): Promise<{ userId: string; cookie: string }> {
  const pgmod = await import('pg');
  const c = new pgmod.default.Client({ connectionString });
  await c.connect();
  try {
    const userId = 'usr_test_b';
    const subjectId = `bootstrap-test-b-${randomBytes(4).toString('hex')}`;
    await c.query(
      `INSERT INTO auth_v1_users (user_id, auth_subject_id, auth_provider, email, display_name, is_admin)
       VALUES ($1, $2, 'dev-bootstrap', NULL, 'User B', false)
       ON CONFLICT (auth_provider, auth_subject_id) DO NOTHING`,
      [userId, subjectId],
    );
    const sessionId = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await c.query(
      `INSERT INTO auth_v1_sessions (session_id, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [sessionId, userId, expiresAt],
    );
    const { signCookieValue } = await import('@ax/http-server');
    const wire = signCookieValue(COOKIE_KEY, sessionId);
    return { userId, cookie: `ax_auth_session=${wire}` };
  } finally {
    await c.end().catch(() => {});
  }
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown> | null;
}

async function http(
  port: number,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  init: { cookie?: string; body?: unknown } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {
    'x-requested-with': 'ax-admin',
  };
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let parsed: Record<string, unknown> | null = null;
  const text = await r.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  return { status: r.status, body: parsed };
}

interface SerializedConfig {
  id: string;
  enabled: boolean;
  transport: string;
  ownerId: string | null;
  credentialRefs?: Record<string, string>;
  headerCredentialRefs?: Record<string, string>;
  url?: string;
  command?: string;
  args?: string[];
}

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fs',
    enabled: true,
    transport: 'stdio',
    command: 'mcp-server-filesystem',
    args: ['/tmp'],
    ...overrides,
  };
}

describe('@ax/mcp-client admin routes', () => {
  let stack: BootedStack;

  beforeEach(async () => {
    stack = await bootStack();
  });

  afterEach(async () => {
    if (stack !== undefined) {
      // Dispose any fake MCP servers paired during the test before
      // closing the harness — the harness shutdown drops admin routes
      // and unwinds plugin state, but doesn't know about external
      // resources tests created.
      for (const dispose of stack.serverDisposers) {
        try {
          await dispose();
        } catch {
          // ignored
        }
      }
      await stack.harness.close({ onError: () => {} });
    }
    await dropAllTables();
    delete process.env.AX_CREDENTIALS_KEY;
  });

  // -------------------------------------------------------------------------
  // POST /admin/mcp-servers
  // -------------------------------------------------------------------------

  it('POST /admin/mcp-servers anonymous → 401', async () => {
    const r = await http(stack.port, 'POST', '/admin/mcp-servers', {
      body: makeBody(),
    });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthenticated' });
  });

  it('POST /admin/mcp-servers with cookie → 201 + ownerId stamped to caller', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie,
      body: makeBody({ id: 'created-by-a' }),
    });
    expect(r.status).toBe(201);
    const cfg = (r.body as { config: SerializedConfig }).config;
    expect(cfg.id).toBe('created-by-a');
    expect(cfg.transport).toBe('stdio');
    expect(typeof cfg.ownerId).toBe('string');
    expect(cfg.ownerId).not.toBeNull();
  });

  it('POST rejects an inline secret via the existing rejectInlineSecrets gate', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie,
      body: makeBody({ env: { TOKEN: 'ghp_xxx' } }),
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/inline secret/i);
  });

  it('POST refuses a duplicate id with 409', async () => {
    const cookie = await signIn(stack);
    const first = await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie,
      body: makeBody({ id: 'dup' }),
    });
    expect(first.status).toBe(201);
    const second = await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie,
      body: makeBody({ id: 'dup' }),
    });
    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toBe('already-exists');
  });

  it('POST rejects bodies > 64 KiB with 413', async () => {
    const cookie = await signIn(stack);
    const huge = 'a'.repeat(ADMIN_BODY_MAX_BYTES + 1024);
    const r = await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie,
      body: makeBody({ args: [huge] }),
    });
    expect(r.status).toBe(413);
  });

  // -------------------------------------------------------------------------
  // GET /admin/mcp-servers (list)
  // -------------------------------------------------------------------------

  it('GET /admin/mcp-servers returns own configs only (cross-tenant)', async () => {
    // Acceptance test 6 — cross-tenant pin.
    const cookieA = await signIn(stack);
    const aCreate = await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie: cookieA,
      body: makeBody({ id: 'alpha' }),
    });
    expect(aCreate.status).toBe(201);

    const { cookie: cookieB } = await mintSecondUserCookie();
    const bCreate = await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie: cookieB,
      body: makeBody({ id: 'beta' }),
    });
    expect(bCreate.status).toBe(201);

    const aList = await http(stack.port, 'GET', '/admin/mcp-servers', {
      cookie: cookieA,
    });
    expect(aList.status).toBe(200);
    const aIds = (aList.body as { configs: SerializedConfig[] }).configs.map((c) => c.id);
    expect(aIds.sort()).toEqual(['alpha']);

    const bList = await http(stack.port, 'GET', '/admin/mcp-servers', {
      cookie: cookieB,
    });
    expect(bList.status).toBe(200);
    const bIds = (bList.body as { configs: SerializedConfig[] }).configs.map((c) => c.id);
    expect(bIds.sort()).toEqual(['beta']);
  });

  it('GET admin-global config (ownerId=null) is visible to non-owner users', async () => {
    // Pre-seed an admin-global row directly via saveConfig — this is the
    // "legacy / global" shape (ownerId null).
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await saveConfig(stack.harness.bus, ctx, {
      id: 'global-shared',
      enabled: true,
      transport: 'stdio',
      command: 'mcp-server-shared',
      args: [],
      ownerId: null,
    });
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'GET', '/admin/mcp-servers', { cookie });
    expect(r.status).toBe(200);
    const ids = (r.body as { configs: SerializedConfig[] }).configs.map((c) => c.id);
    expect(ids).toContain('global-shared');
  });

  // -------------------------------------------------------------------------
  // GET /admin/mcp-servers/:id (single)
  // -------------------------------------------------------------------------

  it('GET /:id (own config) → 200 with credential refs preserved but values absent', async () => {
    // Credential-leak regression. We pre-populate a credential and a
    // config that REFERENCES it via credentialRefs; the GET response
    // body must contain the ref id (`cred-foo`) but NOT the resolved
    // value (`super-secret-value`).
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await stack.harness.bus.call('credentials:set', ctx, {
      ref: 'cred-foo',
      userId: 'u',
      kind: 'api-key',
      payload: new TextEncoder().encode('super-secret-value'),
    });
    const cookie = await signIn(stack);
    const create = await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie,
      body: {
        id: 'with-cred',
        enabled: true,
        transport: 'stdio',
        command: 'fake',
        args: [],
        // Use 'authKey' rather than 'api_key' / 'token' — both of those
        // match rejectInlineSecrets' SECRET_LIKE name set even on a
        // credentialRefs map (the inline-secret guard inspects KEY names
        // recursively to catch e.g. {env:{TOKEN:'…'}} mistakes; the
        // tradeoff is that ref maps can't use those exact key names).
        credentialRefs: { authKey: 'cred-foo' },
      },
    });
    expect(create.status).toBe(201);

    const r = await http(stack.port, 'GET', '/admin/mcp-servers/with-cred', {
      cookie,
    });
    expect(r.status).toBe(200);
    const wire = JSON.stringify(r.body);
    expect(wire).toContain('cred-foo');
    expect(wire).not.toContain('super-secret-value');
  });

  it('GET /:id (other user’s config) → 404 (cross-tenant leak prevention)', async () => {
    const cookieA = await signIn(stack);
    await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie: cookieA,
      body: makeBody({ id: 'alpha' }),
    });
    const { cookie: cookieB } = await mintSecondUserCookie();
    const r = await http(stack.port, 'GET', '/admin/mcp-servers/alpha', {
      cookie: cookieB,
    });
    expect(r.status).toBe(404);
  });

  it('GET /:id non-existent → 404', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'GET', '/admin/mcp-servers/no-such-thing', {
      cookie,
    });
    expect(r.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PATCH /admin/mcp-servers/:id — owner only
  // -------------------------------------------------------------------------

  it('PATCH own config → 200 with patched fields', async () => {
    const cookie = await signIn(stack);
    const create = await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie,
      body: makeBody({ id: 'patch-me', enabled: true }),
    });
    expect(create.status).toBe(201);
    const r = await http(stack.port, 'PATCH', '/admin/mcp-servers/patch-me', {
      cookie,
      body: { enabled: false },
    });
    expect(r.status).toBe(200);
    const cfg = (r.body as { config: SerializedConfig }).config;
    expect(cfg.enabled).toBe(false);
    // Patch must NOT change ownerId (defense against owner-hijack).
    expect(cfg.ownerId).not.toBeNull();
  });

  it('PATCH other user’s config → 404', async () => {
    const cookieA = await signIn(stack);
    await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie: cookieA,
      body: makeBody({ id: 'a-only' }),
    });
    const { cookie: cookieB } = await mintSecondUserCookie();
    const r = await http(stack.port, 'PATCH', '/admin/mcp-servers/a-only', {
      cookie: cookieB,
      body: { enabled: false },
    });
    expect(r.status).toBe(404);
  });

  it('PATCH admin-global config → 403 (read-visible but not write-allowed)', async () => {
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await saveConfig(stack.harness.bus, ctx, {
      id: 'global-shared',
      enabled: true,
      transport: 'stdio',
      command: 'shared',
      args: [],
      ownerId: null,
    });
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'PATCH', '/admin/mcp-servers/global-shared', {
      cookie,
      body: { enabled: false },
    });
    expect(r.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // DELETE /admin/mcp-servers/:id — owner only
  // -------------------------------------------------------------------------

  it('DELETE own config → 204; subsequent GET → 404', async () => {
    const cookie = await signIn(stack);
    await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie,
      body: makeBody({ id: 'del-me' }),
    });
    const del = await http(stack.port, 'DELETE', '/admin/mcp-servers/del-me', {
      cookie,
    });
    expect(del.status).toBe(204);
    const get = await http(stack.port, 'GET', '/admin/mcp-servers/del-me', {
      cookie,
    });
    expect(get.status).toBe(404);
  });

  it('DELETE other user’s config → 404', async () => {
    const cookieA = await signIn(stack);
    await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie: cookieA,
      body: makeBody({ id: 'a-only-del' }),
    });
    const { cookie: cookieB } = await mintSecondUserCookie();
    const r = await http(stack.port, 'DELETE', '/admin/mcp-servers/a-only-del', {
      cookie: cookieB,
    });
    expect(r.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // POST /admin/mcp-servers/:id/test
  // -------------------------------------------------------------------------

  it('POST :id/test (own config, server alive) → 200 ok:true with toolCount', async () => {
    const fake = await makeFakeMcpServer({
      tools: [
        { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
        { name: 'reverse', inputSchema: { type: 'object' } },
      ],
    });
    stack.transports.set('alive', fake.clientTransport);
    stack.serverDisposers.push(fake.dispose);

    const cookie = await signIn(stack);
    await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie,
      body: makeBody({ id: 'alive', transport: 'stdio', command: 'x', args: [] }),
    });
    const r = await http(stack.port, 'POST', '/admin/mcp-servers/alive/test', {
      cookie,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      toolCount: 2,
      toolNames: expect.arrayContaining(['echo', 'reverse']),
    });
  });

  it('POST :id/test (other user’s config) → 404', async () => {
    const cookieA = await signIn(stack);
    await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie: cookieA,
      body: makeBody({ id: 'a-only-test' }),
    });
    const { cookie: cookieB } = await mintSecondUserCookie();
    const r = await http(stack.port, 'POST', '/admin/mcp-servers/a-only-test/test', {
      cookie: cookieB,
    });
    expect(r.status).toBe(404);
  });

  it('POST :id/test (connection failure) → 200 ok:false with sanitized error', async () => {
    // Re-boot the stack with a /test transport that throws on start().
    await stack.harness.close({ onError: () => {} });
    stack = await bootStack({ failingTransport: true });

    const cookie = await signIn(stack);
    await http(stack.port, 'POST', '/admin/mcp-servers', {
      cookie,
      body: makeBody({ id: 'broken' }),
    });
    const r = await http(stack.port, 'POST', '/admin/mcp-servers/broken/test', {
      cookie,
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    // The error must be a code, not a stack trace or remote message.
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeLessThan(64);
    // No raw 'boom' message (the underlying error.message), no stack.
    expect(body.error).not.toContain('boom');
    expect(body.error).not.toContain('at ');
  });

  it('POST :id/test (timeout) → 504', async () => {
    // Boot a stack with an extremely short /test timeout; the test
    // transport-factory below sleeps longer than that before returning,
    // forcing the timeout race to win.
    await stack.harness.close({ onError: () => {} });
    await dropAllTables();
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
    process.env.AX_CREDENTIALS_KEY = CREDENTIALS_KEY_HEX;

    const http2 = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY,
      allowedOrigins: [],
    });
    const sleepPlugin = createMcpClientPlugin({
      mountAdminRoutes: true,
      testTimeoutMs: 50,
      // This factory sleeps 5s before returning, way past the 50ms
      // /test timeout — guaranteed timeout.
      testTransportFactory: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return {
          async start() {},
          async send() {},
          async close() {},
        } as unknown as McpClientTransport;
      },
    });
    const harness2 = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        memStoragePlugin(),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        createToolDispatcherPlugin(),
        http2,
        createAuthPlugin({ providers: {}, devBootstrap: { token: DEV_TOKEN } }),
        sleepPlugin,
      ],
    });
    const port = http2.boundPort();

    try {
      const r0 = await fetch(`http://127.0.0.1:${port}/auth/dev-bootstrap`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'ax-admin',
        },
        body: JSON.stringify({ token: DEV_TOKEN, displayName: 'TO User' }),
      });
      const setCookie =
        r0.headers.getSetCookie?.() ?? [r0.headers.get('set-cookie') ?? ''];
      const cookieHeader = setCookie.find((c) => c.startsWith('ax_auth_session='));
      const cookie = cookieHeader!.split(';')[0]!;
      await http(port, 'POST', '/admin/mcp-servers', {
        cookie,
        body: makeBody({ id: 'slow' }),
      });
      const r = await http(port, 'POST', '/admin/mcp-servers/slow/test', {
        cookie,
      });
      expect(r.status).toBe(504);
    } finally {
      await harness2.close({ onError: () => {} });
    }
    // Re-boot the original stack so afterEach can tear it down without
    // double-close issues. Cheaper than tracking double-close logic.
    stack = await bootStack();
  });

  it('manifest declares the multi-tenant calls when mountAdminRoutes is true', () => {
    const p = createMcpClientPlugin({ mountAdminRoutes: true });
    expect(p.manifest.calls).toEqual(
      expect.arrayContaining(['http:register-route', 'auth:require-user']),
    );
  });

  it('manifest does NOT declare the multi-tenant calls when mountAdminRoutes is false', () => {
    const p = createMcpClientPlugin();
    expect(p.manifest.calls).not.toEqual(
      expect.arrayContaining(['http:register-route']),
    );
    expect(p.manifest.calls).not.toEqual(
      expect.arrayContaining(['auth:require-user']),
    );
  });
});

// ---------------------------------------------------------------------------
// Compiler-only regression: the stub here proves Plugin / HookBus signatures
// match what the test file uses. Caught at type-check; never executed.
// ---------------------------------------------------------------------------
function _typeCheck(_p: Plugin, _b: HookBus): void {
  void bootstrap;
}
