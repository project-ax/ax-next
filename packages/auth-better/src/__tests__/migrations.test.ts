import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  runAuthBetterMigration,
  type AuthBetterDatabase,
} from '../migrations.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AuthBetterDatabase>[] = [];

function makeKysely(): Kysely<AuthBetterDatabase> {
  const k = new Kysely<AuthBetterDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 2 }),
    }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('auth_providers').ifExists().execute();
      await k.schema.dropTable('auth_better_v1_verifications').ifExists().execute();
      await k.schema.dropTable('auth_better_v1_accounts').ifExists().execute();
      await k.schema.dropTable('auth_better_v1_sessions').ifExists().execute();
      await k.schema.dropTable('auth_better_v1_users').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('runAuthBetterMigration', () => {
  it('creates auth_better_v1_users with the better-auth required columns', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);

    const result = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'auth_better_v1_users'
      ORDER BY column_name
    `.execute(db);

    const cols = result.rows.map((r) => r.column_name).sort();
    expect(cols).toEqual(
      [
        'created_at',
        'email',
        'email_verified',
        'id',
        'image',
        'name',
        'role',
        'updated_at',
      ].sort(),
    );
  });

  it('creates auth_better_v1_sessions with FK to users (cascade on delete)', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);

    // Sanity-check the table exists.
    const tableCheck = await sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'auth_better_v1_sessions'
    `.execute(db);
    expect(tableCheck.rows).toHaveLength(1);

    const now = new Date();
    await db
      .insertInto('auth_better_v1_users')
      .values({
        id: 'u1',
        email: 'a@example.com',
        email_verified: false,
        name: null,
        image: null,
        role: 'user',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await db
      .insertInto('auth_better_v1_sessions')
      .values({
        id: 's1',
        user_id: 'u1',
        token: 't1',
        expires_at: new Date(now.getTime() + 60_000),
        ip_address: null,
        user_agent: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Cascade: delete the user, the session must vanish.
    await db.deleteFrom('auth_better_v1_users').where('id', '=', 'u1').execute();
    const remaining = await db
      .selectFrom('auth_better_v1_sessions')
      .selectAll()
      .execute();
    expect(remaining).toHaveLength(0);
  });

  it('creates auth_providers with client_secret_encrypted BYTEA column', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);

    const result = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'auth_providers'
      ORDER BY column_name
    `.execute(db);
    const cols = result.rows.map((r) => r.column_name).sort();
    expect(cols).toEqual(
      [
        'allowed_domains',
        'client_id',
        'client_secret_encrypted',
        'created_at',
        'discovery_url',
        'enabled',
        'kind',
        'updated_at',
      ].sort(),
    );

    // BYTEA round-trip: insert a Uint8Array, read it back, bytes equal.
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xfe, 0xff]);
    const now = new Date();
    await db
      .insertInto('auth_providers')
      .values({
        kind: 'google',
        client_id: 'cid',
        client_secret_encrypted: bytes,
        discovery_url: null,
        allowed_domains: null,
        enabled: true,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const rows = await db
      .selectFrom('auth_providers')
      .selectAll()
      .where('kind', '=', 'google')
      .execute();
    expect(rows).toHaveLength(1);
    // pg returns BYTEA as Buffer; compare bytes regardless of class.
    const got = rows[0].client_secret_encrypted as unknown as Uint8Array;
    expect(Array.from(got)).toEqual(Array.from(bytes));
  });

  it('role column rejects invalid values', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);

    let caught: unknown;
    try {
      await db
        .insertInto('auth_better_v1_users')
        .values({
          id: 'u-bad',
          email: 'bad@example.com',
          email_verified: false,
          name: null,
          image: null,
          // Cast through unknown — TS narrows to the literal union, but the
          // whole point is to prove the DB-level CHECK constraint fires.
          role: 'superadmin' as unknown as 'admin' | 'user',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
    } catch (err) {
      caught = err;
    }
    // pg surfaces check_violation as code '23514'.
    expect(caught).toBeDefined();
    expect((caught as { code?: string } | undefined)?.code).toBe('23514');
  });

  it('creates auth_better_v1_accounts with the better-auth account columns', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'auth_better_v1_accounts'
      ORDER BY column_name`.execute(db);
    expect(result.rows.map((r) => r.column_name).sort()).toEqual(
      ['access_token','access_token_expires_at','account_id','created_at','id',
       'id_token','password','provider_id','refresh_token','refresh_token_expires_at',
       'scope','updated_at','user_id'].sort());
  });

  it('creates auth_better_v1_verifications with the better-auth verification columns', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'auth_better_v1_verifications'
      ORDER BY column_name`.execute(db);
    expect(result.rows.map((r) => r.column_name).sort()).toEqual(
      ['created_at','expires_at','id','identifier','updated_at','value'].sort());
  });

  it('accounts cascade-delete with their user', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);
    const now = new Date();
    await db.insertInto('auth_better_v1_users').values({
      id:'u1', email:'a@example.com', email_verified:true, name:'A',
      image:null, role:'user', created_at:now, updated_at:now }).execute();
    await db.insertInto('auth_better_v1_accounts').values({
      id:'acc1', user_id:'u1', account_id:'g1', provider_id:'google',
      access_token:null, refresh_token:null, id_token:null,
      access_token_expires_at:null, refresh_token_expires_at:null,
      scope:null, password:null, created_at:now, updated_at:now }).execute();
    await db.deleteFrom('auth_better_v1_users').where('id','=','u1').execute();
    const remaining = await db.selectFrom('auth_better_v1_accounts').selectAll().execute();
    expect(remaining).toHaveLength(0);
  });

  it('accounts reject duplicate (provider_id, account_id)', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);
    const now = new Date();
    await db.insertInto('auth_better_v1_users').values({
      id:'u1', email:'a@example.com', email_verified:true, name:'A',
      image:null, role:'user', created_at:now, updated_at:now }).execute();
    await db.insertInto('auth_better_v1_accounts').values({
      id:'acc1', user_id:'u1', account_id:'g1', provider_id:'google',
      access_token:null, refresh_token:null, id_token:null,
      access_token_expires_at:null, refresh_token_expires_at:null,
      scope:null, password:null, created_at:now, updated_at:now }).execute();

    let caught: unknown;
    try {
      // Same (provider_id, account_id), different id — must collide on the unique index.
      await db.insertInto('auth_better_v1_accounts').values({
        id:'acc2', user_id:'u1', account_id:'g1', provider_id:'google',
        access_token:null, refresh_token:null, id_token:null,
        access_token_expires_at:null, refresh_token_expires_at:null,
        scope:null, password:null, created_at:now, updated_at:now }).execute();
    } catch (err) {
      caught = err;
    }
    // pg surfaces unique_violation as code '23505'.
    expect(caught).toBeDefined();
    expect((caught as { code?: string } | undefined)?.code).toBe('23505');
  });

  it('migrations are idempotent', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);
    await runAuthBetterMigration(db);

    // Schema still works after the second call: insert, read back.
    const now = new Date();
    await db
      .insertInto('auth_better_v1_users')
      .values({
        id: 'u-idem',
        email: 'idem@example.com',
        email_verified: true,
        name: 'Idem',
        image: null,
        role: 'admin',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const rows = await db
      .selectFrom('auth_better_v1_users')
      .selectAll()
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('admin');
  });
});
