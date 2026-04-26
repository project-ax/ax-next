import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAuthPlugin } from '../plugin.js';
import type { HttpRequestLike, User } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: Awaited<ReturnType<typeof createTestHarness>>[] = [];

async function makeHarness() {
  const h = await createTestHarness({
    // Task 4 actually invokes http:register-route; the mock records the
    // calls so this file can stay focused on type-shape + manifest +
    // migration assertions (no full HTTP boot needed). Real-route flow
    // is exercised in oidc.test.ts / dev-bootstrap.test.ts /
    // cookie-session.test.ts.
    services: {
      'http:register-route': async () => ({ unregister: () => {} }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      // devBootstrap config so init has at least one auth path; the
      // env-token here is unrelated to NODE_ENV and is fine in test mode
      // (NODE_ENV is unset → not 'production').
      createAuthPlugin({
        providers: {},
        devBootstrap: { token: 'types-test-token' },
      }),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS auth_v1_sessions');
    await cleanup.query('DROP TABLE IF EXISTS auth_v1_users');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('@ax/auth types + manifest + stubs', () => {
  it('User shape is structurally what callers expect', () => {
    // Compile-time witness — if these property names drift, callers break.
    const u: User = {
      id: 'u1',
      email: 'x@example.com',
      displayName: 'X',
      isAdmin: false,
    };
    expect(u.id).toBe('u1');
    expect(u.isAdmin).toBe(false);
    // null email is permitted (some IdPs omit it).
    const anon: User = { id: 'u2', email: null, displayName: null, isAdmin: true };
    expect(anon.email).toBeNull();
  });

  it('HttpRequestLike duck-types compatibly with @ax/http-server adapters', () => {
    // Structural check — anything with these two fields satisfies the
    // contract. @ax/http-server's HttpRequest has both, so its adapter
    // flows in without an import.
    const fake: HttpRequestLike = {
      headers: {},
      signedCookie: () => null,
    };
    expect(fake.signedCookie('whatever')).toBeNull();
  });

  it('manifest registers exactly the three service hooks', async () => {
    const h = await makeHarness();
    expect(h.bus.hasService('auth:require-user')).toBe(true);
    expect(h.bus.hasService('auth:get-user')).toBe(true);
    expect(h.bus.hasService('auth:create-bootstrap-user')).toBe(true);
    // Spot-check we didn't accidentally register a Task-4-only hook here.
    expect(h.bus.hasService('auth:sign-out')).toBe(false);
  });

  it('init runs the migration so auth_v1_* tables are reachable', async () => {
    const h = await makeHarness();
    // If init had skipped the migration, the next step would 42P01 (relation
    // does not exist). We don't have a typed kysely on the bus, but
    // database:get-instance returns one we can probe.
    // (Re-import kysely sql template to issue a raw probe.)
    const { sql } = await import('kysely');
    const { db } = await h.bus.call<unknown, { db: import('kysely').Kysely<unknown> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM auth_v1_users
    `.execute(db);
    expect(result.rows[0]?.count).toBe('0');
  });
});
