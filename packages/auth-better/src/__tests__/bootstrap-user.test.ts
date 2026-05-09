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
  CompleteBootstrapUserInput,
  CompleteBootstrapUserOutput,
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
  // never invoked here — Task 1.5's hot-reload test exercises the
  // CRUD routes end-to-end with a real http-server.
  //
  // Also mock the credentials envelope hooks. Task 1.5 added them to
  // @ax/auth-better's `calls` because the CRUD routes now go through
  // them on every insert/list. The bootstrap-user tests don't insert
  // any provider rows, so the encrypt mock is never reached — but
  // verifyCalls() runs at boot and refuses to start without the hooks
  // registered. A no-op pass-through is enough to satisfy the gate.
  return createTestHarness({
    services: {
      'http:register-route': async (_ctx, _input) => ({ unregister: () => {} }),
      'credentials:envelope-encrypt': async (_ctx, input) => ({
        ciphertext: Buffer.from((input as { plaintext: string }).plaintext, 'utf8'),
      }),
      'credentials:envelope-decrypt': async (_ctx, input) => ({
        plaintext: Buffer.from((input as { ciphertext: Uint8Array }).ciphertext).toString('utf8'),
      }),
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
    // Pair the oversize displayName with a VALID email so the assertion
    // isolates the displayName-length check (otherwise we'd be uncertain
    // whether email validation tripped first).
    await expect(
      harness.bus.call<CreateBootstrapUserInput, CreateBootstrapUserOutput>(
        'auth:create-bootstrap-user',
        harness.ctx(),
        { displayName: 'x'.repeat(201), email: 'admin@example.com' },
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

  it('rolls back the user insert if the session insert fails', async () => {
    // Regression test for the CR follow-up to f52f5bd. Without the
    // transaction wrap, a session-insert failure leaves an orphan
    // admin row that blocks every subsequent bootstrap attempt
    // (admin-already-exists). With the wrap, the user insert rolls
    // back too and the operator can retry cleanly.
    harness = await bootHarness();

    // Force the session insert to fail by dropping the sessions table
    // out from under the running plugin. The user insert will succeed,
    // the session insert will throw (relation does not exist), and the
    // transaction must roll back the user row.
    const k = new Kysely<AuthBetterDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      await k.schema.dropTable('auth_better_v1_sessions').execute();
    } finally {
      await k.destroy().catch(() => {});
    }

    await expect(
      harness.bus.call<CreateBootstrapUserInput, CreateBootstrapUserOutput>(
        'auth:create-bootstrap-user',
        harness.ctx(),
        { displayName: 'Vinay', email: 'vinay@example.com' },
      ),
    ).rejects.toThrow();

    // Verify rollback: the users table must be empty. If the orphan
    // existed, this count would be 1.
    const verify = new Kysely<AuthBetterDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      const rows = await verify
        .selectFrom('auth_better_v1_users')
        .selectAll()
        .execute();
      expect(rows).toHaveLength(0);
    } finally {
      await verify.destroy().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// auth:complete-bootstrap-user contract.
//
// Covers Task 3.1 of `docs/plans/2026-05-08-first-use-onboarding-impl.md`.
// The hook packages the oneTimeToken from create as a session cookie.
// ---------------------------------------------------------------------------

describe('auth:complete-bootstrap-user contract', () => {
  it('happy path: returned cookie value matches oneTimeToken and opts are correct', async () => {
    harness = await bootHarness();
    const created = await harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', harness.ctx(), {
      displayName: 'Vinay',
      email: 'vinay@example.com',
    });

    const completed = await harness.bus.call<
      CompleteBootstrapUserInput,
      CompleteBootstrapUserOutput
    >('auth:complete-bootstrap-user', harness.ctx(), {
      oneTimeToken: created.oneTimeToken,
    });

    const { sessionCookie } = completed;
    // Cookie value IS the one-time token.
    expect(sessionCookie.value).toBe(created.oneTimeToken);
    // Name matches the configured cookie name.
    expect(sessionCookie.name).toBe('ax_auth_session');
    // Required opts.
    expect(sessionCookie.opts.sameSite).toBe('Lax');
    expect(sessionCookie.opts.path).toBe('/');
    // maxAge matches the default session lifetime (7 days in seconds).
    expect(sessionCookie.opts.maxAge).toBe(7 * 24 * 60 * 60);
    // In the test environment NODE_ENV is not 'production', so secure should
    // be absent (undefined or false). We assert it is NOT `true`.
    expect(sessionCookie.opts.secure).not.toBe(true);
  });

  it('the returned cookie IS a valid session: auth:require-user resolves the admin', async () => {
    harness = await bootHarness();
    const created = await harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', harness.ctx(), {
      displayName: 'Vinay',
      email: 'vinay@example.com',
    });

    const { sessionCookie } = await harness.bus.call<
      CompleteBootstrapUserInput,
      CompleteBootstrapUserOutput
    >('auth:complete-bootstrap-user', harness.ctx(), {
      oneTimeToken: created.oneTimeToken,
    });

    // Build a fake request that carries the session cookie.
    const fakeReq = {
      headers: {} as Record<string, string>,
      signedCookie(name: string): string | null {
        return name === sessionCookie.name ? sessionCookie.value : null;
      },
    };

    const { user } = await harness.bus.call<
      { req: typeof fakeReq },
      { user: User }
    >('auth:require-user', harness.ctx(), { req: fakeReq });

    expect(user.id).toBe(created.user.id);
    expect(user.isAdmin).toBe(true);
    expect(user.email).toBe('vinay@example.com');
  });

  it('ignores the password field — does not throw when password is provided', async () => {
    harness = await bootHarness();
    const created = await harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', harness.ctx(), {
      displayName: 'Vinay',
      email: 'vinay@example.com',
    });

    // Phase 3 defers local password support; providing a password field
    // must be silently ignored, not cause a throw.
    await expect(
      harness.bus.call<CompleteBootstrapUserInput, CompleteBootstrapUserOutput>(
        'auth:complete-bootstrap-user',
        harness.ctx(),
        { oneTimeToken: created.oneTimeToken, password: 'supersecret' },
      ),
    ).resolves.toBeDefined();
  });
});
