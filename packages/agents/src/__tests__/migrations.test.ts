import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('agents_v1_agents').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
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
          system_prompt: 'p',
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
          system_prompt: 'p',
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
          system_prompt: 'p',
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
          system_prompt: '',
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
          system_prompt: '',
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
        system_prompt: '',
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
});
