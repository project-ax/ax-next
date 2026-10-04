import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  BLOB_COLLECT_REFS_HOOK,
  readBlobCollectRefsAnswers,
  type BlobCollectRefsPayload,
} from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { createSkillsPlugin } from '../plugin.js';
import type { SkillsDatabase } from '../migrations.js';
import { collectBundleRefs } from '../blob-refs-store.js';
import { blobStoreFakeServices } from './_blob-fake.js';

// ---------------------------------------------------------------------------
// TASK-776 (blob-gc design D2/D7): @ax/skills is a `blob:collect-refs` holder.
// Four tables carry a `bundle_tree_sha` (a blob sha256 despite the name):
//
//   skills_v1_skills            global, system-held   -> userIds: []
//   skills_v1_user_skills       a user's own copy     -> [owner_user_id]
//   skills_v1_authored          an agent-authored one -> [owner_user_id]
//   skills_v1_catalog_requests  a share snapshot      -> [source_owner_user_id]
//                                                        when set, else []
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);

const ALL_TABLES = [
  'skills_v1_catalog_requests',
  'skills_v1_user_attachments',
  'skills_v1_skill_files',
  'skills_v1_user_skills',
  'skills_v1_skills',
  'skills_v1_quarantine',
  'skills_v1_approved_caps',
  'skills_v1_authored',
];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      ...blobStoreFakeServices(),
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => ({ user: { id: 'admin', isAdmin: true } }),
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), createSkillsPlugin()],
  });
  harnesses.push(h);
  return h;
}

async function dbOf(h: TestHarness): Promise<Kysely<SkillsDatabase>> {
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  return db as Kysely<SkillsDatabase>;
}

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

/** One bundle-carrying row in each of the four tables. */
async function seed(): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO skills_v1_skills (skill_id, description, manifest_yaml, body_md, bundle_tree_sha)
       VALUES ('global-skill', 'd', 'name: x', '', $1)`,
      [A],
    );
    await c.query(
      `INSERT INTO skills_v1_user_skills (owner_user_id, skill_id, description, manifest_yaml, body_md, bundle_tree_sha)
       VALUES ('u-user', 'mine', 'd', 'name: x', '', $1)`,
      [B],
    );
    await c.query(
      `INSERT INTO skills_v1_authored (owner_user_id, agent_id, skill_id, manifest_yaml, bundle_tree_sha)
       VALUES ('u-author', 'agent-1', 'drafted', 'name: x', $1)`,
      [C],
    );
    await c.query(
      `INSERT INTO skills_v1_catalog_requests (request_id, kind, skill_id, requested_by_user_id, source_owner_user_id, bundle_tree_sha)
       VALUES ('req-share', 'share', 'shared', 'u-requester', 'u-source', $1)`,
      [D],
    );
  });
}

async function ask(h: TestHarness, candidates: string[]): Promise<BlobCollectRefsPayload> {
  const start: BlobCollectRefsPayload = { candidates, answers: [] };
  const res = await h.bus.fire<unknown>(BLOB_COLLECT_REFS_HOOK, h.ctx(), start);
  expect(res.rejected).toBe(false);
  return (res.rejected ? start : res.payload) as BlobCollectRefsPayload;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  await withClient(async (c) => {
    for (const t of ALL_TABLES) await c.query(`DROP TABLE IF EXISTS ${t}`);
  });
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('collectBundleRefs', () => {
  it('answers each table with the right owner: global = nobody, user/authored/source = a person', async () => {
    const h = await makeHarness();
    await seed();
    const refs = await collectBundleRefs(await dbOf(h), [A, B, C, D, E]);
    expect(refs).toHaveLength(4);
    expect(refs).toContainEqual({ sha256: A, userIds: [] });
    expect(refs).toContainEqual({ sha256: B, userIds: ['u-user'] });
    expect(refs).toContainEqual({ sha256: C, userIds: ['u-author'] });
    // The share snapshot belongs to the user whose working copy it was taken
    // from, not to whoever happened to submit it.
    expect(refs).toContainEqual({ sha256: D, userIds: ['u-source'] });
  });

  it('a catalog request with no source owner (cold start / null / empty) is held for nobody', async () => {
    const h = await makeHarness();
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO skills_v1_catalog_requests (request_id, kind, skill_id, requested_by_user_id, source_owner_user_id, bundle_tree_sha)
         VALUES ('r-null', 'share', 's1', 'u-r', NULL, $1), ('r-empty', 'share', 's2', 'u-r', '', $2)`,
        [A, B],
      );
    });
    const refs = await collectBundleRefs(await dbOf(h), [A, B]);
    expect(refs).toContainEqual({ sha256: A, userIds: [] });
    expect(refs).toContainEqual({ sha256: B, userIds: [] });
  });

  it('counts a decided (admitted / rejected) catalog request: its snapshot is still a reference', async () => {
    const h = await makeHarness();
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO skills_v1_catalog_requests (request_id, kind, skill_id, requested_by_user_id, source_owner_user_id, status, bundle_tree_sha)
         VALUES ('r-done', 'share', 's1', 'u-r', 'u-src', 'rejected', $1)`,
        [A],
      );
    });
    expect(await collectBundleRefs(await dbOf(h), [A])).toEqual([{ sha256: A, userIds: ['u-src'] }]);
  });

  it('leaves out rows whose sha is not a candidate, and NULL bundle pointers', async () => {
    const h = await makeHarness();
    await seed();
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO skills_v1_skills (skill_id, description, manifest_yaml, body_md, bundle_tree_sha)
         VALUES ('single-file', 'd', 'name: x', '', NULL)`,
      );
    });
    expect(await collectBundleRefs(await dbOf(h), [E])).toEqual([]);
    expect(await collectBundleRefs(await dbOf(h), [])).toEqual([]);
  });
});

describe('@ax/skills as a blob:collect-refs holder', () => {
  it('appends one ok answer with the per-table owners', async () => {
    const h = await makeHarness();
    await seed();
    const out = await ask(h, [A, B, C, D, E]);
    expect(out.answers).toHaveLength(1);
    expect(out.answers[0]!.holder).toBe('@ax/skills');
    expect(out.answers[0]!.ok).toBe(true);

    const read = readBlobCollectRefsAnswers(out, [A, B, C, D, E]);
    expect(read.failed).toEqual([]);
    // Global skill: held, but by no person -> the bytes are kept and no ledger
    // charge is released for them.
    expect(read.held.get(A)).toEqual({ userIds: new Set(), unattributed: true });
    expect([...read.held.get(B)!.userIds]).toEqual(['u-user']);
    expect([...read.held.get(C)!.userIds]).toEqual(['u-author']);
    expect([...read.held.get(D)!.userIds]).toEqual(['u-source']);
    expect(read.held.has(E)).toBe(false);
  });

  it('answers ok:false (never "no refs") when it cannot read one of its tables', async () => {
    const h = await makeHarness();
    await withClient(async (c) => {
      await c.query('DROP TABLE skills_v1_authored');
    });
    const out = await ask(h, [A]);
    expect(out.answers).toEqual([{ holder: '@ax/skills', ok: false, refs: [] }]);
    expect(readBlobCollectRefsAnswers(out, [A]).failed).toEqual(['@ax/skills']);
  });

  it('answers ok:false for a payload it cannot trust, and never throws', async () => {
    const h = await makeHarness();
    const res = await h.bus.fire<unknown>(BLOB_COLLECT_REFS_HOOK, h.ctx(), {
      candidates: 'not-a-list',
      answers: [],
    });
    expect(res.rejected).toBe(false);
    const answers = res.rejected ? [] : (res.payload as BlobCollectRefsPayload).answers;
    expect(answers).toEqual([{ holder: '@ax/skills', ok: false, refs: [] }]);
  });
});
