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
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAuthBetterPlugin } from '@ax/auth-better';
import { signInAsAdmin } from '@ax/test-harness';
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
// We sign in via signInAsAdmin (auth:create-bootstrap-user hook) to mint a
// session cookie. A SECOND user is minted directly in postgres against
// auth-better's schema so cross-tenant tests can drive a distinct user_id
// without rerunning the bootstrap path (which is single-subject).
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
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
    await c.query('DROP TABLE IF EXISTS auth_better_v1_verifications');
    await c.query('DROP TABLE IF EXISTS auth_better_v1_accounts');
    await c.query('DROP TABLE IF EXISTS auth_better_v1_sessions');
    await c.query('DROP TABLE IF EXISTS auth_better_v1_users');
    await c.query('DROP TABLE IF EXISTS auth_providers');
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
    // Stub skills:resolve so the PATCH /skill-attachments route can resolve
    // skill ids without needing the full @ax/skills plugin in this test scope.
    // TASK-100 — a skill declares NO capabilities; it resolves to id + body +
    // manifest only (its reach is the connectors it references).
    services: {
      'skills:resolve': async (
        _ctx: unknown,
        input: { skillIds: string[]; ownerUserId?: string },
      ) => {
        // GLOBAL catalog skills — resolvable to anyone (no ownerUserId needed).
        const globalSkills = new Set(['github', 'openai', 'linear-a', 'linear-b']);
        // USER-SCOPED skills — only resolvable when ownerUserId is passed
        // (mirrors prod: skills:resolve unions the caller's user store ONLY then).
        // 'my-skill' is cap-free; 'ws-skill' references a WORKSPACE connector
        // (the transitive-grant guard must reject attaching it as a non-admin).
        const userSkills: Record<string, { connectors?: string[] }> = {
          'my-skill': {},
          'ws-skill': { connectors: ['workspace-conn'] },
        };
        const skills: Array<{
          id: string;
          bodyMd: string;
          manifestYaml: string;
          connectors?: string[];
        }> = [];
        for (const id of input.skillIds) {
          const base = { id, bodyMd: 'body', manifestYaml: `name: ${id}\n` };
          if (globalSkills.has(id)) {
            skills.push(base);
          } else if (input.ownerUserId !== undefined && userSkills[id] !== undefined) {
            const conns = userSkills[id]!.connectors;
            skills.push(conns ? { ...base, connectors: conns } : base);
          }
        }
        return { skills };
      },
      // Owner-scoped connector resolve stub for the non-admin attachment guard.
      // 'personal-conn' is the user's own (keyMode personal); 'workspace-conn' is
      // a shared/global-keyed connector; anything else "isn't owned" (throws →
      // treated as a runtime no-op by the guard).
      'connectors:resolve': async (
        _ctx: unknown,
        input: { userId: string; connectorId: string },
      ) => {
        const keyModes: Record<string, 'personal' | 'workspace'> = {
          'personal-conn': 'personal',
          'workspace-conn': 'workspace',
        };
        const keyMode = keyModes[input.connectorId];
        if (keyMode === undefined) throw new Error('connector not found / not owned');
        return { id: input.connectorId, keyMode };
      },
      'credentials:envelope-encrypt': async (_ctx, input) => ({
        ciphertext: Buffer.from((input as { plaintext: string }).plaintext, 'utf8'),
      }),
      'credentials:envelope-decrypt': async (_ctx, input) => ({
        plaintext: Buffer.from((input as { ciphertext: Uint8Array }).ciphertext).toString('utf8'),
      }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      http,
      createAuthBetterPlugin(),
      createAgentsPlugin(),
    ],
  });
  return { harness, http, port: http.boundPort() };
}

/**
 * Sign in via the impl-agnostic signInAsAdmin helper (which calls
 * auth:create-bootstrap-user on the bus and signs the returned
 * oneTimeToken with the http-server's cookie key). The returned cookie
 * header round-trips through req.signedCookie as the session token. For a
 * SECOND user we insert a synthetic row directly into auth-better's
 * tables — see mintSecondUserCookie below.
 */
async function signIn(stack: BootedStack): Promise<string> {
  const { cookieHeader } = await signInAsAdmin({
    bus: stack.harness.bus,
    cookieKey: COOKIE_KEY,
    displayName: 'Test Admin',
    email: 'admin@example.com',
  });
  return cookieHeader;
}

/**
 * Mint a SECOND user directly in postgres (separate user_id, distinct
 * email) and create a session row pointing at them. Returns the
 * Cookie-header value. Bypasses the bootstrap hook (which is admin-only)
 * so we can drive cross-tenant tests with a non-admin user.
 *
 * The session token is signed with the same HMAC key the http-server
 * uses, so it round-trips through req.signedCookie as plaintext. (In
 * auth-better, the COOKIE VALUE is the session's `token` column, not its
 * primary-key `id` — see migrations.ts.)
 */
async function mintSecondUserCookie(): Promise<{ userId: string; cookie: string }> {
  const pgmod = await import('pg');
  const c = new pgmod.default.Client({ connectionString });
  await c.connect();
  try {
    const userId = `usr_${randomBytes(16).toString('hex')}`;
    const sessionId = `sess_${randomBytes(16).toString('hex')}`;
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await c.query(
      `INSERT INTO auth_better_v1_users (id, email, email_verified, name, image, role, created_at, updated_at)
       VALUES ($1, $2, false, $3, NULL, 'user', $4, $4)
       ON CONFLICT (email) DO NOTHING`,
      [userId, `user-b-${userId}@example.invalid`, 'User B', now],
    );
    await c.query(
      `INSERT INTO auth_better_v1_sessions (id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5)`,
      [sessionId, userId, token, expiresAt, now],
    );

    const { signCookieValue } = await import('@ax/http-server');
    const wire = signCookieValue(COOKIE_KEY, token);
    return { userId, cookie: `ax_auth_session=${wire}` };
  } finally {
    await c.end().catch(() => {});
  }
}

function makeBody(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    displayName: 'My Agent',
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

interface SerializedSkillAttachment {
  skillId: string;
  credentialBindings: Record<string, string>;
}

interface SerializedAgent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  workspaceRef: string | null;
  skillAttachments: SerializedSkillAttachment[];
  connectorAttachments: string[];
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
    // The admin API caps the WHOLE body at 64 KiB (well under the
    // http-server's 1 MiB cap). The 413 fires on BODY SIZE, before schema
    // validation — so a giant extra field (rejected by .strict() later, but
    // never reached) exercises the size gate. ~70 KiB clears the cap.
    const huge = 'a'.repeat(70 * 1024);
    const r = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: { ...makeBody(), bloat: huge },
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

  // -------------------------------------------------------------------------
  // PATCH /admin/agents/:id/skill-attachments
  // -------------------------------------------------------------------------

  it('PATCH /admin/agents/:id/skill-attachments with valid attachments → 200 with updated agent', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      {
        cookie,
        body: {
          // TASK-100 — a skill declares no credential slots, so the attachment
          // carries no bindings.
          skillAttachments: [
            { skillId: 'github', credentialBindings: {} },
          ],
        },
      },
    );
    expect(r.status).toBe(200);
    const agent = (r.body as { agent: SerializedAgent }).agent;
    expect(agent.skillAttachments).toEqual([
      { skillId: 'github', credentialBindings: {} },
    ]);
  });

  it('PATCH /admin/agents/:id/skill-attachments with two cap-free skills → 200 ok', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      {
        cookie,
        body: {
          skillAttachments: [
            { skillId: 'github', credentialBindings: {} },
            { skillId: 'openai', credentialBindings: {} },
          ],
        },
      },
    );
    expect(r.status).toBe(200);
    const agent = (r.body as { agent: SerializedAgent }).agent;
    expect(agent.skillAttachments).toHaveLength(2);
  });

  it('PATCH /admin/agents/:id/skill-attachments with orphan binding → 400 binding-orphan', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      {
        cookie,
        body: {
          skillAttachments: [
            { skillId: 'github', credentialBindings: { UNKNOWN_SLOT: 'ref' } },
          ],
        },
      },
    );
    expect(r.status).toBe(400);
    expect((r.body as { code: string }).code).toBe('binding-orphan');
  });

  it('PATCH /admin/agents/:id/skill-attachments with nonexistent skill id → 400 skill-not-found', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      {
        cookie,
        body: {
          skillAttachments: [
            { skillId: 'notareal-skill', credentialBindings: {} },
          ],
        },
      },
    );
    expect(r.status).toBe(400);
    expect((r.body as { code: string }).code).toBe('skill-not-found');
  });

  it('PATCH /admin/agents/:id/skill-attachments — two cap-free skills coexist → 200', async () => {
    // TASK-100 — a skill declares no credential slots, so attaching two skills is
    // never a slot collision; the attachments carry no bindings.
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      {
        cookie,
        body: {
          skillAttachments: [
            { skillId: 'linear-a', credentialBindings: {} },
            { skillId: 'linear-b', credentialBindings: {} },
          ],
        },
      },
    );
    expect(r.status).toBe(200);
  });

  it('PATCH /admin/agents/:id/skill-attachments over the zod max(20) limit → 400', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const overLimit = Array.from({ length: 21 }, () => ({
      skillId: 'github',
      credentialBindings: {},
    }));
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      {
        cookie,
        body: { skillAttachments: overLimit },
      },
    );
    expect(r.status).toBe(400);
  });

  it('PATCH /admin/agents/:id/skill-attachments by a NON-OWNER → 403 (agent ACL)', async () => {
    const cookie = await signIn(stack);
    // Create agent as admin.
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    // Get a non-admin cookie.
    const { cookie: cookieB } = await mintSecondUserCookie();
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      {
        cookie: cookieB,
        body: { skillAttachments: [] },
      },
    );
    expect(r.status).toBe(403);
  });

  it('PATCH /admin/agents/:id/skill-attachments missing/invalid body → 400', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    // No body at all (empty — parseAndValidate will try to parse empty Buffer as {}).
    // Missing required 'skillAttachments' field.
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      {
        cookie,
        body: { notTheRightField: [] },
      },
    );
    expect(r.status).toBe(400);
  });

  it('PATCH /admin/agents/:id/skill-attachments with empty array → 200 + skillAttachments: []', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      {
        cookie,
        body: { skillAttachments: [] },
      },
    );
    expect(r.status).toBe(200);
    const agent = (r.body as { agent: SerializedAgent }).agent;
    expect(agent.skillAttachments).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // PATCH /admin/agents/:id/connector-attachments (TASK-107)
  // -------------------------------------------------------------------------

  it('a freshly created agent serializes connectorAttachments: []', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    expect((created.body as { agent: SerializedAgent }).agent.connectorAttachments).toEqual(
      [],
    );
  });

  it('PATCH /admin/agents/:id/connector-attachments with valid ids → 200 + connectorAttachments persisted', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/connector-attachments`,
      { cookie, body: { connectorAttachments: ['salesforce', 'gh'] } },
    );
    expect(r.status).toBe(200);
    const agent = (r.body as { agent: SerializedAgent }).agent;
    expect(agent.connectorAttachments).toEqual(['salesforce', 'gh']);
    // mcpConfigIds is unaffected — it reverts to MCP-only meaning.
    expect(agent.mcpConfigIds).toEqual(makeBody().mcpConfigIds);

    // Re-read via GET to prove durability.
    const show = await http(stack.port, 'GET', `/admin/agents/${id}`, { cookie });
    expect((show.body as { agent: SerializedAgent }).agent.connectorAttachments).toEqual([
      'salesforce',
      'gh',
    ]);
  });

  it('PATCH /admin/agents/:id/connector-attachments with empty array → 200 + connectorAttachments: []', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    // Attach then detach.
    await http(stack.port, 'PATCH', `/admin/agents/${id}/connector-attachments`, {
      cookie,
      body: { connectorAttachments: ['gh'] },
    });
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/connector-attachments`,
      { cookie, body: { connectorAttachments: [] } },
    );
    expect(r.status).toBe(200);
    expect((r.body as { agent: SerializedAgent }).agent.connectorAttachments).toEqual([]);
  });

  it('PATCH /admin/agents/:id/connector-attachments with a malformed id → 400', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/connector-attachments`,
      { cookie, body: { connectorAttachments: ['Bad Id'] } },
    );
    expect(r.status).toBe(400);
  });

  it('PATCH /admin/agents/:id/connector-attachments by a NON-OWNER → 403 (agent ACL)', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const { cookie: cookieB } = await mintSecondUserCookie();
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/connector-attachments`,
      { cookie: cookieB, body: { connectorAttachments: [] } },
    );
    expect(r.status).toBe(403);
  });

  it('PATCH /admin/agents/:id/connector-attachments missing field → 400', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/connector-attachments`,
      { cookie, body: { notTheRightField: [] } },
    );
    expect(r.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Non-admin OWNER attachment (owner-scoped): a user may attach their OWN
  // PERSONAL connectors/skills to their OWN agents; a workspace (shared/
  // global-keyed) connector — directly or pulled in by a skill — stays
  // admin-only. The agent-ownership ACL is the hook's; this is the keyMode guard.
  // -------------------------------------------------------------------------

  it('connector-attachments: a non-admin OWNER may attach their OWN personal connector → 200', async () => {
    const { cookie } = await mintSecondUserCookie();
    // A non-admin creates THEIR OWN agent (create is requireUser + owner-scoped).
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    expect(created.status).toBe(201);
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/connector-attachments`,
      { cookie, body: { connectorAttachments: ['personal-conn'] } },
    );
    expect(r.status).toBe(200);
    expect((r.body as { agent: SerializedAgent }).agent.connectorAttachments).toEqual([
      'personal-conn',
    ]);
  });

  it('SECURITY: a non-admin OWNER may NOT attach a workspace (shared) connector → 403', async () => {
    const { cookie } = await mintSecondUserCookie();
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/connector-attachments`,
      { cookie, body: { connectorAttachments: ['workspace-conn'] } },
    );
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toMatch(/workspace/i);
    // Nothing was persisted — the guard ran before the store write.
    const show = await http(stack.port, 'GET', `/admin/agents/${id}`, { cookie });
    expect((show.body as { agent: SerializedAgent }).agent.connectorAttachments).toEqual([]);
  });

  it('an ADMIN OWNER may attach a workspace connector → 200 (bypasses the keyMode guard)', async () => {
    const cookie = await signIn(stack);
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/connector-attachments`,
      { cookie, body: { connectorAttachments: ['workspace-conn'] } },
    );
    expect(r.status).toBe(200);
    expect((r.body as { agent: SerializedAgent }).agent.connectorAttachments).toEqual([
      'workspace-conn',
    ]);
  });

  it('skill-attachments: a non-admin OWNER may attach their OWN user-scoped skill → 200', async () => {
    const { cookie } = await mintSecondUserCookie();
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    // 'my-skill' is USER-SCOPED — it resolves only because the route now passes
    // ownerUserId: actor.id to skills:resolve. (Before that fix this 400'd with
    // skill-not-found, silently breaking non-admin skill attachment.)
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      { cookie, body: { skillAttachments: [{ skillId: 'my-skill', credentialBindings: {} }] } },
    );
    expect(r.status).toBe(200);
    expect((r.body as { agent: SerializedAgent }).agent.skillAttachments).toEqual([
      { skillId: 'my-skill', credentialBindings: {} },
    ]);
  });

  it('SECURITY: a non-admin OWNER may NOT attach a skill that pulls in a workspace connector → 403', async () => {
    const { cookie } = await mintSecondUserCookie();
    const created = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody(),
    });
    const id = (created.body as { agent: SerializedAgent }).agent.id;
    // 'ws-skill' references the workspace connector (skills:resolve stub).
    const r = await http(
      stack.port,
      'PATCH',
      `/admin/agents/${id}/skill-attachments`,
      { cookie, body: { skillAttachments: [{ skillId: 'ws-skill', credentialBindings: {} }] } },
    );
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toMatch(/workspace/i);
  });
});
