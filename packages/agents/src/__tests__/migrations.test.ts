import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runAgentsMigration, type AgentsDatabase } from '../migrations.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AgentsDatabase>[] = [];

function makeKysely(): Kysely<AgentsDatabase> {
  const k = new Kysely<AgentsDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 2 }),
    }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('agents_v1_identity').ifExists().execute();
      await k.schema.dropTable('agents_v1_agents').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('runAgentsMigration', () => {
  it('creates agents_v1_agents table + owner index', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);

    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'agents_v1_agents'
    `.execute(db);
    expect(tables.rows.map((r) => r.table_name)).toEqual(['agents_v1_agents']);

    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'agents_v1_agents'
    `.execute(db);
    expect(indexes.rows.map((r) => r.indexname)).toContain(
      'agents_v1_agents_owner',
    );
  });

  it('TASK-142: the system_prompt column does NOT exist after migration', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'agents_v1_agents' AND column_name = 'system_prompt'
    `.execute(db);
    expect(cols.rows).toHaveLength(0);
  });

  it('TASK-142: DROP COLUMN migration removes a pre-existing system_prompt column (idempotent forward-only)', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    // Simulate a DB deployed BEFORE the drop: re-add the legacy column, then
    // re-run the migration. The DROP COLUMN IF EXISTS must remove it again.
    await sql`ALTER TABLE agents_v1_agents ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''`.execute(
      db,
    );
    const before = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'agents_v1_agents' AND column_name = 'system_prompt'
    `.execute(db);
    expect(before.rows).toHaveLength(1);

    await runAgentsMigration(db); // re-run — DROP COLUMN IF EXISTS fires.

    const after = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'agents_v1_agents' AND column_name = 'system_prompt'
    `.execute(db);
    expect(after.rows).toHaveLength(0);
  });

  it('CHECK constraint rejects bad owner_type', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    let caught: unknown;
    try {
      await db
        .insertInto('agents_v1_agents')
        .values({
          agent_id: 'a1',
          owner_id: 'u1',
          owner_type: 'galaxy', // not in (user, team)
          visibility: 'personal',
          display_name: 'A',
          allowed_tools: JSON.stringify([]) as unknown,
          mcp_config_ids: JSON.stringify([]) as unknown,
          model: 'claude-opus-4-7',
          workspace_ref: null,
          created_at: new Date(),
          updated_at: new Date(),
        } as never)
        .execute();
    } catch (err) {
      caught = err;
    }
    // pg surfaces CHECK violations as code '23514'.
    expect((caught as { code?: string } | undefined)?.code).toBe('23514');
  });

  it('CHECK constraint rejects bad visibility', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    let caught: unknown;
    try {
      await db
        .insertInto('agents_v1_agents')
        .values({
          agent_id: 'a1',
          owner_id: 'u1',
          owner_type: 'user',
          visibility: 'public', // not in (personal, team)
          display_name: 'A',
          allowed_tools: JSON.stringify([]) as unknown,
          mcp_config_ids: JSON.stringify([]) as unknown,
          model: 'claude-opus-4-7',
          workspace_ref: null,
          created_at: new Date(),
          updated_at: new Date(),
        } as never)
        .execute();
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('23514');
  });

  it('CHECK constraint rejects mismatched owner_type/visibility pair', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    let caught: unknown;
    try {
      await db
        .insertInto('agents_v1_agents')
        .values({
          agent_id: 'a1',
          owner_id: 'u1',
          owner_type: 'user',
          visibility: 'team', // user owner with team visibility — illegal
          display_name: 'A',
          allowed_tools: JSON.stringify([]) as unknown,
          mcp_config_ids: JSON.stringify([]) as unknown,
          model: 'claude-opus-4-7',
          workspace_ref: null,
          created_at: new Date(),
          updated_at: new Date(),
        } as never)
        .execute();
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('23514');
  });

  it('accepts the two valid pairings', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    await db
      .insertInto('agents_v1_agents')
      .values([
        {
          agent_id: 'a-personal',
          owner_id: 'u1',
          owner_type: 'user',
          visibility: 'personal',
          display_name: 'P',
          allowed_tools: JSON.stringify([]) as unknown,
          mcp_config_ids: JSON.stringify([]) as unknown,
          model: 'claude-opus-4-7',
          workspace_ref: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          agent_id: 'a-team',
          owner_id: 't1',
          owner_type: 'team',
          visibility: 'team',
          display_name: 'T',
          allowed_tools: JSON.stringify([]) as unknown,
          mcp_config_ids: JSON.stringify([]) as unknown,
          model: 'claude-opus-4-7',
          workspace_ref: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ] as never)
      .execute();
    const rows = await db
      .selectFrom('agents_v1_agents')
      .select('agent_id')
      .execute();
    expect(rows.map((r) => r.agent_id).sort()).toEqual([
      'a-personal',
      'a-team',
    ]);
  });

  it('adds webhook_token column with partial unique index', async () => {
    const k = makeKysely();
    await runAgentsMigration(k);
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: 'YES' | 'NO' }>`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'agents_v1_agents'
         AND column_name = 'webhook_token'
    `.execute(k);
    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]).toMatchObject({ data_type: 'text', is_nullable: 'YES' });

    const ix = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'agents_v1_agents'
         AND indexname = 'agents_v1_agents_webhook_token'
    `.execute(k);
    expect(ix.rows).toHaveLength(1);
    // Partial index gated on NOT NULL — both prevents NULL collisions
    // (UNIQUE allows multiple NULLs) and keeps the index lean.
    expect(ix.rows[0]!.indexdef).toContain('WHERE');
    expect(ix.rows[0]!.indexdef.toLowerCase()).toContain('webhook_token is not null');
  });

  it('adds skill_attachments column as JSONB with default []', async () => {
    const k = makeKysely();
    await runAgentsMigration(k);
    const cols = await sql<{ column_name: string; data_type: string; column_default: string | null; is_nullable: 'YES' | 'NO' }>`
      SELECT column_name, data_type, column_default, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'agents_v1_agents'
         AND column_name = 'skill_attachments'
    `.execute(k);
    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]).toMatchObject({
      data_type: 'jsonb',
      is_nullable: 'NO',
    });
    // Default is '[]'::jsonb in pg; the column_default text varies in formatting
    // ('"[]"' vs '''[]''::jsonb'). Just assert it contains the bracket pair.
    expect(cols.rows[0]?.column_default ?? '').toContain('[]');
  });

  it('new rows have skill_attachments = [] by default', async () => {
    const k = makeKysely();
    await runAgentsMigration(k);
    await k
      .insertInto('agents_v1_agents')
      .values({
        agent_id: 'a-sa',
        owner_id: 'u1',
        owner_type: 'user',
        visibility: 'personal',
        display_name: 'SA',
        allowed_tools: JSON.stringify([]) as unknown,
        mcp_config_ids: JSON.stringify([]) as unknown,
        model: 'claude-opus-4-7',
        workspace_ref: null,
        created_at: new Date(),
        updated_at: new Date(),
      } as never)
      .execute();
    const row = await k
      .selectFrom('agents_v1_agents')
      .select('skill_attachments')
      .where('agent_id', '=', 'a-sa')
      .executeTakeFirstOrThrow();
    // pg parses JSONB '[]' back to a JS array.
    expect(row.skill_attachments).toEqual([]);
  });

  // TASK-739 — per-agent connector exclusions (hides a default / legacy-owned
  // connector from one agent). Additive + idempotent; existing rows read [].
  it('adds connector_exclusions as JSONB NOT NULL DEFAULT [] and backfills existing rows, idempotently', async () => {
    const k = makeKysely();
    await runAgentsMigration(k);
    // Simulate a DB deployed BEFORE TASK-739: drop the column, seed a row.
    await sql`ALTER TABLE agents_v1_agents DROP COLUMN connector_exclusions`.execute(k);
    await k
      .insertInto('agents_v1_agents')
      .values({
        agent_id: 'a-old',
        owner_id: 'u1',
        owner_type: 'user',
        visibility: 'personal',
        display_name: 'Old',
        allowed_tools: JSON.stringify([]) as unknown,
        mcp_config_ids: JSON.stringify([]) as unknown,
        model: 'anthropic/claude-opus-4-7',
        workspace_ref: null,
        created_at: new Date(),
        updated_at: new Date(),
      } as never)
      .execute();
    await runAgentsMigration(k);
    await runAgentsMigration(k); // second run is a no-op
    const cols = await sql<{ data_type: string; column_default: string | null; is_nullable: 'YES' | 'NO' }>`
      SELECT data_type, column_default, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'agents_v1_agents'
         AND column_name = 'connector_exclusions'
    `.execute(k);
    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
    expect(cols.rows[0]?.column_default ?? '').toContain('[]');
    const row = await k
      .selectFrom('agents_v1_agents')
      .select('connector_exclusions')
      .where('agent_id', '=', 'a-old')
      .executeTakeFirstOrThrow();
    expect(row.connector_exclusions).toEqual([]);
  });

  // PR 2 (provider-agnostic runner, design §6 / §1) ------------------------

  it('adds the runner column as TEXT NOT NULL DEFAULT claude-sdk', async () => {
    const k = makeKysely();
    await runAgentsMigration(k);
    const cols = await sql<{
      data_type: string;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
    }>`
      SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_name = 'agents_v1_agents' AND column_name = 'runner'
    `.execute(k);
    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(cols.rows[0]?.column_default ?? '').toContain('claude-sdk');
  });

  it('backfills runner=claude-sdk on rows that predate the column', async () => {
    const k = makeKysely();
    await runAgentsMigration(k);
    // Simulate a DB deployed BEFORE the column existed.
    await sql`ALTER TABLE agents_v1_agents DROP COLUMN runner`.execute(k);
    await sql`
      INSERT INTO agents_v1_agents
        (agent_id, owner_id, owner_type, visibility, display_name,
         allowed_tools, mcp_config_ids, model, workspace_ref, created_at, updated_at)
      VALUES ('a-legacy', 'u1', 'user', 'personal', 'Legacy',
              '[]'::jsonb, '[]'::jsonb, 'anthropic/claude-opus-4-7', NULL, NOW(), NOW())
    `.execute(k);

    await runAgentsMigration(k); // re-run — ADD COLUMN IF NOT EXISTS fires.

    const row = await sql<{ runner: string }>`
      SELECT runner FROM agents_v1_agents WHERE agent_id = 'a-legacy'
    `.execute(k);
    expect(row.rows[0]?.runner).toBe('claude-sdk');
  });

  it('rewrites legacy bare model ids to anthropic/<id>, idempotently', async () => {
    const k = makeKysely();
    await runAgentsMigration(k);
    await sql`
      INSERT INTO agents_v1_agents
        (agent_id, owner_id, owner_type, visibility, display_name,
         allowed_tools, mcp_config_ids, model, workspace_ref, created_at, updated_at)
      VALUES
        ('a-bare', 'u1', 'user', 'personal', 'Bare',
         '[]'::jsonb, '[]'::jsonb, 'claude-sonnet-4-6', NULL, NOW(), NOW()),
        ('a-prefixed', 'u2', 'user', 'personal', 'Prefixed',
         '[]'::jsonb, '[]'::jsonb, 'anthropic/claude-opus-4-7', NULL, NOW(), NOW()),
        ('a-nested', 'u3', 'user', 'personal', 'Nested',
         '[]'::jsonb, '[]'::jsonb, 'openrouter/x-ai/grok-4.6', NULL, NOW(), NOW())
    `.execute(k);

    await runAgentsMigration(k);
    const first = await sql<{ agent_id: string; model: string }>`
      SELECT agent_id, model FROM agents_v1_agents ORDER BY agent_id
    `.execute(k);
    expect(first.rows).toEqual([
      { agent_id: 'a-bare', model: 'anthropic/claude-sonnet-4-6' },
      { agent_id: 'a-nested', model: 'openrouter/x-ai/grok-4.6' },
      { agent_id: 'a-prefixed', model: 'anthropic/claude-opus-4-7' },
    ]);

    // Idempotent: a third run must NOT produce 'anthropic/anthropic/...'.
    await runAgentsMigration(k);
    const second = await sql<{ agent_id: string; model: string }>`
      SELECT agent_id, model FROM agents_v1_agents ORDER BY agent_id
    `.execute(k);
    expect(second.rows).toEqual(first.rows);
  });

  it('is idempotent — running twice does not throw', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    await runAgentsMigration(db);
    // and the table is still usable
    await db
      .insertInto('agents_v1_agents')
      .values({
        agent_id: 'a',
        owner_id: 'u1',
        owner_type: 'user',
        visibility: 'personal',
        display_name: 'X',
        allowed_tools: JSON.stringify([]) as unknown,
        mcp_config_ids: JSON.stringify([]) as unknown,
        model: 'claude-opus-4-7',
        workspace_ref: null,
        created_at: new Date(),
        updated_at: new Date(),
      } as never)
      .execute();
    const rows = await db.selectFrom('agents_v1_agents').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  // TASK-989 — identity, soul, Instructions and onboarding state.
  it('creates agents_v1_identity and refuses an unknown bootstrap state', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    await runAgentsMigration(db); // idempotent

    const cols = await sql<{ column_name: string; data_type: string; column_default: string | null }>`
      SELECT column_name, data_type, column_default FROM information_schema.columns
       WHERE table_name = 'agents_v1_identity' ORDER BY ordinal_position
    `.execute(db);
    expect(cols.rows.map((c) => [c.column_name, c.data_type])).toEqual([
      ['agent_id', 'text'],
      ['identity', 'text'],
      ['soul', 'text'],
      ['instructions', 'text'],
      ['bootstrap', 'text'],
      // int4 on purpose: node-postgres hands int8 back as a string.
      ['revision', 'integer'],
      ['updated_at', 'timestamp with time zone'],
      // TASK-990 — added by ALTER TABLE, so they come last.
      ['identity_changed_by_agent_at', 'timestamp with time zone'],
      ['soul_changed_by_agent_at', 'timestamp with time zone'],
    ]);

    // A bare row reads as the reset state: empty texts, 'none', revision 0.
    await sql`INSERT INTO agents_v1_identity (agent_id) VALUES ('a1')`.execute(db);
    const bare = await sql<Record<string, unknown>>`
      SELECT identity, soul, instructions, bootstrap, revision FROM agents_v1_identity WHERE agent_id = 'a1'
    `.execute(db);
    expect(bare.rows).toEqual([
      { identity: '', soul: '', instructions: '', bootstrap: 'none', revision: 0 },
    ]);

    const violation = async (statement: ReturnType<typeof sql>): Promise<unknown> => {
      try {
        await statement.execute(db);
      } catch (err) {
        return err;
      }
      return undefined;
    };
    const weird = await violation(
      sql`INSERT INTO agents_v1_identity (agent_id, bootstrap) VALUES ('a2', 'weird')`,
    );
    expect(weird).toMatchObject({ code: '23514', constraint: 'agents_v1_identity_bootstrap_check' });
    const negative = await violation(
      sql`INSERT INTO agents_v1_identity (agent_id, revision) VALUES ('a3', -1)`,
    );
    expect(negative).toMatchObject({ code: '23514', constraint: 'agents_v1_identity_revision_check' });
    // agent_id is the primary key: one row per agent.
    const twice = await violation(sql`INSERT INTO agents_v1_identity (agent_id) VALUES ('a1')`);
    expect(twice).toMatchObject({ code: '23505' });

    // No foreign key to agents_v1_agents: dropping the agents table must never
    // be blocked by identity rows (every downstream teardown does exactly that).
    const fks = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.table_constraints
       WHERE table_name = 'agents_v1_identity' AND constraint_type = 'FOREIGN KEY'
    `.execute(db);
    expect(fks.rows[0]?.n).toBe(0);
  });

  // TASK-990 — the last time the agent itself changed each section (outside
  // first-run setup). Additive + idempotent; an existing row reads null.
  it('adds the two self-change columns to agents_v1_identity as nullable timestamptz, idempotently', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    // Simulate a DB deployed BEFORE TASK-990: drop both columns, seed a row.
    await sql`ALTER TABLE agents_v1_identity DROP COLUMN identity_changed_by_agent_at`.execute(db);
    await sql`ALTER TABLE agents_v1_identity DROP COLUMN soul_changed_by_agent_at`.execute(db);
    await sql`INSERT INTO agents_v1_identity (agent_id, identity, soul) VALUES ('a-old', 'I am Pip', 'Kind')`.execute(
      db,
    );
    await runAgentsMigration(db);
    await runAgentsMigration(db); // second run is a no-op

    const cols = await sql<{ column_name: string; data_type: string; is_nullable: 'YES' | 'NO' }>`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'agents_v1_identity'
         AND column_name IN ('identity_changed_by_agent_at', 'soul_changed_by_agent_at')
       ORDER BY column_name
    `.execute(db);
    expect(cols.rows).toEqual([
      { column_name: 'identity_changed_by_agent_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'soul_changed_by_agent_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);

    const row = await sql<Record<string, unknown>>`
      SELECT identity, soul, identity_changed_by_agent_at, soul_changed_by_agent_at
        FROM agents_v1_identity WHERE agent_id = 'a-old'
    `.execute(db);
    expect(row.rows).toEqual([
      { identity: 'I am Pip', soul: 'Kind', identity_changed_by_agent_at: null, soul_changed_by_agent_at: null },
    ]);
  });
});
