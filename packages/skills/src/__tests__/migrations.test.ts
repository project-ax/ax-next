import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runSkillsMigration, type SkillsDatabase } from '../migrations.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<SkillsDatabase>[] = [];

function makeKysely(): Kysely<SkillsDatabase> {
  const k = new Kysely<SkillsDatabase>({
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
      await k.schema.dropTable('skills_v1_user_skills').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    try {
      await k.schema.dropTable('skills_v1_skills').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('runSkillsMigration', () => {
  it('creates skills_v1_skills table', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'skills_v1_skills'
    `.execute(db);
    expect(tables.rows.map((r) => r.table_name)).toEqual(['skills_v1_skills']);
  });

  it('columns exist with expected types', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const cols = await sql<{ column_name: string; data_type: string; udt_name: string }>`
      SELECT column_name, data_type, udt_name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skills_v1_skills'
       ORDER BY ordinal_position
    `.execute(db);

    const byName = Object.fromEntries(
      cols.rows.map((r) => [r.column_name, { data_type: r.data_type, udt_name: r.udt_name }]),
    );

    expect(byName['skill_id']?.data_type).toBe('text');
    expect(byName['description']?.data_type).toBe('text');
    expect(byName['manifest_yaml']?.data_type).toBe('text');
    expect(byName['body_md']?.data_type).toBe('text');
    expect(byName['version']?.data_type).toBe('integer');
    // TIMESTAMPTZ maps to 'timestamp with time zone' in data_type
    expect(byName['created_at']?.data_type).toBe('timestamp with time zone');
    expect(byName['updated_at']?.data_type).toBe('timestamp with time zone');
  });

  it('is idempotent — running twice does not throw', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    await runSkillsMigration(db);

    // Table is still usable after double migration.
    await db
      .insertInto('skills_v1_skills')
      .values({
        skill_id: 'github',
        description: 'GitHub skill',
        manifest_yaml: 'name: github\ndescription: GitHub\n',
        body_md: '# GitHub',
        version: 1,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const rows = await db.selectFrom('skills_v1_skills').select('skill_id').execute();
    expect(rows).toHaveLength(1);
  });

  it('PRIMARY KEY rejects duplicate skill_id (pg error 23505)', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const row = {
      skill_id: 'github',
      description: 'GitHub skill',
      manifest_yaml: 'name: github\ndescription: GitHub\n',
      body_md: '# GitHub',
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };

    await db.insertInto('skills_v1_skills').values(row).execute();

    let caught: unknown;
    try {
      await db.insertInto('skills_v1_skills').values({ ...row, version: 2 }).execute();
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('23505');
  });

  it('default_attached column exists with the expected default', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const cols = await sql<{ column_name: string; data_type: string; column_default: string | null; is_nullable: string }>`
      SELECT column_name, data_type, column_default, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skills_v1_skills'
         AND column_name = 'default_attached'
    `.execute(db);

    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]?.data_type).toBe('boolean');
    expect(cols.rows[0]?.is_nullable).toBe('NO');
    // postgres normalises `DEFAULT false` to the textual literal "false".
    expect(cols.rows[0]?.column_default).toBe('false');
  });

  it('migration is idempotent when the column already exists', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    // Run again — should not throw.
    await runSkillsMigration(db);

    // Smoke: column still readable, default holds.
    await db
      .insertInto('skills_v1_skills')
      .values({
        skill_id: 'rerun',
        description: 'd',
        manifest_yaml: 'name: rerun\ndescription: d\n',
        body_md: '',
        version: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const rows = await db
      .selectFrom('skills_v1_skills')
      .select(['skill_id', 'default_attached'])
      .execute();
    expect(rows).toEqual([{ skill_id: 'rerun', default_attached: false }]);
  });

  it('source_url column exists and is nullable TEXT', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>`
      SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skills_v1_skills'
         AND column_name = 'source_url'
    `.execute(db);

    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]?.data_type).toBe('text');
    expect(cols.rows[0]?.is_nullable).toBe('YES');
    expect(cols.rows[0]?.column_default).toBeNull();
  });

  it('source_url migration is idempotent on re-run', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    await runSkillsMigration(db);

    // smoke: insert with explicit NULL source_url succeeds
    await db
      .insertInto('skills_v1_skills')
      .values({
        skill_id: 'su-smoke',
        description: 'd',
        manifest_yaml: 'name: su-smoke\ndescription: d\n',
        body_md: '',
        version: 0,
        source_url: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const r = await db.selectFrom('skills_v1_skills').selectAll().where('skill_id', '=', 'su-smoke').executeTakeFirstOrThrow();
    expect(r.source_url).toBeNull();
  });
});

describe('runSkillsMigration — skills_v1_user_skills side-table', () => {
  // SkillsDatabase now includes skills_v1_user_skills, so makeKysely() is sufficient.

  it('creates skills_v1_user_skills table', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'skills_v1_user_skills'
    `.execute(db);
    expect(tables.rows.map((r) => r.table_name)).toEqual(['skills_v1_user_skills']);
  });

  it('columns exist with expected types', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const cols = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skills_v1_user_skills'
       ORDER BY ordinal_position
    `.execute(db);

    const byName = Object.fromEntries(
      cols.rows.map((r) => [
        r.column_name,
        { data_type: r.data_type, is_nullable: r.is_nullable, column_default: r.column_default },
      ]),
    );

    expect(byName['owner_user_id']?.data_type).toBe('text');
    expect(byName['owner_user_id']?.is_nullable).toBe('NO');
    expect(byName['skill_id']?.data_type).toBe('text');
    expect(byName['skill_id']?.is_nullable).toBe('NO');
    expect(byName['description']?.data_type).toBe('text');
    expect(byName['manifest_yaml']?.data_type).toBe('text');
    expect(byName['body_md']?.data_type).toBe('text');
    expect(byName['version']?.data_type).toBe('integer');
    expect(byName['source_url']?.data_type).toBe('text');
    expect(byName['source_url']?.is_nullable).toBe('YES');
    expect(byName['default_attached']?.data_type).toBe('boolean');
    expect(byName['default_attached']?.is_nullable).toBe('NO');
    expect(byName['default_attached']?.column_default).toBe('false');
    expect(byName['created_at']?.data_type).toBe('timestamp with time zone');
    expect(byName['updated_at']?.data_type).toBe('timestamp with time zone');
  });

  it('compound PRIMARY KEY allows same skill_id with different owner_user_id', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const base = {
      skill_id: 'github',
      description: 'GitHub skill',
      manifest_yaml: 'name: github\ndescription: GitHub\n',
      body_md: '# GitHub',
      version: 1,
      source_url: null,
      default_attached: false,
      created_at: new Date(),
      updated_at: new Date(),
    };

    // Two rows with the same skill_id but different owner_user_id — both must succeed.
    await db.insertInto('skills_v1_user_skills').values({ ...base, owner_user_id: 'user-a' }).execute();
    await db.insertInto('skills_v1_user_skills').values({ ...base, owner_user_id: 'user-b' }).execute();

    const rows = await db.selectFrom('skills_v1_user_skills').select(['owner_user_id', 'skill_id']).orderBy('owner_user_id').execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.owner_user_id).toBe('user-a');
    expect(rows[1]?.owner_user_id).toBe('user-b');
  });

  it('compound PRIMARY KEY rejects duplicate (owner_user_id, skill_id) with pg error 23505', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const row = {
      owner_user_id: 'user-a',
      skill_id: 'github',
      description: 'GitHub skill',
      manifest_yaml: 'name: github\ndescription: GitHub\n',
      body_md: '# GitHub',
      version: 1,
      source_url: null,
      default_attached: false,
      created_at: new Date(),
      updated_at: new Date(),
    };

    await db.insertInto('skills_v1_user_skills').values(row).execute();

    let caught: unknown;
    try {
      await db.insertInto('skills_v1_user_skills').values({ ...row, version: 2 }).execute();
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('23505');
  });

  it('is idempotent — running runSkillsMigration twice does not throw and table stays usable', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    await runSkillsMigration(db);

    await db
      .insertInto('skills_v1_user_skills')
      .values({
        owner_user_id: 'user-x',
        skill_id: 'my-skill',
        description: 'A test skill',
        manifest_yaml: 'name: my-skill\ndescription: A test skill\n',
        body_md: '# My Skill',
        version: 0,
        source_url: null,
        default_attached: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    const rows = await db
      .selectFrom('skills_v1_user_skills')
      .select(['owner_user_id', 'skill_id'])
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ owner_user_id: 'user-x', skill_id: 'my-skill' });
  });
});
