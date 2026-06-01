import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runSkillsMigration, type SkillsDatabase } from '../migrations.js';
import { createInMemoryBundleStore } from '../blob-bundle-store.js';
import { createCatalogRequestsStore } from '../catalog-requests-store.js';

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

function freshBundleStore() {
  return createInMemoryBundleStore();
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
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('createCatalogRequestsStore', () => {
  it('submitShare snapshots the bundle; listPending/get reconstruct files', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createCatalogRequestsStore(db, freshBundleStore());

    const { request, created } = await store.submitShare({
      skillId: 'linear',
      requestedByUserId: 'alice',
      description: 'share linear',
      manifestYaml: 'name: linear\ndescription: d\nversion: 1\n',
      bodyMd: '# linear\n',
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    });
    expect(created).toBe(true);
    expect(request.kind).toBe('share');
    expect(request.status).toBe('pending');
    expect(request.skillId).toBe('linear');
    expect(request.sourceOwnerUserId).toBe('alice');
    expect(request.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
    expect(request.manifestYaml).toContain('name: linear');

    const pending = await store.listPending();
    expect(pending.map((r) => r.skillId)).toEqual(['linear']);
    expect(pending[0]?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);

    const got = await store.get(request.requestId);
    expect(got?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  });

  it('a single-file share snapshots files: [] (bundle_tree_sha NULL)', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createCatalogRequestsStore(db, freshBundleStore());
    const { request } = await store.submitShare({
      skillId: 'gh',
      requestedByUserId: 'alice',
      description: 'd',
      manifestYaml: 'name: gh\ndescription: d\nversion: 1\n',
      bodyMd: '# gh\n',
      files: [],
    });
    expect(request.files).toEqual([]);
    const raw = await db
      .selectFrom('skills_v1_catalog_requests')
      .select('bundle_tree_sha')
      .where('request_id', '=', request.requestId)
      .executeTakeFirstOrThrow();
    expect(raw.bundle_tree_sha).toBeNull();
  });

  it('a second pending submit for the same skill_id dedups (created: false)', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createCatalogRequestsStore(db, freshBundleStore());
    const first = await store.submitColdStart({
      skillId: 'jira',
      requestedByUserId: 'alice',
      description: 'need jira',
    });
    expect(first.created).toBe(true);
    const second = await store.submitColdStart({
      skillId: 'jira',
      requestedByUserId: 'bob',
      description: 'me too',
    });
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId); // returns the existing one
    expect((await store.listPending()).length).toBe(1);
  });

  it('markDecided flips status and stamps the decider; frees the id for re-submit', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createCatalogRequestsStore(db, freshBundleStore());
    const { request } = await store.submitColdStart({
      skillId: 'jira',
      requestedByUserId: 'alice',
      description: 'need jira',
    });
    await store.markDecided(request.requestId, 'rejected', 'admin');
    expect((await store.get(request.requestId))?.status).toBe('rejected');
    expect((await store.listPending()).length).toBe(0);
    // id freed:
    const again = await store.submitColdStart({
      skillId: 'jira',
      requestedByUserId: 'alice',
      description: 'still need jira',
    });
    expect(again.created).toBe(true);
  });
});
