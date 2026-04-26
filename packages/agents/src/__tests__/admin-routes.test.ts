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
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAuthPlugin } from '@ax/auth';
import { createAgentsPlugin } from '../plugin.js';
import { ADMIN_BODY_MAX_BYTES } from '../admin-routes.js';
import type { AgentInput } from '../types.js';

// ---------------------------------------------------------------------------
// Admin agent endpoints — POST/GET/GET:id/PATCH/DELETE /admin/agents[/:id].
//
// Covers:
//   - 401 without cookie
//   - 201 round-trip with cookie
//   - Wildcard rejection (allowedTools+mcpConfigIds both empty) → 400
//   - Field-shape validation: displayName too long → 400
//   - Body too large (> 64 KiB) → 413
//   - visibility:'team' without teamId → 400
//   - visibility:'team' with unknown teamId (no teams plugin) → 403
//   - GET as different user → empty list / 403 on /:id
//   - PATCH own → 200, fields updated; PATCH other → 403
//   - DELETE own → 204, then GET /:id → 404; DELETE absent → 404
//
// We sign in via the dev-bootstrap path to mint a session cookie without
// going through OIDC. A second user is minted via auth:create-bootstrap-user
// (still admin in this env, but with a distinct user_id); the test uses the
// returned oneTimeToken as the session_id directly.
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const DEV_TOKEN = 'admin-routes-test-bootstrap-token';

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
}

async function dropAllTables(): Promise<void> {
  const pgmod = await import('pg');
  const c = new pgmod.default.Client({ connectionString });
  await c.connect();
  try {
    await c.query('DROP TABLE IF EXISTS agents_v1_agents');
    await c.query('DROP TABLE IF EXISTS auth_v1_sessions');
    await c.query('DROP TABLE IF EXISTS auth_v1_users');
  } finally {
    await c.end().catch(() => {});
  }
}

async function bootStack(): Promise<BootedStack> {
  await dropAllTables();
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const harness = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      http,
      createAuthPlugin({ providers: {}, devBootstrap: { token: DEV_TOKEN } }),
      createAgentsPlugin(),
    ],
  });
  return { harness, http, port: http.boundPort() };
}

/**
 * Sign in via /auth/dev-bootstrap. The endpoint mints a cookie tied to the
 * supplied displayName; subsequent calls with the same displayName upsert
 * the same row (one row per provider+subject). To get distinct users we'd
 * need different providers OR distinct subjects — dev-bootstrap pins the
 * subject to 'admin' so a single bootstrap row is shared. For
 * cross-tenant tests we mint a separate user via the upsert hook with a
 * forged subject (test seam — the `auth:create-bootstrap-user` hook reuses
 * the same bootstrap admin, so distinct-user testing uses the store
 * directly via a second harness OR a different mint path).
 *
 * Strategy in this file: dev-bootstrap gives us the FIRST user. For a
 * SECOND user we use auth:create-bootstrap-user with the SAME subject but
 * the test harness ALSO inserts a synthetic 'user-b' row via raw SQL so we
 * can mint a session pointing at it. Keeps us off the OIDC happy-path.
 */
async function signIn(stack: BootedStack): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${stack.port}/auth/dev-bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
    },
    body: JSON.stringify({
      token: DEV_TOKEN,
      displayName: 'Test Admin',
    }),
  });
  expect(r.status).toBe(200);
  const setCookie =
    r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
  const cookieHeader = setCookie.find((c) => c.startsWith('ax_auth_session='));
  if (cookieHeader === undefined) throw new Error('no session cookie returned');
  const value = cookieHeader.split(';')[0]!; // 'ax_auth_session=...'
  return value;
}

/**
 * Mint a SECOND user directly in postgres (separate user_id, distinct
 * provider) and create a session row pointing at them. Returns the
 * Cookie-header value. Bypasses dev-bootstrap (which is single-subject)
 * so we can drive the cross-tenant tests without an OIDC fixture.
 *
 * The session_id is signed with the same HMAC key the http-server uses,
 * so it round-trips through req.signedCookie as plaintext.
 */
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
    // Sign the session_id with the http-server's cookie key so
    // signedCookie() returns it verbatim. We import the cookie helper
    // directly — same module, same key, no leakage.
    const { signCookieValue } = await import('@ax/http-server');
    const wire = signCookieValue(COOKIE_KEY, sessionId);
    return { userId, cookie: `ax_auth_session=${wire}` };
  } finally {
    await c.end().catch(() => {});
  }
}

function makeBody(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    displayName: 'My Agent',
    systemPrompt: 'You are helpful.',
    allowedTools: ['bash.run'],
    mcpConfigIds: [],
    model: 'claude-opus-4-7',
    visibility: 'personal',
    ...overrides,
  };
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

interface SerializedAgent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  workspaceRef: string | null;
}

describe('@ax/agents admin routes', () => {
  let stack: BootedStack;

  beforeEach(async () => {
    stack = await bootStack();
  });

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
    await dropAllTables();
  });

  // -------------------------------------------------------------------------
  // POST /admin/agents
  // -------------------------------------------------------------------------

  it('POST /admin/agents anonymous → 401', async () => {
    const r = await http(stack.port, 'POST', '/admin/agents', {
      body: makeBody(),
    });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthenticated' });
  });

  it('POST /admin/agents with cookie → 201 + agent payload', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody({ displayName: 'Created' }),
    });
    expect(r.status).toBe(201);
    const agent = (r.body as { agent: SerializedAgent }).agent;
    expect(agent.displayName).toBe('Created');
    expect(agent.ownerType).toBe('user');
    expect(agent.visibility).toBe('personal');
  });

  it('POST /admin/agents with allowedTools=[] AND mcpConfigIds=[] → 400 with wildcard reject message', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody({ allowedTools: [], mcpConfigIds: [] }),
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toContain(
      'empty arrays are reserved for dev-mode bypass',
    );
  });

  it('POST /admin/agents with displayName too long → 400', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody({ displayName: 'x'.repeat(200) }),
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/displayName/);
  });

  it('POST /admin/agents with body > 64 KiB → 413', async () => {
    const cookie = await signIn(stack);
    // The store caps systemPrompt at 32 KiB; the API caps the WHOLE body
    // at 64 KiB. Push systemPrompt into the cap range to exceed total
    // body without tripping the http-server's 1 MiB cap.
    const huge = 'a'.repeat(70 * 1024);
    const r = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody({ systemPrompt: huge }),
    });
    expect(r.status).toBe(413);
    expect((r.body as { error: string }).error).toBe('body-too-large');
  });

  it('POST /admin/agents with visibility:team and no teamId → 400', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody({ visibility: 'team' }),
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/teamId/);
  });

  it('POST /admin/agents with visibility:team and unknown teamId (no teams plugin) → 403', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody({ visibility: 'team', teamId: 'unknown_team' }),
    });
    // agents:create's team-member check fails open via try/catch when
    // teams:is-member isn't registered, returning forbidden — surfaces as
    // 403 via our handler's PluginError translation.
    expect(r.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // GET /admin/agents
  // -------------------------------------------------------------------------

  it('GET /admin/agents with cookie → returns the user’s agents', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody({ displayName: 'Agent One' }),
    });
    expect(created.status).toBe(201);
    const r = await http(stack.port, 'GET', '/admin/agents', { cookie });
    expect(r.status).toBe(200);
    const list = (r.body as { agents: SerializedAgent[] }).agents;
    expect(list).toHaveLength(1);
    expect(list[0]!.displayName).toBe('Agent One');
  });

  it('GET /admin/agents anonymous → 401', async () => {
    const r = await http(stack.port, 'GET', '/admin/agents');
    expect(r.status).toBe(401);
  });

  it('GET /admin/agents from a DIFFERENT user → empty', async () => {
    const cookieA = await signIn(stack);
    await http(stack.port, 'POST', '/admin/agents', {
      cookie: cookieA,
      body: makeBody({ displayName: 'A only' }),
    });
    const { cookie: cookieB } = await mintSecondUserCookie();
    const r = await http(stack.port, 'GET', '/admin/agents', { cookie: cookieB });
    expect(r.status).toBe(200);
    expect((r.body as { agents: SerializedAgent[] }).agents).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // GET /admin/agents/:id
  // -------------------------------------------------------------------------

  it('GET /admin/agents/:id (own agent) → 200', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody({ displayName: 'Mine' }),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(stack.port, 'GET', `/admin/agents/${id}`, { cookie });
    expect(r.status).toBe(200);
    expect((r.body as { agent: SerializedAgent }).agent.id).toBe(id);
  });

  it('GET /admin/agents/:id (other user’s agent) → 403', async () => {
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie: cookieA,
      body: makeBody({ displayName: 'A' }),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const { cookie: cookieB } = await mintSecondUserCookie();
    const r = await http(stack.port, 'GET', `/admin/agents/${id}`, {
      cookie: cookieB,
    });
    expect(r.status).toBe(403);
  });

  it('GET /admin/agents/:id (non-existent) → 404', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'GET', '/admin/agents/agt_nonexistent', {
      cookie,
    });
    expect(r.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PATCH /admin/agents/:id
  // -------------------------------------------------------------------------

  it('PATCH own agent → 200 + fields updated', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody({ displayName: 'Original' }),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(stack.port, 'PATCH', `/admin/agents/${id}`, {
      cookie,
      body: { displayName: 'Renamed' },
    });
    expect(r.status).toBe(200);
    expect((r.body as { agent: SerializedAgent }).agent.displayName).toBe('Renamed');
  });

  it('PATCH other user’s agent → 403', async () => {
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie: cookieA,
      body: makeBody({ displayName: 'A' }),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const { cookie: cookieB } = await mintSecondUserCookie();
    const r = await http(stack.port, 'PATCH', `/admin/agents/${id}`, {
      cookie: cookieB,
      body: { displayName: 'Hacked' },
    });
    expect(r.status).toBe(403);
  });

  it('PATCH with allowedTools=[] AND mcpConfigIds=[] → 400 (wildcard reject)', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(stack.port, 'PATCH', `/admin/agents/${id}`, {
      cookie,
      body: { allowedTools: [], mcpConfigIds: [] },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toContain(
      'empty arrays are reserved for dev-mode bypass',
    );
  });

  // -------------------------------------------------------------------------
  // DELETE /admin/agents/:id
  // -------------------------------------------------------------------------

  it('DELETE own agent → 204; subsequent GET → 404', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const del = await http(stack.port, 'DELETE', `/admin/agents/${id}`, {
      cookie,
    });
    expect(del.status).toBe(204);
    const get = await http(stack.port, 'GET', `/admin/agents/${id}`, { cookie });
    expect(get.status).toBe(404);
  });

  it('DELETE non-existent agent → 404', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'DELETE', '/admin/agents/agt_nope', {
      cookie,
    });
    expect(r.status).toBe(404);
  });

  it('ADMIN_BODY_MAX_BYTES is 64 KiB (constant smoke check)', () => {
    // Sanity-check that the constant matches the spec. If a future change
    // tightens or loosens this, this test forces the change to be deliberate.
    expect(ADMIN_BODY_MAX_BYTES).toBe(64 * 1024);
  });
});
