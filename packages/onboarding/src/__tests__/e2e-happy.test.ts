// ---------------------------------------------------------------------------
// END-TO-END HAPPY PATH CANARY — Task 2.9
//
// Boots the full plugin chain (database-postgres + storage-postgres +
// credentials-store-db + credentials + agents + http-server + auth-oidc +
// onboarding) and walks the wizard from cold boot to chat-ready.
//
// What makes this different from model-route.test.ts:
//
//   1. Token captured from stdout, not via AX_BOOTSTRAP_TOKEN env override.
//      This proves the printTokenToStdout codepath works as it does in
//      production. We pass a custom stdoutWriter that pushes lines into an
//      array — the token is extracted from that array via regex.
//
//   2. No mocked /setup/admin or /setup/claim auth shortcuts. The full
//      sequence (claim → admin → model) runs through real route handlers and
//      real auth-oidc hooks.
//
//   3. Only global.fetch is mocked, and only for api.anthropic.com requests
//      (the credential probe in completion-tx.ts). Everything else is real.
//
//   4. Post-completion lockdown (I11): after a successful model step, all
//      /setup/* routes must return 410 (or 401 for /setup/admin which gates
//      on the bootstrap-session cookie BEFORE the completion gate — see
//      comment in the test).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createAgentsPlugin } from '@ax/agents';
import { createAuthPlugin } from '@ax/auth-oidc';
import { createOnboardingPlugin } from '../plugin.js';

const COOKIE_KEY = randomBytes(32);
// Required by createAuthPlugin init validation: refuses to load without at
// least one provider OR devBootstrap. Not used in this test — we use the
// onboarding bootstrap token, not the auth-oidc dev-bootstrap path.
const DEV_BOOTSTRAP_TOKEN = 'dev-bootstrap-not-used-in-e2e';
const VALID_ANTHROPIC_KEY = 'sk-ant-fake-e2e-test-key';

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  if (container) await container.stop();
});

async function dropTables(): Promise<void> {
  const k = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
  });
  try {
    await sql`DROP TABLE IF EXISTS bootstrap_state`.execute(k);
    await sql`DROP TABLE IF EXISTS storage_postgres_v1_kv`.execute(k);
    await sql`DROP TABLE IF EXISTS agents_v1_agents`.execute(k);
    await sql`DROP TABLE IF EXISTS auth_v1_sessions`.execute(k);
    await sql`DROP TABLE IF EXISTS auth_v1_users`.execute(k);
    await sql`DROP TABLE IF EXISTS credentials_v1_store`.execute(k);
  } finally {
    await k.destroy().catch(() => {});
  }
}

describe('Onboarding wizard — end-to-end happy path canary', () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close({ onError: () => {} }).catch(() => {});
      harness = undefined;
    }
    await dropTables();
  });

  it('completes from cold boot to chat-ready, then locks down /setup/* (I11)', async () => {
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
    process.env.AX_CREDENTIALS_KEY = '0'.repeat(64); // 32 bytes hex for test

    // 1) Capture stdout lines for token extraction.
    //    We do NOT pass envOverride — the plugin generates its own token on
    //    first boot and calls printTokenToStdout with our stdoutWriter.
    const stdoutLines: string[] = [];

    const originalFetch = global.fetch;
    // 2) Mock global.fetch ONLY for the Anthropic validation URL.
    //    Every other URL (intra-server fetch, etc.) passes through unchanged.
    global.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.startsWith('https://api.anthropic.com')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        );
      }
      return originalFetch(input as Parameters<typeof originalFetch>[0], init);
    };

    try {
      const http = createHttpServerPlugin({
        host: '127.0.0.1',
        port: 0,
        cookieKey: COOKIE_KEY,
        allowedOrigins: [],
      });

      harness = await createTestHarness({
        plugins: [
          createDatabasePostgresPlugin({ connectionString }),
          createStoragePostgresPlugin(),
          http,
          createCredentialsStoreDbPlugin(),
          createCredentialsPlugin(),
          createAgentsPlugin(),
          createAuthPlugin({
            providers: {},
            devBootstrap: { token: DEV_BOOTSTRAP_TOKEN },
          }),
          createOnboardingPlugin({
            baseUrl: `http://127.0.0.1`,
            stdoutWriter: (line) => stdoutLines.push(line),
            // Suppress file write — production writes /var/run/ax/bootstrap-token,
            // here we don't want a file write side-effect.
            tokenFileWriter: async () => {},
            tokenFilePath: '/dev/null/never-used',
          }),
        ],
      });

      const port = (http as HttpServerPlugin).boundPort();

      // 3) Extract the token from captured stdout lines.
      //    printTokenToStdout emits three lines; the token appears on the
      //    second line prefixed by "  token: ax_bs_...". The regex extracts
      //    the token regardless of surrounding text.
      const rawStdout = stdoutLines.join('\n');
      const tokenMatch = rawStdout.match(/ax_bs_[A-Za-z0-9_-]+/);
      expect(tokenMatch, 'bootstrap token should appear in captured stdout').not.toBeNull();
      const token = tokenMatch![0];

      // Sanity: prove the printed token format matches generateToken()'s prefix.
      expect(token).toMatch(/^ax_bs_[A-Za-z0-9_-]+$/);

      // -----------------------------------------------------------------------
      // Step 1 — claim
      // -----------------------------------------------------------------------
      const claimRes = await fetch(`http://127.0.0.1:${port}/setup/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'ax-admin',
        },
        body: JSON.stringify({ token }),
      });
      expect(claimRes.status).toBe(200);

      const claimSetCookies =
        claimRes.headers.getSetCookie?.() ?? [claimRes.headers.get('set-cookie') ?? ''];
      const bootstrapCookie = claimSetCookies
        .find((c) => c.startsWith('ax_bootstrap_session='))
        ?.split(';')[0];
      expect(bootstrapCookie, 'claim should set ax_bootstrap_session cookie').toBeDefined();

      // -----------------------------------------------------------------------
      // Step 2 — admin
      // -----------------------------------------------------------------------
      const adminRes = await fetch(`http://127.0.0.1:${port}/setup/admin`, {
        method: 'POST',
        headers: {
          cookie: bootstrapCookie,
          'content-type': 'application/json',
          'x-requested-with': 'ax-admin',
        },
        body: JSON.stringify({ name: 'Vinay', email: 'v@example.com' }),
      });
      expect(adminRes.status).toBe(200);
      expect((await adminRes.json() as { next: string }).next).toBe('/setup/model');

      const adminSetCookies =
        adminRes.headers.getSetCookie?.() ?? [adminRes.headers.get('set-cookie') ?? ''];
      const authCookie = adminSetCookies
        .find((c) => c.startsWith('ax_auth_session='))
        ?.split(';')[0];
      expect(authCookie, 'admin should set ax_auth_session cookie').toBeDefined();

      // -----------------------------------------------------------------------
      // Step 3 — model
      // -----------------------------------------------------------------------
      const modelRes = await fetch(`http://127.0.0.1:${port}/setup/model`, {
        method: 'POST',
        headers: {
          cookie: authCookie,
          'content-type': 'application/json',
          'x-requested-with': 'ax-admin',
        },
        body: JSON.stringify({
          apiKey: VALID_ANTHROPIC_KEY,
          models: { fast: 'claude-haiku-4-5-20251001', default: 'claude-sonnet-4-6' },
        }),
      });
      expect(modelRes.status).toBe(200);
      const modelBody = await modelRes.json() as { ok: boolean; next: string };
      expect(modelBody.ok).toBe(true);
      expect(modelBody.next).toBe('/');

      // -----------------------------------------------------------------------
      // Cross-surface assertions on system state (full Phase 2 surface)
      // -----------------------------------------------------------------------

      // a) bootstrap:status — must be 'completed'
      const statusOut = await harness.bus.call<unknown, { status: string }>(
        'bootstrap:status',
        harness.ctx(),
        {},
      );
      expect(statusOut.status).toBe('completed');

      // b) credentials:list (scope: global) — exactly one entry, kind 'api-key',
      //    ref 'provider:anthropic'
      const credsOut = await harness.bus.call<
        { scope: string; ownerId: null },
        { credentials: Array<{ ref: string; kind: string }> }
      >('credentials:list', harness.ctx(), { scope: 'global', ownerId: null });
      expect(credsOut.credentials).toHaveLength(1);
      expect(credsOut.credentials[0].kind).toBe('api-key');
      expect(credsOut.credentials[0].ref).toBe('provider:anthropic');

      // c) GET /admin/me — returns the admin user with isAdmin: true.
      //    Also gives us the adminUserId needed for agents:list-for-user.
      const meRes = await fetch(`http://127.0.0.1:${port}/admin/me`, {
        headers: { cookie: authCookie },
      });
      expect(meRes.status).toBe(200);
      const meBody = await meRes.json() as { user: { id: string; isAdmin: boolean } };
      expect(meBody.user.isAdmin).toBe(true);
      const adminUserId = meBody.user.id;

      // d) agents:list-for-user — exactly one agent: 'Default Agent' with
      //    model = the chosen defaultModel ('claude-sonnet-4-6').
      const agentsOut = await harness.bus.call<
        { userId: string; teamIds: string[] },
        { agents: Array<{ displayName: string; model: string }> }
      >('agents:list-for-user', harness.ctx(), { userId: adminUserId, teamIds: [] });
      expect(agentsOut.agents).toHaveLength(1);
      expect(agentsOut.agents[0].displayName).toBe('Default Agent');
      expect(agentsOut.agents[0].model).toBe('claude-sonnet-4-6');

      // e) storage:get('settings:fast-model') — returns the chosen fastModel bytes.
      const fastModelOut = await harness.bus.call<
        { key: string },
        { value: Uint8Array | undefined }
      >('storage:get', harness.ctx(), { key: 'settings:fast-model' });
      expect(fastModelOut.value).toBeDefined();
      expect(new TextDecoder().decode(fastModelOut.value!)).toBe('claude-haiku-4-5-20251001');

      // -----------------------------------------------------------------------
      // Post-completion lockdown (I11)
      // All /setup/* routes must reject — the wizard cannot be replayed.
      // -----------------------------------------------------------------------

      // /setup/claim → 410: the claim handler checks completion FIRST (step 1
      // in routes.ts), before auth or rate-limiting.
      const lockedClaim = await fetch(`http://127.0.0.1:${port}/setup/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'ax-admin',
        },
        body: JSON.stringify({ token }),
      });
      expect(lockedClaim.status).toBe(410);

      // I11: every /setup/* handler (claim, admin, model) runs the
      // completion gate at step 1, before any auth/cookie check, so the
      // operator gets a "wizard done" signal (410) instead of a "session
      // expired" red herring (401).
      const lockedAdmin = await fetch(`http://127.0.0.1:${port}/setup/admin`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'ax-admin',
        },
        body: JSON.stringify({ name: 'X', email: 'x@x.x' }),
      });
      expect(lockedAdmin.status).toBe(410);

      // /setup/model → 410: model handler checks completion FIRST (step 1 in
      // routes.ts model()) before the auth gate.
      const lockedModel = await fetch(`http://127.0.0.1:${port}/setup/model`, {
        method: 'POST',
        headers: {
          cookie: authCookie,
          'content-type': 'application/json',
          'x-requested-with': 'ax-admin',
        },
        body: JSON.stringify({ apiKey: 'sk-ant-x' }),
      });
      expect(lockedModel.status).toBe(410);

      // GET /admin/bootstrap-status → 200 with status='completed'. This is
      // the signal the relocated channel-web wizard uses to know it should
      // redirect /setup → / instead of rendering the dead form. (The HTML
      // for /setup itself is now served by @ax/static-files in
      // production — no separate plugin route, so we assert on the
      // status echo rather than on a 410 from the SPA.)
      const statusRes = await fetch(`http://127.0.0.1:${port}/admin/bootstrap-status`);
      expect(statusRes.status).toBe(200);
      const statusBody = await statusRes.json() as { status: string };
      expect(statusBody.status).toBe('completed');
    } finally {
      global.fetch = originalFetch;
    }
  }, 60_000);
});
