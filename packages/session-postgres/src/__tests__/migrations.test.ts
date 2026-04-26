import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runSessionMigration, type SessionDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// Migration shape tests
//
// These exist alongside plugin.test.ts (which exercises the bus surface) to
// pin down properties of the v2 side-table that are easy to regress without
// noticing — particularly:
//
//   * the table is created with the documented column set,
//   * the user_id / agent_id read indexes exist,
//   * there is NO `updated_at` column (immutability is enforced at the
//     application layer; the absence makes the contract obvious),
//   * the migration is idempotent (re-running it on a populated schema
//     is a no-op).
//
// They also exercise the round-trip of `agent_config_json` so the JSONB
// path doesn't silently drop fields between insert and select — we don't
// want a "config got eaten" debug session a year from now.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterAll(async () => {
  if (container) await container.stop();
});

async function makeDb(): Promise<{ db: Kysely<SessionDatabase>; pool: pg.Pool }> {
  const pool = new pg.Pool({ connectionString });
  const db = new Kysely<SessionDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
  return { db, pool };
}

afterEach(async () => {
  // Drop tables between tests so each migration run starts clean.
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS session_postgres_v2_session_agent');
    await cleanup.query('DROP TABLE IF EXISTS session_postgres_v1_inbox');
    await cleanup.query('DROP TABLE IF EXISTS session_postgres_v1_sessions');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

describe('runSessionMigration v2', () => {
  it('creates session_postgres_v2_session_agent with the documented columns', async () => {
    const { db, pool } = await makeDb();
    try {
      await runSessionMigration(db);
      const cols = await sql<{ column_name: string; data_type: string; is_nullable: 'YES' | 'NO' }>`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'session_postgres_v2_session_agent'
        ORDER BY ordinal_position
      `.execute(db);
      const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
      expect(byName.has('session_id')).toBe(true);
      expect(byName.has('user_id')).toBe(true);
      expect(byName.has('agent_id')).toBe(true);
      expect(byName.has('agent_config_json')).toBe(true);
      expect(byName.has('created_at')).toBe(true);
      expect(byName.get('user_id')!.is_nullable).toBe('NO');
      expect(byName.get('agent_id')!.is_nullable).toBe('NO');
      expect(byName.get('agent_config_json')!.is_nullable).toBe('NO');
      expect(byName.get('agent_config_json')!.data_type).toBe('jsonb');
      // I10 immutability — the row is INSERT-once. There must be no
      // `updated_at` column. If a future change adds one, the contract
      // shifted and this test should fail loudly.
      expect(byName.has('updated_at')).toBe(false);
    } finally {
      await db.destroy();
      await pool.end().catch(() => {});
    }
  });

  it('creates the user_id and agent_id read indexes', async () => {
    const { db, pool } = await makeDb();
    try {
      await runSessionMigration(db);
      const idx = await sql<{ indexname: string }>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'session_postgres_v2_session_agent'
      `.execute(db);
      const names = new Set(idx.rows.map((r) => r.indexname));
      expect(names.has('session_postgres_v2_session_agent_user_id_idx')).toBe(true);
      expect(names.has('session_postgres_v2_session_agent_agent_id_idx')).toBe(true);
    } finally {
      await db.destroy();
      await pool.end().catch(() => {});
    }
  });

  it('is idempotent (re-running on a populated schema is a no-op)', async () => {
    const { db, pool } = await makeDb();
    try {
      await runSessionMigration(db);
      // Insert a row to ensure the second migration doesn't truncate.
      await db
        .insertInto('session_postgres_v2_session_agent')
        .values({
          session_id: 's-idem',
          user_id: 'u-1',
          agent_id: 'a-1',
          agent_config_json: { systemPrompt: 'be helpful' } as never,
        } as never)
        .execute();
      // Re-run; CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
      // make this a no-op.
      await runSessionMigration(db);
      const rows = await db
        .selectFrom('session_postgres_v2_session_agent')
        .select(['session_id', 'user_id', 'agent_id', 'agent_config_json'])
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.session_id).toBe('s-idem');
      expect(rows[0]?.agent_config_json).toEqual({ systemPrompt: 'be helpful' });
    } finally {
      await db.destroy();
      await pool.end().catch(() => {});
    }
  });

  it('PRIMARY KEY on session_id rejects duplicate inserts (immutability — switching agents = new session)', async () => {
    const { db, pool } = await makeDb();
    try {
      await runSessionMigration(db);
      await db
        .insertInto('session_postgres_v2_session_agent')
        .values({
          session_id: 's-dup',
          user_id: 'u-1',
          agent_id: 'a-1',
          agent_config_json: { systemPrompt: 'first' } as never,
        } as never)
        .execute();
      let caught: unknown;
      try {
        await db
          .insertInto('session_postgres_v2_session_agent')
          .values({
            session_id: 's-dup',
            user_id: 'u-1',
            agent_id: 'a-2',
            agent_config_json: { systemPrompt: 'second' } as never,
          } as never)
          .execute();
      } catch (err) {
        caught = err;
      }
      // 23505 is unique_violation — the PK guards I10 at the storage layer.
      expect((caught as { code?: string } | undefined)?.code).toBe('23505');
    } finally {
      await db.destroy();
      await pool.end().catch(() => {});
    }
  });

  it('round-trips an agent_config_json with all expected fields', async () => {
    const { db, pool } = await makeDb();
    try {
      await runSessionMigration(db);
      const config = {
        systemPrompt: 'untrusted user-authored prompt',
        allowedTools: ['file.read', 'bash.exec'],
        mcpConfigIds: ['mcp-1', 'mcp-2'],
        model: 'claude-sonnet-4-7',
      };
      await db
        .insertInto('session_postgres_v2_session_agent')
        .values({
          session_id: 's-rt',
          user_id: 'u-rt',
          agent_id: 'a-rt',
          agent_config_json: config as never,
        } as never)
        .execute();
      const row = await db
        .selectFrom('session_postgres_v2_session_agent')
        .select(['agent_config_json'])
        .where('session_id', '=', 's-rt')
        .executeTakeFirstOrThrow();
      expect(row.agent_config_json).toEqual(config);
    } finally {
      await db.destroy();
      await pool.end().catch(() => {});
    }
  });
});
