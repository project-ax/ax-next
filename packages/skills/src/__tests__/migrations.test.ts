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
      await k.schema.dropTable('skills_v1_catalog_requests').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    try {
      await k.schema.dropTable('skills_v1_authored').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    try {
      await k.schema.dropTable('skills_v1_user_attachments').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    try {
      await k.schema.dropTable('skills_v1_skill_files').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
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

  it('creates skills_v1_skill_files with the compound PK', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    // Insert two files for one skill; the compound PK (scope, owner_user_id,
    // skill_id, path) must allow distinct paths and reject a duplicate path.
    await db
      .insertInto('skills_v1_skill_files')
      .values([
        { scope: 'global', owner_user_id: '', skill_id: 'demo', path: 'scripts/a.py', contents: 'print(1)' },
        { scope: 'global', owner_user_id: '', skill_id: 'demo', path: 'data/b.json', contents: '{}' },
      ])
      .execute();

    const rows = await db
      .selectFrom('skills_v1_skill_files')
      .selectAll()
      .where('skill_id', '=', 'demo')
      .orderBy('path')
      .execute();
    expect(rows.map((r) => r.path)).toEqual(['data/b.json', 'scripts/a.py']);

    await expect(
      db
        .insertInto('skills_v1_skill_files')
        .values({ scope: 'global', owner_user_id: '', skill_id: 'demo', path: 'scripts/a.py', contents: 'dup' })
        .execute(),
    ).rejects.toThrow();
  });

  it('skills_v1_skills has a nullable bundle_tree_sha column', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    // Insert WITHOUT bundle_tree_sha → defaults to NULL.
    await db
      .insertInto('skills_v1_skills')
      .values({
        skill_id: 'demo',
        description: 'd',
        manifest_yaml: 'name: demo\ndescription: d\nversion: 1\n',
        body_md: '# demo\n',
        version: 1,
      })
      .execute();
    const row = await db
      .selectFrom('skills_v1_skills')
      .select(['skill_id', 'bundle_tree_sha'])
      .where('skill_id', '=', 'demo')
      .executeTakeFirstOrThrow();
    expect(row.bundle_tree_sha).toBeNull();

    // And it accepts a SHA string.
    await db
      .updateTable('skills_v1_skills')
      .set({ bundle_tree_sha: 'a'.repeat(40) })
      .where('skill_id', '=', 'demo')
      .execute();
    const updated = await db
      .selectFrom('skills_v1_skills')
      .select('bundle_tree_sha')
      .where('skill_id', '=', 'demo')
      .executeTakeFirstOrThrow();
    expect(updated.bundle_tree_sha).toBe('a'.repeat(40));
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

  it('skills_v1_user_skills has a nullable bundle_tree_sha column', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    await db
      .insertInto('skills_v1_user_skills')
      .values({
        owner_user_id: 'alice',
        skill_id: 'demo',
        description: 'd',
        manifest_yaml: 'name: demo\ndescription: d\nversion: 1\n',
        body_md: '# demo\n',
        version: 1,
      })
      .execute();
    const row = await db
      .selectFrom('skills_v1_user_skills')
      .select('bundle_tree_sha')
      .where('owner_user_id', '=', 'alice')
      .where('skill_id', '=', 'demo')
      .executeTakeFirstOrThrow();
    expect(row.bundle_tree_sha).toBeNull();
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

describe('runSkillsMigration — skills_v1_user_attachments side-table', () => {
  it('creates skills_v1_user_attachments with the compound PK (user, agent, skill)', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    await db
      .insertInto('skills_v1_user_attachments')
      .values([
        { owner_user_id: 'u1', agent_id: 'a1', skill_id: 'github', credential_bindings: JSON.stringify({ GITHUB_TOKEN: 'ref1' }) as unknown },
        { owner_user_id: 'u1', agent_id: 'a1', skill_id: 'linear', credential_bindings: JSON.stringify({}) as unknown },
        { owner_user_id: 'u1', agent_id: 'a2', skill_id: 'github', credential_bindings: JSON.stringify({ GITHUB_TOKEN: 'ref2' }) as unknown },
      ])
      .execute();

    // Distinct (user, agent) pairs keep their own rows.
    const a1 = await db
      .selectFrom('skills_v1_user_attachments')
      .selectAll()
      .where('owner_user_id', '=', 'u1')
      .where('agent_id', '=', 'a1')
      .orderBy('skill_id')
      .execute();
    expect(a1.map((r) => r.skill_id)).toEqual(['github', 'linear']);

    // Same (user, agent, skill) again must violate the compound PK.
    await expect(
      db
        .insertInto('skills_v1_user_attachments')
        .values({ owner_user_id: 'u1', agent_id: 'a1', skill_id: 'github', credential_bindings: JSON.stringify({}) as unknown })
        .execute(),
    ).rejects.toThrow();
  });

  it('credential_bindings is JSONB defaulting to {}', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>`
      SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skills_v1_user_attachments'
         AND column_name = 'credential_bindings'
    `.execute(db);

    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]?.data_type).toBe('jsonb');
    expect(cols.rows[0]?.is_nullable).toBe('NO');
  });

  it('is idempotent — running runSkillsMigration twice does not throw', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    await runSkillsMigration(db);

    await db
      .insertInto('skills_v1_user_attachments')
      .values({ owner_user_id: 'u1', agent_id: 'a1', skill_id: 'github', credential_bindings: JSON.stringify({}) as unknown })
      .execute();
    const rows = await db.selectFrom('skills_v1_user_attachments').select('skill_id').execute();
    expect(rows).toHaveLength(1);
  });
});

describe('runSkillsMigration — skills_v1_catalog_requests admit queue', () => {
  it('creates skills_v1_catalog_requests; one pending request per skill_id', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    await db
      .insertInto('skills_v1_catalog_requests')
      .values({
        request_id: 'req-1',
        kind: 'share',
        skill_id: 'linear',
        requested_by_user_id: 'alice',
        source_owner_user_id: 'alice',
        status: 'pending',
        description: 'share my linear skill',
        manifest_yaml: 'name: linear\ndescription: d\nversion: 1\n',
        body_md: '# linear\n',
        bundle_tree_sha: null,
      })
      .execute();

    const row = await db
      .selectFrom('skills_v1_catalog_requests')
      .selectAll()
      .where('request_id', '=', 'req-1')
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(row.decided_at).toBeNull();

    // A SECOND pending request for the same skill_id is rejected by the partial
    // unique index (one pending per skill_id — the dedup guarantee).
    await expect(
      db
        .insertInto('skills_v1_catalog_requests')
        .values({
          request_id: 'req-2',
          kind: 'share',
          skill_id: 'linear',
          requested_by_user_id: 'bob',
          source_owner_user_id: 'bob',
          status: 'pending',
          description: 'dup',
          manifest_yaml: null,
          body_md: null,
          bundle_tree_sha: null,
        })
        .execute(),
    ).rejects.toThrow();

    // But once req-1 is decided, a fresh pending request for the same id is allowed.
    await db
      .updateTable('skills_v1_catalog_requests')
      .set({ status: 'admitted', decided_at: new Date(), decided_by_user_id: 'admin' })
      .where('request_id', '=', 'req-1')
      .execute();
    await db
      .insertInto('skills_v1_catalog_requests')
      .values({
        request_id: 'req-3',
        kind: 'share',
        skill_id: 'linear',
        requested_by_user_id: 'bob',
        source_owner_user_id: 'bob',
        status: 'pending',
        description: 're-submit after decision',
        manifest_yaml: null,
        body_md: null,
        bundle_tree_sha: null,
      })
      .execute();

    const pending = await db
      .selectFrom('skills_v1_catalog_requests')
      .select('request_id')
      .where('status', '=', 'pending')
      .execute();
    expect(pending.map((r) => r.request_id)).toEqual(['req-3']);
  });

  it('is idempotent — running runSkillsMigration twice does not throw', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    await runSkillsMigration(db);

    await db
      .insertInto('skills_v1_catalog_requests')
      .values({
        request_id: 'rerun-1',
        kind: 'cold-start',
        skill_id: 'jira',
        requested_by_user_id: 'alice',
        source_owner_user_id: null,
        status: 'pending',
        description: 'need jira',
        manifest_yaml: null,
        body_md: null,
        bundle_tree_sha: null,
      })
      .execute();
    const rows = await db.selectFrom('skills_v1_catalog_requests').select('request_id').execute();
    expect(rows).toHaveLength(1);
  });
});
