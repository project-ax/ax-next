import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { createAuthBetterPlugin } from '../plugin.js';
import type { AuthBetterDatabase } from '../migrations.js';
import type {
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  User,
} from '@ax/auth-oidc';

// ---------------------------------------------------------------------------
// auth:create-bootstrap-user contract.
//
// Covers Task 1.4 of `docs/plans/2026-05-08-first-use-onboarding-impl.md`.
// We exercise the BUS surface — no HTTP. The /auth/* splat route is
// covered separately once Task 1.5 wires a peer that exercises it
// end-to-end (the admin-credential CRUD + signInAsAdmin helper).
//
// Why no @ax/credentials peer: loadProviders() short-circuits when the
// auth_providers table is empty, so the credentials:envelope-decrypt
// hook is never called. As soon as Task 1.5 inserts a real provider
// row, the host MUST also load @ax/credentials — that's tracked in
// the half-wired-window note.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
let harness: TestHarness | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  if (container) await container.stop();
});

async function dropTables(): Promise<void> {
  const k = new Kysely<AuthBetterDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 1 }),
    }),
  });
  try {
    await k.schema.dropTable('auth_providers').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_sessions').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_users').ifExists().execute();
  } finally {
    await k.destroy().catch(() => {});
  }
}

async function bootHarness(): Promise<TestHarness> {
  await dropTables();
  // Mock `http:register-route` so the bootstrap contract test doesn't
  // need to spin up @ax/http-server (cookie keys, listening sockets,
  // CSRF wiring) just to exercise the bus surface. Each call returns
  // an idempotent unregister stub. The route handler is captured but
  // never invoked here — Task 1.5's tests will exercise the routes
  // end-to-end with a real http-server.
  return createTestHarness({
    services: {
      'http:register-route': async (_ctx, _input) => ({ unregister: () => {} }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createAuthBetterPlugin(),
    ],
  });
}

afterEach(async () => {
  if (harness !== undefined) {
    await harness.close({ onError: () => {} });
    harness = undefined;
  }
});

describe('auth:create-bootstrap-user contract', () => {
  it('creates a user with role=admin and returns a oneTimeToken', async () => {
    harness = await bootHarness();
    const out = await harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', harness.ctx(), {
      displayName: 'Vinay',
      email: 'vinay@example.com',
    });
    expect(out.user.isAdmin).toBe(true);
    expect(out.user.email).toBe('vinay@example.com');
    expect(out.user.displayName).toBe('Vinay');
    // base64url, 32 bytes → 43 chars (no padding).
    expect(out.oneTimeToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it('rejects a second bootstrap call once an admin exists', async () => {
    harness = await bootHarness();
    await harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', harness.ctx(), {
      displayName: 'Vinay',
      email: 'vinay@example.com',
    });
    await expect(
      harness.bus.call<CreateBootstrapUserInput, CreateBootstrapUserOutput>(
        'auth:create-bootstrap-user',
        harness.ctx(),
        { displayName: 'Other', email: 'b@c.de' },
      ),
    ).rejects.toThrow(/already.*bootstrap|admin already exists/i);
  });

  it('auth:get-user returns the bootstrap user; null for unknown id', async () => {
    harness = await bootHarness();
    const created = await harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', harness.ctx(), {
      displayName: 'Vinay',
      email: 'vinay@example.com',
    });

    const found = await harness.bus.call<{ userId: string }, User | null>(
      'auth:get-user',
      harness.ctx(),
      { userId: created.user.id },
    );
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.user.id);
    expect(found?.isAdmin).toBe(true);
    expect(found?.email).toBe('vinay@example.com');

    const missing = await harness.bus.call<{ userId: string }, User | null>(
      'auth:get-user',
      harness.ctx(),
      { userId: 'usr_definitely-not-real' },
    );
    expect(missing).toBeNull();
  });

  it('rejects malformed input (oversize displayName, non-email)', async () => {
    harness = await bootHarness();
    // Oversize displayName — caps at 200 chars.
    await expect(
      harness.bus.call<CreateBootstrapUserInput, CreateBootstrapUserOutput>(
        'auth:create-bootstrap-user',
        harness.ctx(),
        { displayName: 'x'.repeat(201) },
      ),
    ).rejects.toBeInstanceOf(PluginError);

    // Bogus email — no @.
    await expect(
      harness.bus.call<CreateBootstrapUserInput, CreateBootstrapUserOutput>(
        'auth:create-bootstrap-user',
        harness.ctx(),
        { displayName: 'Vinay', email: 'not-an-email' },
      ),
    ).rejects.toBeInstanceOf(PluginError);
  });
});
