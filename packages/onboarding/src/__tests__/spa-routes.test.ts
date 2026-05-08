// ---------------------------------------------------------------------------
// GET /setup + GET /setup/static/* — Task 2.8 SPA routes.
//
// Boots: database-postgres + http-server + onboarding (stub deps).
// The dist-spa directory must exist before this test runs; the beforeAll
// hook builds it via `pnpm build:spa` if it's missing.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createOnboardingPlugin } from '../plugin.js';

const COOKIE_KEY = randomBytes(32);
const TEST_TOKEN = 'ax_bs_test-token-for-spa-routes-tests';

// Resolve package root. In the compiled test (dist/__tests__/spa-routes.js)
// this file is at dist/__tests__/ → two levels up is the package root.
// In vitest source mode (running from src/__tests__/) the same logic applies.
const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DIST_SPA = resolve(PKG_ROOT, 'dist-spa');

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();

  // Build the SPA if dist-spa/index.html doesn't exist yet.
  if (!existsSync(resolve(DIST_SPA, 'index.html'))) {
    // spawnSync avoids shell injection (fixed arg list, no user input).
    const result = spawnSync('pnpm', ['run', 'build:spa'], {
      cwd: PKG_ROOT,
      stdio: 'inherit',
      shell: false,
    });
    if (result.status !== 0) {
      throw new Error(`build:spa failed with status ${String(result.status)}`);
    }
  }
}, 120_000);

afterAll(async () => {
  if (container) await container.stop();
});

interface BootedStack {
  harness: TestHarness;
  http: HttpServerPlugin;
  port: number;
}

async function dropTable(): Promise<void> {
  const k = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
  });
  try {
    await sql`DROP TABLE IF EXISTS bootstrap_state`.execute(k);
  } finally {
    await k.destroy().catch(() => {});
  }
}

async function bootStack(): Promise<BootedStack> {
  await dropTable();
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const harness = await createTestHarness({
    services: {
      'auth:create-bootstrap-user': async () => ({ user: { id: 'stub', email: null, displayName: null, isAdmin: true }, oneTimeToken: 'stub-token' }),
      'auth:complete-bootstrap-user': async () => ({ sessionCookie: { name: 'ax_auth_session', value: 'stub', opts: { path: '/', sameSite: 'Lax', maxAge: 60 } } }),
      'auth:require-user': async () => { throw new Error('auth:require-user not expected in spa-routes tests'); },
      'db:transact': async () => { throw new Error('db:transact not expected in spa-routes tests'); },
      'credentials:set': async () => { throw new Error('credentials:set not expected in spa-routes tests'); },
      'agents:create': async () => { throw new Error('agents:create not expected in spa-routes tests'); },
      'storage:set': async () => { throw new Error('storage:set not expected in spa-routes tests'); },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      http,
      createOnboardingPlugin({
        baseUrl: 'http://127.0.0.1',
        envOverride: { AX_BOOTSTRAP_TOKEN: TEST_TOKEN },
      }),
    ],
  });
  return { harness, http, port: http.boundPort() };
}

describe('@ax/onboarding GET /setup + GET /setup/static/*', () => {
  let stack: BootedStack;

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
    await dropTable();
  });

  it('GET /setup before completion → 200 HTML', async () => {
    stack = await bootStack();
    const { port } = stack;

    const res = await fetch(`http://127.0.0.1:${port}/setup`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<!doctype html>');
    // Vite should have rewritten script src to /setup/static/...
    expect(body).toContain('/setup/');
  });

  it('GET /setup after completion → 410', async () => {
    stack = await bootStack();
    const { port } = stack;

    // Force the row to completed status directly in the DB.
    const k = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
    });
    try {
      await sql`UPDATE bootstrap_state SET status = 'completed', completed_at = NOW() WHERE id = 1`.execute(k);
    } finally {
      await k.destroy().catch(() => {});
    }

    const res = await fetch(`http://127.0.0.1:${port}/setup`);
    expect(res.status).toBe(410);
  });

  it('GET /setup/static/<hashed-js-file> → 200 with JS content-type', async () => {
    stack = await bootStack();
    const { port } = stack;

    // Find the hashed JS file that vite built.
    const staticDir = resolve(DIST_SPA, 'static');
    const files = readdirSync(staticDir).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    const jsFile = files[0]!;

    const res = await fetch(`http://127.0.0.1:${port}/setup/static/${jsFile}`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('javascript');
    // Hashed files should get long-lived cache headers.
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('immutable');
  });

  it('GET /setup/static/<hashed-js-file> after completion → 410', async () => {
    stack = await bootStack();
    const { port } = stack;

    const k = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
    });
    try {
      await sql`UPDATE bootstrap_state SET status = 'completed', completed_at = NOW() WHERE id = 1`.execute(k);
    } finally {
      await k.destroy().catch(() => {});
    }

    const staticDir = resolve(DIST_SPA, 'static');
    const files = readdirSync(staticDir).filter((f) => f.endsWith('.js'));
    const jsFile = files[0]!;

    const res = await fetch(`http://127.0.0.1:${port}/setup/static/${jsFile}`);
    expect(res.status).toBe(410);
  });

  it('GET /setup/static/unknown.xyz → 404 (unknown extension)', async () => {
    stack = await bootStack();
    const { port } = stack;

    const res = await fetch(`http://127.0.0.1:${port}/setup/static/unknown.xyz`);
    expect(res.status).toBe(404);
  });

  it('GET /setup/static/%2e%2e%2fetc%2fpasswd → 404 (path traversal guard)', async () => {
    stack = await bootStack();
    const { port } = stack;

    // Browsers normalize ../ in URLs, but the encoded form bypasses that
    // and exercises the server-side traversal guard.
    const res = await fetch(`http://127.0.0.1:${port}/setup/static/%2e%2e%2fetc%2fpasswd`);
    expect(res.status).toBe(404);
  });
});
