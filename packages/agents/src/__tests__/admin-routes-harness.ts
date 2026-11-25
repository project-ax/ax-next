// Shared HTTP harness for the /admin/agents suites (admin-routes.test.ts,
// admin-routes-sharing.test.ts): the real @ax/http-server, @ax/auth-better and
// Postgres. Not a test file itself — vitest only collects `*.test.ts`.
//
// A suite calls `useAdminRoutesPostgres()` once at module top level: that
// starts the suite's own container (beforeAll) and stops it (afterAll). Every
// other helper reads that container, so call them inside tests and hooks only.
//
// We sign in via signInAsAdmin (auth:create-bootstrap-user hook) to mint a
// session cookie. Further users are minted directly in postgres against
// auth-better's schema (mintSecondUserCookie), so cross-tenant tests can drive
// distinct user ids without rerunning the bootstrap path (single-subject).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  type TestHarness,
  signInAsAdmin,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAuthBetterPlugin } from '@ax/auth-better';
import { createAgentsPlugin } from '../plugin.js';

export const COOKIE_KEY = randomBytes(32);

let connectionString = '';

/**
 * Start this suite's Postgres container (beforeAll); stop it (afterAll). The
 * start budget matches the package's hookTimeout (and identity-harness.ts):
 * on a busy host the container start-slot queue alone can take 40s of it.
 */
export function useAdminRoutesPostgres(): void {
  let container: StartedPostgreSqlContainer | undefined;
  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = container.getConnectionUri();
  }, 120_000);
  afterAll(async () => {
    if (container) await stopPostgresContainer(container);
  });
}

/** Run `statements` in order on one connection to the suite's database. */
async function onOneClient<R>(
  statements: ReadonlyArray<{ text: string; values?: unknown[] }>,
): Promise<R[]> {
  const pgmod = await import('pg');
  const c = new pgmod.default.Client({ connectionString });
  await c.connect();
  try {
    let rows: R[] = [];
    for (const s of statements) rows = (await c.query(s.text, s.values ?? [])).rows as R[];
    return rows;
  } finally {
    await c.end().catch(() => {});
  }
}

/** Run one statement on the suite's database, outside any plugin. */
export async function query<R = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  return onOneClient<R>([{ text, values }]);
}

export interface BootedStack {
  harness: TestHarness;
  http: HttpServerPlugin;
  port: number;
}

export async function dropAllTables(): Promise<void> {
  await onOneClient(
    [
      'agents_v1_identity',
      'agents_v1_owners',
      'agents_v1_audience_members',
      'agents_v1_agents',
      'auth_better_v1_verifications',
      'auth_better_v1_accounts',
      'auth_better_v1_sessions',
      'auth_better_v1_users',
      'auth_providers',
    ].map((table) => ({ text: `DROP TABLE IF EXISTS ${table}` })),
  );
}

export async function bootStack(
  extraServices: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>> = {},
  allowedModels?: readonly string[],
): Promise<BootedStack> {
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
      ...extraServices,
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
      // Owner-scoped connector resolve stub. 'personal-conn' is the user's own
      // (keyMode personal); 'workspace-conn' is a shared-key connector, which
      // anyone may attach since TASK-827; anything else "isn't owned" (throws).
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
      createAgentsPlugin(allowedModels ? { allowedModels } : {}),
    ],
  });
  return { harness, http, port: http.boundPort() };
}

/**
 * Sign in via the impl-agnostic signInAsAdmin helper (which calls
 * auth:create-bootstrap-user on the bus and signs the returned
 * oneTimeToken with the http-server's cookie key). The returned cookie
 * header round-trips through req.signedCookie as the session token. The
 * admin is "Test Admin" <admin@example.com>. For further users we insert
 * synthetic rows directly into auth-better's tables — see
 * mintSecondUserCookie below.
 */
export async function signIn(stack: BootedStack): Promise<string> {
  const { cookieHeader } = await signInAsAdmin({
    bus: stack.harness.bus,
    cookieKey: COOKIE_KEY,
    displayName: 'Test Admin',
    email: 'admin@example.com',
  });
  return cookieHeader;
}

export interface MintedUser {
  userId: string;
  cookie: string;
  displayName: string;
  email: string;
}

/**
 * Mint a further, non-admin user directly in postgres (separate user_id,
 * distinct email) and create a session row pointing at them. Returns the
 * Cookie-header value with the user's id, name and email. Bypasses the
 * bootstrap hook (which is admin-only) so we can drive cross-tenant tests
 * with a non-admin user.
 *
 * The session token is signed with the same HMAC key the http-server
 * uses, so it round-trips through req.signedCookie as plaintext. (In
 * auth-better, the COOKIE VALUE is the session's `token` column, not its
 * primary-key `id` — see migrations.ts.)
 */
export async function mintSecondUserCookie(displayName = 'User B'): Promise<MintedUser> {
  const userId = `usr_${randomBytes(16).toString('hex')}`;
  const sessionId = `sess_${randomBytes(16).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const email = `user-b-${userId}@example.invalid`;
  const now = new Date();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await onOneClient([
    {
      text: `INSERT INTO auth_better_v1_users (id, email, email_verified, name, image, role, created_at, updated_at)
       VALUES ($1, $2, false, $3, NULL, 'user', $4, $4)
       ON CONFLICT (email) DO NOTHING`,
      values: [userId, email, displayName, now],
    },
    {
      text: `INSERT INTO auth_better_v1_sessions (id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5)`,
      values: [sessionId, userId, token, expiresAt, now],
    },
  ]);

  const { signCookieValue } = await import('@ax/http-server');
  const wire = signCookieValue(COOKIE_KEY, token);
  return { userId, cookie: `ax_auth_session=${wire}`, displayName, email };
}

export interface JsonResponse {
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * One request to the booted server. `headers`, when given, REPLACES the default
 * `X-Requested-With: ax-admin` (pass `{}` to send a write without it); the
 * cookie and the JSON content type are added on top.
 */
export async function http(
  port: number,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  init: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {
    ...(init.headers ?? { 'x-requested-with': 'ax-admin' }),
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
