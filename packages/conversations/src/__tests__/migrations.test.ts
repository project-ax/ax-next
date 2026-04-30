import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  runConversationsMigration,
  type ConversationDatabase,
} from '../migrations.js';

// ---------------------------------------------------------------------------
// Phase B (2026-04-29) migration. Pure-additive ALTER on
// conversations_v1_conversations adding runner_type, runner_session_id,
// workspace_ref, last_activity_at — all nullable. No v1 → v2 split (I1):
// greenfield, ALTER in place forever.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<ConversationDatabase>[] = [];

function makeKysely(): Kysely<ConversationDatabase> {
  const k = new Kysely<ConversationDatabase>({
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
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('conversations_v1_turns').ifExists().execute();
      await k.schema
        .dropTable('conversations_v1_conversations')
        .ifExists()
        .execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('Phase B migration', () => {
  it('adds runner_type, runner_session_id, workspace_ref, last_activity_at as nullable columns', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);

    const cols = await sql<{
      column_name: string;
      is_nullable: string;
      data_type: string;
    }>`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'conversations_v1_conversations'
      ORDER BY column_name
    `.execute(db);
    const byName = new Map(cols.rows.map((r) => [r.column_name, r]));

    expect(byName.get('runner_type')).toMatchObject({
      is_nullable: 'YES',
      data_type: 'text',
    });
    expect(byName.get('runner_session_id')).toMatchObject({
      is_nullable: 'YES',
      data_type: 'text',
    });
    expect(byName.get('workspace_ref')).toMatchObject({
      is_nullable: 'YES',
      data_type: 'text',
    });
    expect(byName.get('last_activity_at')).toMatchObject({
      is_nullable: 'YES',
      data_type: 'timestamp with time zone',
    });
  });

  it('migration is idempotent — re-running does not error (I11)', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    await runConversationsMigration(db);
    // Sanity: columns still there after the second run.
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'conversations_v1_conversations'
        AND column_name IN ('runner_type', 'runner_session_id', 'workspace_ref', 'last_activity_at')
    `.execute(db);
    expect(cols.rows).toHaveLength(4);
  });

  it('existing rows survive the migration with NULL Phase B columns (no backfill)', async () => {
    const db = makeKysely();
    // Simulate a pre-Phase-B row by running the original CREATE TABLE,
    // inserting a row, then re-running the migration which adds the new
    // columns. Greenfield posture: no backfill, NULL is fine.
    await sql`
      CREATE TABLE conversations_v1_conversations (
        conversation_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        title TEXT,
        active_session_id TEXT,
        active_req_id TEXT,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
    await sql`
      INSERT INTO conversations_v1_conversations (conversation_id, user_id, agent_id)
      VALUES ('cnv_old', 'u_old', 'a_old')
    `.execute(db);

    await runConversationsMigration(db);

    const row = await sql<{
      runner_type: string | null;
      runner_session_id: string | null;
      workspace_ref: string | null;
      last_activity_at: Date | null;
    }>`
      SELECT runner_type, runner_session_id, workspace_ref, last_activity_at
      FROM conversations_v1_conversations
      WHERE conversation_id = 'cnv_old'
    `.execute(db);
    expect(row.rows[0]).toMatchObject({
      runner_type: null,
      runner_session_id: null,
      workspace_ref: null,
      last_activity_at: null,
    });
  });
});
