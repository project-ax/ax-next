// ---------------------------------------------------------------------------
// TASK-1247: GET /admin/people against real Postgres.
//
// findPeople's SQL: the start of any word of the name, ignoring case; never
// the email; `%` and `_` are plain characters (no LIKE); at most 10, in name
// order; every name fenced, and a name that fences to nothing is skipped. Then
// the route as the plugin mounts it, through @ax/http-server.
//
// Every invisible or bidi character here is built with String.fromCharCode,
// never typed as an escape (mistakes/2026-11-13-TASK-1093.md).
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  createTestHarness,
  signInAsAdmin,
  startTestContainer,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createCredentialsPlugin } from '@ax/credentials';
import { createHttpServerPlugin, signCookieValue } from '@ax/http-server';
import { createAuthBetterPlugin } from '../plugin.js';
import { runAuthBetterMigration, type AuthBetterDatabase } from '../migrations.js';
import { findPeople } from '../people-search.js';

const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const ELLIPSIS = String.fromCharCode(0x2026);

const COOKIE_KEY = randomBytes(32);
const ORIGINAL_CREDENTIALS_KEY = process.env.AX_CREDENTIALS_KEY;
const ORIGINAL_ALLOW_NO_ORIGINS = process.env.AX_HTTP_ALLOW_NO_ORIGINS;

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
  process.env.AX_CREDENTIALS_KEY = randomBytes(32).toString('hex');
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
}, 60_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
  if (ORIGINAL_CREDENTIALS_KEY === undefined) {
    delete process.env.AX_CREDENTIALS_KEY;
  } else {
    process.env.AX_CREDENTIALS_KEY = ORIGINAL_CREDENTIALS_KEY;
  }
  if (ORIGINAL_ALLOW_NO_ORIGINS === undefined) {
    delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
  } else {
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = ORIGINAL_ALLOW_NO_ORIGINS;
  }
});

function openDb(): Kysely<AuthBetterDatabase> {
  return new Kysely<AuthBetterDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
}

async function dropTables(): Promise<void> {
  const k = openDb();
  try {
    await k.schema.dropTable('auth_providers').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_verifications').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_accounts').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_sessions').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_users').ifExists().execute();
  } finally {
    await k.destroy().catch(() => {});
  }
}

interface SeedUser {
  id: string;
  name: string | null;
  email: string;
  /** Default true. No search rule reads it: see 'alicia keys'. */
  verified?: boolean;
}

async function seed(db: Kysely<AuthBetterDatabase>, users: SeedUser[]): Promise<void> {
  const now = new Date();
  await db
    .insertInto('auth_better_v1_users')
    .values(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        email_verified: u.verified ?? true,
        name: u.name,
        image: null,
        role: 'user' as const,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
}

const LONG_NAME = `Longname${'n'.repeat(192)}`;

/**
 * Inserted out of order, with ids that sort the opposite way to the names
 * (Zara 01 is usr_zara_98), so only ordering by name puts them in name order.
 */
const ZARA_ORDER = [7, 12, 1, 10, 4, 9, 2, 11, 5, 8, 3, 6];
const zaraId = (n: number): string => `usr_zara_${99 - n}`;

const PEOPLE: SeedUser[] = [
  { id: 'usr_alice', name: 'Alice Archer', email: 'alice@example.com' },
  // Unverified: every row is an account (isAxAccount's rule), so a person who
  // hasn't verified an email is still found. The sharing writes accept them.
  { id: 'usr_alicia', name: 'alicia keys', email: 'alicia@example.com', verified: false },
  { id: 'usr_bob', name: 'Bob Stone', email: 'zed@example.com' },
  { id: 'usr_noname', name: null, email: 'noname@example.com' },
  { id: 'usr_blank', name: '   ', email: 'blank@example.com' },
  { id: 'usr_invisible', name: ZWSP.repeat(3), email: 'invisible@example.com' },
  { id: 'usr_pct', name: '50% Off', email: 'pct@example.com' },
  { id: 'usr_underscore', name: 'a_b Person', email: 'ab@example.com' },
  { id: 'usr_eve', name: `Eve${RLO}lyn Moss`, email: 'eve@example.com' },
  { id: 'usr_long', name: LONG_NAME, email: 'long@example.com' },
  ...ZARA_ORDER.map((n) => ({
    id: zaraId(n),
    name: `Zara ${String(n).padStart(2, '0')}`,
    email: `zara${n}@example.com`,
  })),
  // The same name twice, the later id first: ties go by id.
  { id: 'usr_sam_2', name: 'Sam Lee', email: 'sam2@example.com' },
  { id: 'usr_sam_1', name: 'Sam Lee', email: 'sam1@example.com' },
];

describe('findPeople (real Postgres)', () => {
  let db: Kysely<AuthBetterDatabase>;

  beforeAll(async () => {
    await dropTables();
    db = openDb();
    await runAuthBetterMigration(db);
    await seed(db, PEOPLE);
  });

  afterAll(async () => {
    await db?.destroy().catch(() => {});
  });

  it('finds people by the start of any word in their name, ignoring case', async () => {
    expect(await findPeople(db, 'ali')).toEqual([
      { id: 'usr_alice', displayName: 'Alice Archer' },
      { id: 'usr_alicia', displayName: 'alicia keys' },
    ]);
    expect(await findPeople(db, 'ARCH')).toEqual([{ id: 'usr_alice', displayName: 'Alice Archer' }]);
    expect(await findPeople(db, 'alice arch')).toEqual([
      { id: 'usr_alice', displayName: 'Alice Archer' },
    ]);
    expect(await findPeople(db, 'rcher')).toEqual([]);
  });

  it('never matches on email', async () => {
    // Bob Stone's email is zed@example.com; every seeded email is @example.com.
    expect(await findPeople(db, 'zed')).toEqual([]);
    expect(await findPeople(db, 'example')).toEqual([]);
    expect(await findPeople(db, 'alice@example.com')).toEqual([]);
  });

  it('skips people with no name', async () => {
    // A null or blank name never stands in for an email ...
    expect(await findPeople(db, 'noname')).toEqual([]);
    expect(await findPeople(db, 'blank')).toEqual([]);
    // ... and a name made only of invisible characters matches the SQL but
    // fences to nothing, so it is left out rather than sent as an empty name.
    expect(await findPeople(db, ZWSP.repeat(2))).toEqual([]);
  });

  it('treats % and _ as plain characters', async () => {
    expect(await findPeople(db, '50%')).toEqual([{ id: 'usr_pct', displayName: '50% Off' }]);
    expect(await findPeople(db, '5_')).toEqual([]);
    expect(await findPeople(db, 'a_b')).toEqual([{ id: 'usr_underscore', displayName: 'a_b Person' }]);
  });

  it('returns at most 10, in name order', async () => {
    const found = await findPeople(db, 'zara');
    expect(found.map((p) => p.displayName)).toEqual([
      'Zara 01',
      'Zara 02',
      'Zara 03',
      'Zara 04',
      'Zara 05',
      'Zara 06',
      'Zara 07',
      'Zara 08',
      'Zara 09',
      'Zara 10',
    ]);
    expect(found[0]).toEqual({ id: 'usr_zara_98', displayName: 'Zara 01' });
    expect((await findPeople(db, 'sam')).map((p) => p.id)).toEqual(['usr_sam_1', 'usr_sam_2']);
  });

  it('fences each name: bidi and zero-width characters go, long names are cut to 80', async () => {
    expect(await findPeople(db, 'eve')).toEqual([{ id: 'usr_eve', displayName: 'Eve lyn Moss' }]);
    expect(await findPeople(db, 'longname')).toEqual([
      { id: 'usr_long', displayName: `Longname${'n'.repeat(71)}${ELLIPSIS}` },
    ]);
  });

  it('answers only id and displayName', async () => {
    const found = await findPeople(db, 'ali');
    expect(found).toHaveLength(2);
    for (const row of found) {
      expect(Object.keys(row).sort()).toEqual(['displayName', 'id']);
    }
  });
});

describe('GET /admin/people (mounted by the plugin)', () => {
  let harness: TestHarness | undefined;
  let baseUrl: string;
  let cookieHeader: string;
  /** A signed-in person who is NOT an admin (role 'user'): search is for everyone. */
  let memberCookieHeader: string;

  beforeAll(async () => {
    await dropTables();
    const http = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY,
      allowedOrigins: [],
    });
    const blobs = new Map<string, Uint8Array>();
    harness = await createTestHarness({
      services: {
        'credentials:store-blob:get': async (_ctx, input) => {
          const v = blobs.get((input as { ref: string }).ref);
          return v === undefined ? { value: null } : { value: v };
        },
        'credentials:store-blob:put': async (_ctx, input) => {
          const i = input as { ref: string; value: Uint8Array };
          blobs.set(i.ref, i.value);
          return {};
        },
        'credentials:store-blob:list': async () => ({ refs: [...blobs.keys()] }),
        'credentials:store-blob:purge-by-owner': async () => ({ deleted: 0 }),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createCredentialsPlugin(),
        http,
        createAuthBetterPlugin(),
      ],
    });
    baseUrl = `http://127.0.0.1:${http.boundPort()}`;
    ({ cookieHeader } = await signInAsAdmin({ bus: harness.bus, cookieKey: COOKIE_KEY }));
    const db = openDb();
    try {
      await seed(db, [{ id: 'usr_alice', name: 'Alice Archer', email: 'alice@example.com' }]);
      // seed() inserts role 'user'. A session row whose token is the cookie
      // plaintext is what auth:require-user looks up.
      const token = randomBytes(24).toString('base64url');
      const now = new Date();
      await db
        .insertInto('auth_better_v1_sessions')
        .values({
          id: 'ses_member', user_id: 'usr_alice', token, expires_at: new Date(now.getTime() + 3_600_000),
          ip_address: null, user_agent: null, created_at: now, updated_at: now,
        })
        .execute();
      memberCookieHeader = `ax_auth_session=${signCookieValue(COOKIE_KEY, token)}`;
    } finally {
      await db.destroy().catch(() => {});
    }
  });

  afterAll(async () => {
    await harness?.close({ onError: () => {} });
  });

  it('is mounted: 200 for a signed-in person (names only), 401 signed out', async () => {
    const signedIn = await fetch(`${baseUrl}/admin/people?q=ali`, {
      headers: { cookie: cookieHeader },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('cache-control')).toBe('private, no-store');
    const text = await signedIn.text();
    expect(JSON.parse(text)).toEqual({ people: [{ id: 'usr_alice', displayName: 'Alice Archer' }] });
    expect(text).not.toContain('@');

    const signedOut = await fetch(`${baseUrl}/admin/people?q=ali`);
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get('cache-control')).toBe('private, no-store');
    expect(await signedOut.json()).toEqual({ error: 'unauthenticated' });
  });

  it('answers 200 to a signed-in person who is not an admin', async () => {
    const res = await fetch(`${baseUrl}/admin/people?q=ali`, {
      headers: { cookie: memberCookieHeader },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ people: [{ id: 'usr_alice', displayName: 'Alice Archer' }] });
  });

  it('answers 400, not a database error, for a query with a NUL in it', async () => {
    const res = await fetch(`${baseUrl}/admin/people?q=al%00`, {
      headers: { cookie: cookieHeader },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-query' });
  });
});
