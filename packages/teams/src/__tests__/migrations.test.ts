import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runTeamsMigration, type TeamsDatabase } from '../migrations.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<TeamsDatabase>[] = [];

function makeKysely(): Kysely<TeamsDatabase> {
  const k = new Kysely<TeamsDatabase>({
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
      await k.schema.dropTable('teams_v1_memberships').ifExists().execute();
      await k.schema.dropTable('teams_v1_teams').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('runTeamsMigration', () => {
  it('creates teams_v1_teams + teams_v1_memberships tables', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);

    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('teams_v1_teams', 'teams_v1_memberships')
      ORDER BY table_name
    `.execute(db);
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'teams_v1_memberships',
      'teams_v1_teams',
    ]);
  });

  it('creates the user_id index on memberships', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);

    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'teams_v1_memberships'
    `.execute(db);
    expect(indexes.rows.map((r) => r.indexname)).toContain(
      'teams_v1_memberships_user_id_idx',
    );
  });

  it('CHECK constraint rejects bad role', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    // Need a team row first — memberships PK references no FK but rows
    // make more sense with a parent team in place.
    await db
      .insertInto('teams_v1_teams')
      .values({
        team_id: 't1',
        display_name: 'Team',
        created_by: 'u1',
        created_at: new Date(),
      })
      .execute();
    let caught: unknown;
    try {
      await db
        .insertInto('teams_v1_memberships')
        .values({
          team_id: 't1',
          user_id: 'u1',
          role: 'owner', // not in (admin, member)
          joined_at: new Date(),
        })
        .execute();
    } catch (err) {
      caught = err;
    }
    // pg surfaces CHECK violations as code '23514'.
    expect((caught as { code?: string } | undefined)?.code).toBe('23514');
  });

  it('accepts both valid roles', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    await db
      .insertInto('teams_v1_teams')
      .values({
        team_id: 't1',
        display_name: 'Team',
        created_by: 'u1',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('teams_v1_memberships')
      .values([
        {
          team_id: 't1',
          user_id: 'u1',
          role: 'admin',
          joined_at: new Date(),
        },
        {
          team_id: 't1',
          user_id: 'u2',
          role: 'member',
          joined_at: new Date(),
        },
      ])
      .execute();
    const rows = await db
      .selectFrom('teams_v1_memberships')
      .select(['user_id', 'role'])
      .orderBy('user_id')
      .execute();
    expect(rows).toEqual([
      { user_id: 'u1', role: 'admin' },
      { user_id: 'u2', role: 'member' },
    ]);
  });

  it('membership PK rejects duplicate (team_id, user_id)', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    await db
      .insertInto('teams_v1_teams')
      .values({
        team_id: 't1',
        display_name: 'Team',
        created_by: 'u1',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('teams_v1_memberships')
      .values({
        team_id: 't1',
        user_id: 'u1',
        role: 'admin',
        joined_at: new Date(),
      })
      .execute();
    let caught: unknown;
    try {
      await db
        .insertInto('teams_v1_memberships')
        .values({
          team_id: 't1',
          user_id: 'u1',
          role: 'member',
          joined_at: new Date(),
        })
        .execute();
    } catch (err) {
      caught = err;
    }
    // pg surfaces unique violations as code '23505'.
    expect((caught as { code?: string } | undefined)?.code).toBe('23505');
  });

  it('default role is member when omitted', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    await db
      .insertInto('teams_v1_teams')
      .values({
        team_id: 't1',
        display_name: 'Team',
        created_by: 'u1',
        created_at: new Date(),
      })
      .execute();
    // Omit `role` to exercise the DEFAULT clause.
    await sql`
      INSERT INTO teams_v1_memberships (team_id, user_id)
      VALUES ('t1', 'u1')
    `.execute(db);
    const rows = await db
      .selectFrom('teams_v1_memberships')
      .select('role')
      .where('user_id', '=', 'u1')
      .execute();
    expect(rows[0]?.role).toBe('member');
  });

  it('is idempotent — running twice does not throw', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    await runTeamsMigration(db);
    // and the tables are still usable
    await db
      .insertInto('teams_v1_teams')
      .values({
        team_id: 't1',
        display_name: 'Team',
        created_by: 'u1',
        created_at: new Date(),
      })
      .execute();
    const rows = await db.selectFrom('teams_v1_teams').selectAll().execute();
    expect(rows).toHaveLength(1);
  });
});
