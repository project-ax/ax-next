// ---------------------------------------------------------------------------
// bootstrap:reset-cleanup contract — when the operator-driven
// reset-bootstrap CLI fires this hook, @ax/auth-better must wipe its
// admin user + session rows so a subsequent wizard run can complete.
// Without the wipe, auth:create-bootstrap-user's I6 gate refuses every
// retry with `admin already exists; bootstrap refused`.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAuthBetterPlugin } from '../plugin.js';
import type { AuthBetterDatabase } from '../migrations.js';
import type {
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
} from '@ax/auth-oidc';

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
  return createTestHarness({
    services: {
      'http:register-route': async () => ({ unregister: () => {} }),
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

async function countRows(table: 'auth_better_v1_users' | 'auth_better_v1_sessions'): Promise<number> {
  const k = new Kysely<AuthBetterDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 1 }),
    }),
  });
  try {
    const result = await sql<{ count: string }>`SELECT COUNT(*)::text AS count FROM ${sql.id(table)}`.execute(k);
    return Number(result.rows[0]?.count ?? '0');
  } finally {
    await k.destroy().catch(() => {});
  }
}

describe('@ax/auth-better — bootstrap:reset-cleanup', () => {
  it('wipes admin user + session rows on fire', async () => {
    harness = await bootHarness();

    // Seed: create the bootstrap admin (also creates a session row).
    await harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', harness.ctx(), {
      displayName: 'Vinay',
      email: 'vinay@example.com',
    });
    expect(await countRows('auth_better_v1_users')).toBe(1);
    expect(await countRows('auth_better_v1_sessions')).toBe(1);

    // Fire the cleanup hook.
    const result = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(result.rejected).toBe(false);

    // Both tables should now be empty.
    expect(await countRows('auth_better_v1_users')).toBe(0);
    expect(await countRows('auth_better_v1_sessions')).toBe(0);

    // The follow-on bootstrap call should now succeed (the I6 gate
    // refuses while any admin exists; with the wipe, the next wizard
    // attempt completes).
    const out = await harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', harness.ctx(), {
      displayName: 'Replacement',
      email: 'new@example.com',
    });
    expect(out.user.isAdmin).toBe(true);
  });

  it('is a no-op on an empty install', async () => {
    harness = await bootHarness();
    const result = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(result.rejected).toBe(false);
    expect(await countRows('auth_better_v1_users')).toBe(0);
    expect(await countRows('auth_better_v1_sessions')).toBe(0);
  });
});
