import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runDiskQuotaMigration, type DiskQuotaDatabase } from '../migrations.js';
import { createDiskQuotaStore, type DiskQuotaStore } from '../store.js';

let container: StartedPostgreSqlContainer;
let db: Kysely<DiskQuotaDatabase>;
let store: DiskQuotaStore;

const MB = 1_048_576;
const GB = 1024 * MB;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  db = new Kysely<DiskQuotaDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: container.getConnectionUri(), max: 5 }),
    }),
  });
  await runDiskQuotaMigration(db);
  // Idempotent: a second boot must not fail.
  await runDiskQuotaMigration(db);
  store = createDiskQuotaStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE disk_quota_v1_usage, disk_quota_v1_ref_holders`.execute(db);
});

afterAll(async () => {
  await db?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

describe('upsertUsage', () => {
  it('is one row per (owner, source): re-putting REPLACES the bytes, it never adds', async () => {
    await store.upsertUsage('alice', 'blob:aaa', 'blob', 5 * MB);
    await store.upsertUsage('alice', 'blob:aaa', 'blob', 5 * MB);
    await store.upsertUsage('alice', 'blob:aaa', 'blob', 5 * MB);
    expect(await store.usageFor('alice')).toEqual({ workspaceBytes: 0, fileBytes: 5 * MB });
    const rows = await db.selectFrom('disk_quota_v1_usage').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('a re-measured workspace replaces its previous figure, up or down', async () => {
    await store.upsertUsage('alice', 'workspace:agt_1', 'workspace', 10 * MB);
    await store.upsertUsage('alice', 'workspace:agt_1', 'workspace', 30 * MB);
    expect((await store.usageFor('alice')).workspaceBytes).toBe(30 * MB);
    await store.upsertUsage('alice', 'workspace:agt_1', 'workspace', 4 * MB);
    expect((await store.usageFor('alice')).workspaceBytes).toBe(4 * MB);
  });

  it('bumps updated_at on a re-upsert', async () => {
    await store.upsertUsage('alice', 'blob:aaa', 'blob', 1);
    await sql`UPDATE disk_quota_v1_usage SET updated_at = '2020-01-01T00:00:00Z'`.execute(db);
    await store.upsertUsage('alice', 'blob:aaa', 'blob', 1);
    const row = await db.selectFrom('disk_quota_v1_usage').select('updated_at').executeTakeFirstOrThrow();
    expect(new Date(row.updated_at).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('clamps hostile figures to whole, non-negative numbers', async () => {
    await store.upsertUsage('alice', 'blob:neg', 'blob', -5);
    await store.upsertUsage('alice', 'blob:nan', 'blob', Number.NaN);
    await store.upsertUsage('alice', 'blob:inf', 'blob', Number.POSITIVE_INFINITY);
    await store.upsertUsage('alice', 'blob:frac', 'blob', 10.9);
    expect(await store.usageFor('alice')).toEqual({ workspaceBytes: 0, fileBytes: 10 });
  });

  it('holds sizes past 2^31 (BIGINT, not INTEGER) and reads them back as numbers', async () => {
    await store.upsertUsage('alice', 'workspace:big', 'workspace', 5 * GB);
    const usage = await store.usageFor('alice');
    expect(usage.workspaceBytes).toBe(5 * GB);
    expect(typeof usage.workspaceBytes).toBe('number');
  });

  it('the database itself refuses an unknown kind or negative bytes', async () => {
    await expect(
      sql`INSERT INTO disk_quota_v1_usage (owner_id, source, kind, bytes) VALUES ('a', 's', 'nope', 1)`.execute(db),
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO disk_quota_v1_usage (owner_id, source, kind, bytes) VALUES ('a', 's', 'blob', -1)`.execute(db),
    ).rejects.toThrow();
  });
});

describe('usageFor', () => {
  it('sums each kind separately across an owner\'s sources', async () => {
    await store.upsertUsage('alice', 'workspace:agt_1', 'workspace', 100);
    await store.upsertUsage('alice', 'workspace:agt_2', 'workspace', 20);
    await store.upsertUsage('alice', 'blob:aaa', 'blob', 3);
    await store.upsertUsage('alice', 'blob:bbb', 'blob', 4);
    expect(await store.usageFor('alice')).toEqual({ workspaceBytes: 120, fileBytes: 7 });
  });

  it('is zero for an owner with no rows', async () => {
    expect(await store.usageFor('nobody')).toEqual({ workspaceBytes: 0, fileBytes: 0 });
  });

  it('never mixes owners, and two owners of the same sha are each charged', async () => {
    await store.upsertUsage('alice', 'blob:same', 'blob', 50);
    await store.upsertUsage('bob', 'blob:same', 'blob', 50);
    await store.upsertUsage('bob', 'workspace:agt_9', 'workspace', 7);
    expect(await store.usageFor('alice')).toEqual({ workspaceBytes: 0, fileBytes: 50 });
    expect(await store.usageFor('bob')).toEqual({ workspaceBytes: 7, fileBytes: 50 });
  });

  it('treats a team owner id as its own owner, apart from a person with the same tail', async () => {
    await store.upsertUsage('team:t1', 'workspace:agt_t', 'workspace', 9);
    await store.upsertUsage('t1', 'blob:x', 'blob', 1);
    expect(await store.usageFor('team:t1')).toEqual({ workspaceBytes: 9, fileBytes: 0 });
    expect(await store.usageFor('t1')).toEqual({ workspaceBytes: 0, fileBytes: 1 });
  });
});

// An agent delete frees its repo, so its ledger row has to go too, or the owner
// stays charged for bytes that no longer exist. The row is keyed on the AGENT
// alone: a team agent's row sits under `team:<id>` and a fallback-charged one
// under whichever user was acting, and the delete has to catch both.
describe('deleteWorkspaceUsage', () => {
  const sha = 'a'.repeat(64);

  it("drops that agent's workspace row for EVERY owner, and touches nothing else", async () => {
    await store.upsertUsage('alice', 'workspace:agt_a', 'workspace', 10 * MB);
    await store.upsertUsage('team:t1', 'workspace:agt_a', 'workspace', 20 * MB);
    await store.upsertUsage('alice', 'workspace:agt_b', 'workspace', 5 * MB);
    await store.upsertUsage('alice', `blob:${sha}`, 'blob', 4 * MB);
    // A blob whose source merely ENDS in the agent id is not that agent's workspace.
    await store.upsertUsage('alice', 'blob:agt_a', 'blob', 7);
    // An agent whose id merely BEGINS with the deleted one's is a different
    // agent (`agt_a` is a true prefix of `agt_ab`), for every owner it is charged to.
    await store.upsertUsage('alice', 'workspace:agt_ab', 'workspace', 3 * MB);
    await store.upsertUsage('team:t1', 'workspace:agt_ab', 'workspace', 2 * MB);

    expect(await store.deleteWorkspaceUsage('agt_a')).toBe(2);

    expect(await store.usageFor('team:t1')).toEqual({ workspaceBytes: 2 * MB, fileBytes: 0 });
    expect(await store.usageFor('alice')).toEqual({ workspaceBytes: 8 * MB, fileBytes: 4 * MB + 7 });
    const left = await db.selectFrom('disk_quota_v1_usage').select(['owner_id', 'source']).execute();
    expect(left.map((r) => `${r.owner_id} ${r.source}`).sort()).toEqual(
      [
        'alice blob:agt_a',
        `alice blob:${sha}`,
        'alice workspace:agt_ab',
        'alice workspace:agt_b',
        'team:t1 workspace:agt_ab',
      ].sort(),
    );
  });

  it('is idempotent: a second delete, or one for an agent nobody charged, removes nothing', async () => {
    await store.upsertUsage('alice', 'workspace:agt_a', 'workspace', 10 * MB);
    expect(await store.deleteWorkspaceUsage('agt_a')).toBe(1);
    expect(await store.deleteWorkspaceUsage('agt_a')).toBe(0);
    expect(await store.deleteWorkspaceUsage('agt_never')).toBe(0);
  });

  it('treats the agent id as data: wildcards and quotes match no other agent', async () => {
    await store.upsertUsage('alice', 'workspace:agt_a', 'workspace', 1);
    await store.upsertUsage('alice', 'workspace:agt_b', 'workspace', 2);
    for (const hostile of ['%', 'agt_%', 'agt__', "x' OR '1'='1", '']) {
      expect(await store.deleteWorkspaceUsage(hostile), hostile).toBe(0);
    }
    expect((await store.usageFor('alice')).workspaceBytes).toBe(3);
  });

  it('never deletes a blob-kind row, even one whose source reads like a workspace', async () => {
    await sql`INSERT INTO disk_quota_v1_usage (owner_id, source, kind, bytes) VALUES ('alice', 'workspace:agt_k', 'blob', 9)`.execute(
      db,
    );
    expect(await store.deleteWorkspaceUsage('agt_k')).toBe(0);
    expect((await store.usageFor('alice')).fileBytes).toBe(9);
  });
});

describe('topOwners and totals', () => {
  it('orders by total (workspace + files) descending, ties by owner id', async () => {
    await store.upsertUsage('small', 'blob:a', 'blob', 10);
    await store.upsertUsage('big-files', 'blob:b', 'blob', 900);
    await store.upsertUsage('mixed', 'workspace:w', 'workspace', 500);
    await store.upsertUsage('mixed', 'blob:c', 'blob', 500);
    await store.upsertUsage('tie-b', 'blob:d', 'blob', 100);
    await store.upsertUsage('tie-a', 'blob:e', 'blob', 100);
    const top = await store.topOwners(10);
    expect(top).toEqual([
      { ownerId: 'mixed', workspaceBytes: 500, fileBytes: 500 },
      { ownerId: 'big-files', workspaceBytes: 0, fileBytes: 900 },
      { ownerId: 'tie-a', workspaceBytes: 0, fileBytes: 100 },
      { ownerId: 'tie-b', workspaceBytes: 0, fileBytes: 100 },
      { ownerId: 'small', workspaceBytes: 0, fileBytes: 10 },
    ]);
  });

  it('honours the limit and returns the biggest ones', async () => {
    for (let i = 1; i <= 5; i++) await store.upsertUsage(`u${i}`, 'blob:x', 'blob', i * 10);
    const top = await store.topOwners(2);
    expect(top.map((o) => o.ownerId)).toEqual(['u5', 'u4']);
    // A nonsense limit still returns at least one row rather than throwing.
    expect((await store.topOwners(0)).length).toBe(1);
    expect((await store.topOwners(Number.NaN)).length).toBe(5);
  });

  it('is empty when nothing was ever recorded', async () => {
    expect(await store.topOwners(200)).toEqual([]);
    expect(await store.totals()).toEqual({ owners: 0, bytes: 0 });
  });

  it('totals count EVERY owner, not just the ones a capped list returns', async () => {
    for (let i = 1; i <= 5; i++) await store.upsertUsage(`u${i}`, 'blob:x', 'blob', i * 10);
    await store.upsertUsage('u1', 'workspace:w', 'workspace', 1);
    expect((await store.topOwners(2)).length).toBe(2);
    expect(await store.totals()).toEqual({ owners: 5, bytes: 10 + 20 + 30 + 40 + 50 + 1 });
  });
});

// The blob pass (design D6). Rows are aged by hand: `upsertUsage` stamps the
// database's now(), and the cutoff is whatever the caller passes.
describe('the blob pass queries', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const C = 'c'.repeat(64);
  const OLD = new Date('2020-01-01T00:00:00Z');
  const CUTOFF = new Date('2021-01-01T00:00:00Z');

  async function age(owner: string, source: string, at: Date = OLD): Promise<void> {
    await sql`UPDATE disk_quota_v1_usage SET updated_at = ${at} WHERE owner_id = ${owner} AND source = ${source}`.execute(
      db,
    );
  }

  async function sources(): Promise<string[]> {
    const rows = await db.selectFrom('disk_quota_v1_usage').select(['owner_id', 'source']).execute();
    return rows.map((r) => `${r.owner_id} ${r.source}`).sort();
  }

  describe('staleBlobShas', () => {
    it('lists distinct shas of blob rows older than the cutoff, in sha order', async () => {
      for (const [owner, sha] of [
        ['alice', B],
        ['bob', B],
        ['alice', A],
        ['carol', C],
      ] as const) {
        await store.upsertUsage(owner, `blob:${sha}`, 'blob', 1);
        await age(owner, `blob:${sha}`);
      }
      // carol's C was re-put: fresh, so not stale.
      await store.upsertUsage('carol', `blob:${C}`, 'blob', 1);
      expect(await store.staleBlobShas(CUTOFF, undefined, 1000)).toEqual([A, B]);
    });

    it('never offers a row whose source is not blob:<64 lowercase hex>, or a workspace row', async () => {
      for (const source of [
        'blob:seed',
        `blob:${'A'.repeat(64)}`,
        `blob:${'a'.repeat(63)}`,
        `blob:${'a'.repeat(65)}`,
        `blob:${A}x`,
        `blob:${A}\n`,
      ]) {
        await store.upsertUsage('alice', source, 'blob', 1);
        await age('alice', source);
      }
      // A workspace-kind row whose source happens to look like a blob.
      await sql`INSERT INTO disk_quota_v1_usage (owner_id, source, kind, bytes, updated_at)
                VALUES ('alice', ${`blob:${B}`}, 'workspace', 1, ${OLD})`.execute(db);
      expect(await store.staleBlobShas(CUTOFF, undefined, 1000)).toEqual([]);
      expect(await store.staleBlobRows([B], CUTOFF)).toEqual([]);
    });

    it('pages with a cursor and a limit', async () => {
      for (const sha of [C, A, B]) {
        await store.upsertUsage('alice', `blob:${sha}`, 'blob', 1);
        await age('alice', `blob:${sha}`);
      }
      expect(await store.staleBlobShas(CUTOFF, undefined, 2)).toEqual([A, B]);
      expect(await store.staleBlobShas(CUTOFF, B, 2)).toEqual([C]);
      expect(await store.staleBlobShas(CUTOFF, C, 2)).toEqual([]);
    });

    it('a re-put refreshes updated_at, so the row stops being stale', async () => {
      await store.upsertUsage('alice', `blob:${A}`, 'blob', 1);
      await age('alice', `blob:${A}`);
      const cutoff = new Date(Date.now() - 60_000);
      expect(await store.staleBlobShas(cutoff, undefined, 10)).toEqual([A]);
      await store.upsertUsage('alice', `blob:${A}`, 'blob', 1);
      expect(await store.staleBlobShas(cutoff, undefined, 10)).toEqual([]);
    });
  });

  describe('staleBlobRows + releaseBlobRows', () => {
    it('lists (owner, sha) per stale row, and releases exactly the rows asked for', async () => {
      await store.upsertUsage('alice', `blob:${A}`, 'blob', 1);
      await store.upsertUsage('bob', `blob:${A}`, 'blob', 1);
      await store.upsertUsage('alice', `blob:${B}`, 'blob', 1);
      await store.upsertUsage('alice', 'workspace:agt', 'workspace', 1);
      await age('alice', `blob:${A}`);
      await age('bob', `blob:${A}`);
      await age('alice', `blob:${B}`);
      await age('alice', 'workspace:agt');

      expect(await store.staleBlobRows([A], CUTOFF)).toEqual([
        { ownerId: 'alice', sha256: A },
        { ownerId: 'bob', sha256: A },
      ]);
      expect(await store.staleBlobRows([], CUTOFF)).toEqual([]);

      expect(await store.releaseBlobRows([{ ownerId: 'alice', sha256: A }], CUTOFF)).toBe(1);
      expect(await sources()).toEqual(
        ['alice blob:' + B, 'alice workspace:agt', 'bob blob:' + A].sort(),
      );
      expect(await store.releaseBlobRows([], CUTOFF)).toBe(0);
    });

    it('re-checks the age in the DELETE: a re-put between select and delete keeps its row', async () => {
      await store.upsertUsage('alice', `blob:${A}`, 'blob', 1);
      await store.upsertUsage('bob', `blob:${A}`, 'blob', 1);
      await age('alice', `blob:${A}`);
      await age('bob', `blob:${A}`);
      const cutoff = new Date(Date.now() - 60_000);
      const rows = await store.staleBlobRows([A], cutoff);
      expect(rows).toHaveLength(2);
      // alice re-puts the same bytes while the pass is deciding.
      await store.upsertUsage('alice', `blob:${A}`, 'blob', 1);
      expect(await store.releaseBlobRows(rows, cutoff)).toBe(1);
      expect(await sources()).toEqual([`alice blob:${A}`]);
    });

    it('never deletes a workspace-kind row, even under a blob-looking source', async () => {
      await sql`INSERT INTO disk_quota_v1_usage (owner_id, source, kind, bytes, updated_at)
                VALUES ('alice', ${`blob:${A}`}, 'workspace', 1, ${OLD})`.execute(db);
      expect(await store.releaseBlobRows([{ ownerId: 'alice', sha256: A }], CUTOFF)).toBe(0);
      expect(await sources()).toEqual([`alice blob:${A}`]);
    });
  });

  describe('the ref-holder roster', () => {
    it('touch adds holders and bumps last_seen_at, keeping first_seen_at; forget drops one', async () => {
      expect(await store.listRefHolders()).toEqual([]);
      await store.touchRefHolders(['@ax/skills', '@ax/attachments', '@ax/skills']);
      expect(await store.listRefHolders()).toEqual(['@ax/attachments', '@ax/skills']);

      await sql`UPDATE disk_quota_v1_ref_holders SET first_seen_at = ${OLD}, last_seen_at = ${OLD}`.execute(db);
      await store.touchRefHolders(['@ax/skills']);
      const rows = await db
        .selectFrom('disk_quota_v1_ref_holders')
        .selectAll()
        .orderBy('holder')
        .execute();
      expect(rows.map((r) => [r.holder, new Date(r.first_seen_at).getUTCFullYear()])).toEqual([
        ['@ax/attachments', 2020],
        ['@ax/skills', 2020],
      ]);
      expect(new Date(rows[0]!.last_seen_at).getUTCFullYear()).toBe(2020);
      expect(new Date(rows[1]!.last_seen_at).getUTCFullYear()).toBeGreaterThan(2020);

      await store.touchRefHolders([]);
      expect(await store.forgetRefHolder('@ax/skills')).toBe(true);
      expect(await store.forgetRefHolder('@ax/skills')).toBe(false);
      expect(await store.listRefHolders()).toEqual(['@ax/attachments']);
    });
  });
});
