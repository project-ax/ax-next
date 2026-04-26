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
import { createTeamsPlugin } from '../plugin.js';
import { ADMIN_BODY_MAX_BYTES } from '../admin-routes.js';
import type { IsMemberInput, IsMemberOutput } from '../types.js';

// ---------------------------------------------------------------------------
// Admin team endpoints — POST/GET/DELETE /admin/teams[/:id/members[/:userId]].
//
// Mirrors the @ax/agents and @ax/mcp-client admin-routes test structure
// (Tasks 9 / 10): boot a real http-server + auth + postgres testcontainer,
// sign in via dev-bootstrap, drive the routes with `fetch`.
//
// Cross-tenant testing: dev-bootstrap mints a single shared "admin"
// subject. To test User A vs User B isolation we mint a second user
// directly in postgres and forge a session row + signed cookie — same
// trick @ax/agents' admin-routes test uses.
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const DEV_TOKEN = 'teams-admin-routes-test-bootstrap-token';

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
    await c.query('DROP TABLE IF EXISTS teams_v1_memberships');
    await c.query('DROP TABLE IF EXISTS teams_v1_teams');
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
      createTeamsPlugin({ mountAdminRoutes: true }),
    ],
  });
  return { harness, http, port: http.boundPort() };
}

/** Sign in via /auth/dev-bootstrap → returns the cookie value. */
async function signIn(stack: BootedStack, displayName = 'Test Admin'): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${stack.port}/auth/dev-bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
    },
    body: JSON.stringify({ token: DEV_TOKEN, displayName }),
  });
  expect(r.status).toBe(200);
  const setCookie =
    r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
  const cookieHeader = setCookie.find((c) => c.startsWith('ax_auth_session='));
  if (cookieHeader === undefined) throw new Error('no session cookie returned');
  return cookieHeader.split(';')[0]!;
}

/**
 * Mint a SECOND user directly in postgres and create a session row pointing
 * at them. Bypasses dev-bootstrap (which is single-subject) so we can drive
 * the cross-tenant tests without an OIDC fixture. Returns Cookie-header
 * value plus the userId so tests can call teams hooks for the user.
 */
async function mintSecondUserCookie(): Promise<{ userId: string; cookie: string }> {
  const pgmod = await import('pg');
  const c = new pgmod.default.Client({ connectionString });
  await c.connect();
  try {
    const userId = `usr_test_b_${randomBytes(4).toString('hex')}`;
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
  init: { cookie?: string; body?: unknown; rawBody?: string } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {
    'x-requested-with': 'ax-admin',
  };
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  const hasJsonBody = init.body !== undefined;
  if (hasJsonBody || init.rawBody !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const body = hasJsonBody
    ? JSON.stringify(init.body)
    : init.rawBody !== undefined
      ? init.rawBody
      : undefined;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body,
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

interface SerializedTeam {
  id: string;
  displayName: string;
  createdBy: string;
  createdAt: string;
}

interface SerializedMembership {
  teamId: string;
  userId: string;
  role: 'admin' | 'member';
  joinedAt: string;
}

describe('@ax/teams admin routes', () => {
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
  // POST /admin/teams
  // -------------------------------------------------------------------------

  it('POST /admin/teams anonymous → 401', async () => {
    const r = await http(stack.port, 'POST', '/admin/teams', {
      body: { displayName: 'X' },
    });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthenticated' });
  });

  it('POST /admin/teams happy → 201; creator becomes admin', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/teams', {
      cookie,
      body: { displayName: 'Engineering' },
    });
    expect(r.status).toBe(201);
    const team = (r.body as { team: SerializedTeam }).team;
    expect(team.displayName).toBe('Engineering');
    expect(team.id).toMatch(/^team_/);

    // Verify creator is admin via the teams:is-member hook.
    const member = await stack.harness.bus.call<IsMemberInput, IsMemberOutput>(
      'teams:is-member',
      stack.harness.ctx(),
      { teamId: team.id, userId: team.createdBy },
    );
    expect(member).toEqual({ member: true, role: 'admin' });
  });

  it('POST /admin/teams with empty displayName → 400', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/teams', {
      cookie,
      body: { displayName: '' },
    });
    expect(r.status).toBe(400);
    // The teams:create hook surfaces invalid-payload for empty displayName.
    expect((r.body as { error: string }).error).toMatch(/displayName/);
  });

  it('POST /admin/teams with body > 64 KiB → 413', async () => {
    const cookie = await signIn(stack);
    // Build a JSON body just over 64 KiB. displayName will fail validation
    // anyway (it's capped at 128 chars), but the body-size check fires
    // FIRST so the response is 413, not 400.
    const huge = 'a'.repeat(70 * 1024);
    const r = await http(stack.port, 'POST', '/admin/teams', {
      cookie,
      body: { displayName: huge },
    });
    expect(r.status).toBe(413);
    expect((r.body as { error: string }).error).toBe('body-too-large');
  });

  it('POST /admin/teams with malformed JSON → 400', async () => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/teams', {
      cookie,
      rawBody: '{not-json',
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('invalid-json');
  });

  // -------------------------------------------------------------------------
  // GET /admin/teams
  // -------------------------------------------------------------------------

  it('GET /admin/teams anonymous → 401', async () => {
    const r = await http(stack.port, 'GET', '/admin/teams');
    expect(r.status).toBe(401);
  });

  it("GET /admin/teams happy → returns user's teams", async () => {
    const cookie = await signIn(stack);
    await http(stack.port, 'POST', '/admin/teams', {
      cookie,
      body: { displayName: 'Alpha' },
    });
    await http(stack.port, 'POST', '/admin/teams', {
      cookie,
      body: { displayName: 'Beta' },
    });
    const r = await http(stack.port, 'GET', '/admin/teams', { cookie });
    expect(r.status).toBe(200);
    const list = (r.body as { teams: SerializedTeam[] }).teams;
    expect(list.map((t) => t.displayName).sort()).toEqual(['Alpha', 'Beta']);
  });

  it('GET /admin/teams cross-tenant: User A and User B see only their own', async () => {
    const cookieA = await signIn(stack);
    await http(stack.port, 'POST', '/admin/teams', {
      cookie: cookieA,
      body: { displayName: 'A-only Team' },
    });
    const { cookie: cookieB } = await mintSecondUserCookie();
    const rB = await http(stack.port, 'GET', '/admin/teams', { cookie: cookieB });
    expect(rB.status).toBe(200);
    expect((rB.body as { teams: SerializedTeam[] }).teams).toEqual([]);

    const rA = await http(stack.port, 'GET', '/admin/teams', { cookie: cookieA });
    expect(rA.status).toBe(200);
    const aList = (rA.body as { teams: SerializedTeam[] }).teams;
    expect(aList).toHaveLength(1);
    expect(aList[0]!.displayName).toBe('A-only Team');
  });

  // -------------------------------------------------------------------------
  // POST /admin/teams/:id/members
  // -------------------------------------------------------------------------

  it('POST /admin/teams/:id/members admin actor → 201', async () => {
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/teams', {
      cookie: cookieA,
      body: { displayName: 'Eng' },
    });
    const team = (created.body as { team: SerializedTeam }).team;
    const { userId: userB } = await mintSecondUserCookie();
    const r = await http(
      stack.port,
      'POST',
      `/admin/teams/${team.id}/members`,
      {
        cookie: cookieA,
        body: { userId: userB, role: 'member' },
      },
    );
    expect(r.status).toBe(201);
    const m = (r.body as { membership: SerializedMembership }).membership;
    expect(m.teamId).toBe(team.id);
    expect(m.userId).toBe(userB);
    expect(m.role).toBe('member');
  });

  it('POST /admin/teams/:id/members non-admin actor → 403', async () => {
    // User A creates team; User B is added as plain member; User B then
    // tries to add User C (a third user), which should be rejected.
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/teams', {
      cookie: cookieA,
      body: { displayName: 'Eng' },
    });
    const team = (created.body as { team: SerializedTeam }).team;
    const { userId: userB, cookie: cookieB } = await mintSecondUserCookie();
    // User A adds User B as a regular member.
    const addB = await http(
      stack.port,
      'POST',
      `/admin/teams/${team.id}/members`,
      {
        cookie: cookieA,
        body: { userId: userB, role: 'member' },
      },
    );
    expect(addB.status).toBe(201);
    // User B (non-admin) tries to add a third user.
    const r = await http(
      stack.port,
      'POST',
      `/admin/teams/${team.id}/members`,
      {
        cookie: cookieB,
        body: { userId: 'usr_c', role: 'member' },
      },
    );
    expect(r.status).toBe(403);
  });

  it('POST /admin/teams/:id/members on non-existent team → 403 (no existence leak)', async () => {
    const cookie = await signIn(stack);
    const r = await http(
      stack.port,
      'POST',
      '/admin/teams/team_does_not_exist/members',
      {
        cookie,
        body: { userId: 'usr_x', role: 'member' },
      },
    );
    expect(r.status).toBe(403);
  });

  it('POST /admin/teams/:id/members with bad role → 400', async () => {
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/teams', {
      cookie: cookieA,
      body: { displayName: 'Eng' },
    });
    const team = (created.body as { team: SerializedTeam }).team;
    const r = await http(
      stack.port,
      'POST',
      `/admin/teams/${team.id}/members`,
      {
        cookie: cookieA,
        body: { userId: 'usr_x', role: 'super-admin' },
      },
    );
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/role/);
  });

  // -------------------------------------------------------------------------
  // DELETE /admin/teams/:id/members/:userId
  // -------------------------------------------------------------------------

  it('DELETE /admin/teams/:id/members/:userId happy → 204', async () => {
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/teams', {
      cookie: cookieA,
      body: { displayName: 'Eng' },
    });
    const team = (created.body as { team: SerializedTeam }).team;
    const { userId: userB } = await mintSecondUserCookie();
    await http(stack.port, 'POST', `/admin/teams/${team.id}/members`, {
      cookie: cookieA,
      body: { userId: userB, role: 'member' },
    });
    const r = await http(
      stack.port,
      'DELETE',
      `/admin/teams/${team.id}/members/${userB}`,
      { cookie: cookieA },
    );
    expect(r.status).toBe(204);
    // Verify gone via teams:is-member.
    const after = await stack.harness.bus.call<IsMemberInput, IsMemberOutput>(
      'teams:is-member',
      stack.harness.ctx(),
      { teamId: team.id, userId: userB },
    );
    expect(after.member).toBe(false);
  });

  it('DELETE last admin → 400 with cannot-remove-last-admin', async () => {
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/teams', {
      cookie: cookieA,
      body: { displayName: 'Eng' },
    });
    const team = (created.body as { team: SerializedTeam }).team;
    // Try to remove the sole admin (the creator).
    const r = await http(
      stack.port,
      'DELETE',
      `/admin/teams/${team.id}/members/${team.createdBy}`,
      { cookie: cookieA },
    );
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('cannot-remove-last-admin');
  });

  it('DELETE non-existent membership → 404', async () => {
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/teams', {
      cookie: cookieA,
      body: { displayName: 'Eng' },
    });
    const team = (created.body as { team: SerializedTeam }).team;
    const r = await http(
      stack.port,
      'DELETE',
      `/admin/teams/${team.id}/members/usr_never_was`,
      { cookie: cookieA },
    );
    expect(r.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // GET /admin/teams/:id/members
  // -------------------------------------------------------------------------

  it('GET /admin/teams/:id/members admin actor → 200', async () => {
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/teams', {
      cookie: cookieA,
      body: { displayName: 'Eng' },
    });
    const team = (created.body as { team: SerializedTeam }).team;
    const { userId: userB } = await mintSecondUserCookie();
    await http(stack.port, 'POST', `/admin/teams/${team.id}/members`, {
      cookie: cookieA,
      body: { userId: userB, role: 'member' },
    });
    const r = await http(
      stack.port,
      'GET',
      `/admin/teams/${team.id}/members`,
      { cookie: cookieA },
    );
    expect(r.status).toBe(200);
    const list = (r.body as { members: SerializedMembership[] }).members;
    const userIds = list.map((m) => m.userId).sort();
    expect(userIds).toEqual([team.createdBy, userB].sort());
  });

  it('GET /admin/teams/:id/members non-admin actor → 403', async () => {
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/teams', {
      cookie: cookieA,
      body: { displayName: 'Eng' },
    });
    const team = (created.body as { team: SerializedTeam }).team;
    const { userId: userB, cookie: cookieB } = await mintSecondUserCookie();
    await http(stack.port, 'POST', `/admin/teams/${team.id}/members`, {
      cookie: cookieA,
      body: { userId: userB, role: 'member' },
    });
    // userB (member) tries to list members — must be 403.
    const r = await http(
      stack.port,
      'GET',
      `/admin/teams/${team.id}/members`,
      { cookie: cookieB },
    );
    expect(r.status).toBe(403);
  });

  it('GET /admin/teams/:id/members anonymous → 401', async () => {
    const cookieA = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/teams', {
      cookie: cookieA,
      body: { displayName: 'Eng' },
    });
    const team = (created.body as { team: SerializedTeam }).team;
    const r = await http(
      stack.port,
      'GET',
      `/admin/teams/${team.id}/members`,
    );
    expect(r.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Smoke
  // -------------------------------------------------------------------------

  it('ADMIN_BODY_MAX_BYTES is 64 KiB (constant smoke check)', () => {
    expect(ADMIN_BODY_MAX_BYTES).toBe(64 * 1024);
  });
});
