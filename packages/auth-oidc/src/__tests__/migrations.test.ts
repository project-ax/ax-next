import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runAuthMigration, type AuthDatabase } from '../migrations.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AuthDatabase>[] = [];

function makeKysely(): Kysely<AuthDatabase> {
  const k = new Kysely<AuthDatabase>({
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
});

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('auth_v1_sessions').ifExists().execute();
      await k.schema.dropTable('auth_v1_users').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('runAuthMigration', () => {
  it('creates auth_v1_users + auth_v1_sessions tables', async () => {
    const db = makeKysely();
    await runAuthMigration(db);

    const result = await sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('auth_v1_users', 'auth_v1_sessions')
      ORDER BY table_name
    `.execute(db);

    const names = result.rows.map((r) => r.table_name);
    expect(names).toEqual(['auth_v1_sessions', 'auth_v1_users']);
  });

  it('users table has UNIQUE (auth_provider, auth_subject_id)', async () => {
    const db = makeKysely();
    await runAuthMigration(db);

    // Insert a row, then assert the duplicate (provider, subject) violates
    // the unique constraint. Two different users from the SAME IdP must
    // never collide on subject — that's the bedrock of the auth model.
    await db
      .insertInto('auth_v1_users')
      .values({
        user_id: 'u1',
        auth_subject_id: 'sub-abc',
        auth_provider: 'google-oidc',
        email: 'a@example.com',
        display_name: 'A',
        is_admin: false,
        created_at: new Date(),
      })
      .execute();

    let caught: unknown;
    try {
      await db
        .insertInto('auth_v1_users')
        .values({
          user_id: 'u2',
          auth_subject_id: 'sub-abc',
          auth_provider: 'google-oidc',
          email: 'b@example.com',
          display_name: 'B',
          is_admin: false,
          created_at: new Date(),
        })
        .execute();
    } catch (err) {
      caught = err;
    }
    // pg surfaces the unique violation as code '23505'.
    expect(caught).toBeDefined();
    expect((caught as { code?: string } | undefined)?.code).toBe('23505');
  });

  it('different (provider, subject_id) pairs do not collide', async () => {
    const db = makeKysely();
    await runAuthMigration(db);
    // Same subject string, different provider → allowed (two IdPs can mint
    // overlapping subjects; we discriminate by provider).
    await db
      .insertInto('auth_v1_users')
      .values({
        user_id: 'u1',
        auth_subject_id: 'sub-abc',
        auth_provider: 'google-oidc',
        email: null,
        display_name: null,
        is_admin: false,
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('auth_v1_users')
      .values({
        user_id: 'u2',
        auth_subject_id: 'sub-abc',
        auth_provider: 'dev-bootstrap',
        email: null,
        display_name: null,
        is_admin: false,
        created_at: new Date(),
      })
      .execute();
    const rows = await db.selectFrom('auth_v1_users').select('user_id').execute();
    expect(rows.map((r) => r.user_id).sort()).toEqual(['u1', 'u2']);
  });

  it('creates expected indexes on auth_v1_sessions', async () => {
    const db = makeKysely();
    await runAuthMigration(db);

    const result = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'auth_v1_sessions'
      ORDER BY indexname
    `.execute(db);

    const names = result.rows.map((r) => r.indexname);
    expect(names).toContain('auth_v1_sessions_user_id_idx');
    expect(names).toContain('auth_v1_sessions_expires_at_idx');
  });

  it('is idempotent — running twice does not throw', async () => {
    const db = makeKysely();
    await runAuthMigration(db);
    await runAuthMigration(db);
    // And the schema is still intact afterwards.
    await db
      .insertInto('auth_v1_users')
      .values({
        user_id: 'u',
        auth_subject_id: 's',
        auth_provider: 'p',
        email: null,
        display_name: null,
        is_admin: false,
        created_at: new Date(),
      })
      .execute();
    const rows = await db.selectFrom('auth_v1_users').selectAll().execute();
    expect(rows).toHaveLength(1);
  });
});
