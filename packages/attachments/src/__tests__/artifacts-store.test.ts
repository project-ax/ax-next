import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { runAttachmentsMigration, type AttachmentsDatabase } from '../migrations.js';
import { finishArtifactsMigration } from '../artifacts/migrations.js';
import {
  MAX_RETAINED_VERSIONS,
  createArtifactStore,
  versionsToPrune,
  type ArtifactStore,
  type PublishVersionInput,
} from '../artifacts/store.js';

// ---------------------------------------------------------------------------
// Agent-scoped, versioned artifact storage against a real Postgres: heads in
// attachments_v1_artifacts, one row per version in
// attachments_v1_artifact_versions.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AttachmentsDatabase>[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.destroy().catch(() => {});
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_artifact_versions');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_artifacts');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_files');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_temps');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

async function freshStore(): Promise<{ db: Kysely<AttachmentsDatabase>; store: ArtifactStore }> {
  const db = new Kysely<AttachmentsDatabase>({
    // Room for the concurrency cases: each publish holds a connection.
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 8 }) }),
  });
  opened.push(db);
  await runAttachmentsMigration(db);
  await finishArtifactsMigration(db);
  return { db, store: createArtifactStore(db) };
}

const SHA = (n: number): string => n.toString(16).padStart(64, '0');

function input(over: Partial<PublishVersionInput> = {}): PublishVersionInput {
  return {
    agentId: 'agt-1',
    sourcePath: 'deal.html',
    title: 'Deal tracker',
    sha256: SHA(1),
    mediaType: 'text/html',
    sizeBytes: 10,
    conversationId: 'c-1',
    publishedBy: 'u-1',
    quotaOwner: 'u-1',
    ...over,
  };
}

async function ok(store: ArtifactStore, over: Partial<PublishVersionInput> = {}) {
  const r = await store.publishVersion(input(over));
  if (!r.ok) throw new Error(`publish refused: ${r.reason}`);
  return r;
}

describe('ArtifactStore.publishVersion', () => {
  it('first publish of a path makes v1; publishing the same path again makes v2 of the same artifact', async () => {
    const { store } = await freshStore();
    const first = await ok(store);
    expect(first).toMatchObject({ version: 1, created: true, title: 'Deal tracker' });
    expect(first.artifactId).toMatch(/^[0-9a-f]{32}$/);

    const second = await ok(store, { sha256: SHA(2), sizeBytes: 20 });
    expect(second).toEqual({ ok: true, artifactId: first.artifactId, version: 2, title: 'Deal tracker', created: false });

    const head = await store.getHead(first.artifactId);
    expect(head).toMatchObject({
      artifactId: first.artifactId,
      agentId: 'agt-1',
      sourcePath: 'deal.html',
      currentVersion: 2,
      shareCode: null,
      titleSetByUser: false,
      createdByUserId: 'u-1',
    });
    expect(head!.current).toMatchObject({ version: 2, sha256: SHA(2), sizeBytes: 20, conversationId: 'c-1' });
    expect((await store.listVersions(first.artifactId)).map((v) => v.version)).toEqual([2, 1]);
    expect(await store.getVersion(first.artifactId, 1)).toMatchObject({ sha256: SHA(1), publishedBy: 'u-1', quotaOwner: 'u-1' });
  });

  it('the same path under another agent is another artifact', async () => {
    const { store } = await freshStore();
    const a = await ok(store);
    const b = await ok(store, { agentId: 'agt-2' });
    expect(b.created).toBe(true);
    expect(b.artifactId).not.toBe(a.artifactId);
  });

  it('concurrent first publishes of one path make one artifact', async () => {
    const { store } = await freshStore();
    const [a, b] = await Promise.all([ok(store, { sourcePath: 'deal.html' }), ok(store, { sourcePath: 'deal.html' })]);
    expect(a.artifactId).toBe(b.artifactId);
    expect([a.version, b.version].sort()).toEqual([1, 2]);
  });

  it('five concurrent re-publishes get versions 2..6 with no gaps or repeats', async () => {
    const { store } = await freshStore();
    const first = await ok(store);
    const results = await Promise.all([2, 3, 4, 5, 6].map((n) => ok(store, { sha256: SHA(n) })));
    expect(results.map((r) => r.version).sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6]);
    expect(new Set(results.map((r) => r.artifactId))).toEqual(new Set([first.artifactId]));
    expect((await store.getHead(first.artifactId))!.currentVersion).toBe(6);
  });

  it('publish with an artifactId of another agent is unknown-artifact; with a path another artifact holds is path-taken', async () => {
    const { store } = await freshStore();
    const mine = await ok(store, { sourcePath: 'a.html' });
    await ok(store, { sourcePath: 'b.html' });
    const theirs = await ok(store, { agentId: 'agt-2', sourcePath: 'c.html' });

    expect(await store.publishVersion(input({ artifactId: theirs.artifactId, sourcePath: 'c.html' }))).toEqual({
      ok: false,
      reason: 'unknown-artifact',
    });
    expect(await store.publishVersion(input({ artifactId: 'f'.repeat(32) }))).toEqual({ ok: false, reason: 'unknown-artifact' });
    expect(await store.publishVersion(input({ artifactId: mine.artifactId, sourcePath: 'b.html' }))).toEqual({
      ok: false,
      reason: 'path-taken',
    });
    // Nothing moved.
    expect((await store.getHead(mine.artifactId))!.currentVersion).toBe(1);
    expect((await store.getHead(theirs.artifactId))!.currentVersion).toBe(1);
  });

  it('publish with an artifactId moves the artifact to a new path and adds a version', async () => {
    const { store } = await freshStore();
    const a = await ok(store, { sourcePath: 'a.html' });
    const moved = await ok(store, { artifactId: a.artifactId, sourcePath: 'renamed/a.html', sha256: SHA(9) });
    expect(moved).toMatchObject({ artifactId: a.artifactId, version: 2, created: false });
    expect((await store.getHead(a.artifactId))!.sourcePath).toBe('renamed/a.html');
    // The old path is free again.
    expect((await ok(store, { sourcePath: 'a.html' })).created).toBe(true);
  });

  it('keeps the latest 20: after 21 publishes the versions are 2..21 and current is 21', async () => {
    const { store } = await freshStore();
    expect(MAX_RETAINED_VERSIONS).toBe(20);
    let id = '';
    for (let n = 1; n <= 21; n++) id = (await ok(store, { sha256: SHA(n) })).artifactId;
    const versions = (await store.listVersions(id)).map((v) => v.version);
    expect(versions).toEqual(Array.from({ length: 20 }, (_, i) => 21 - i));
    expect((await store.getHead(id))!.currentVersion).toBe(21);
  });

  it('versionsToPrune never returns the current version', () =>
    expect(versionsToPrune([...Array(25)].map((_, i) => i + 1), 3, 20)).toEqual([1, 2, 4, 5]));

  it('versionsToPrune keeps everything at or under the cap', () => {
    expect(versionsToPrune([1, 2, 3], 3, 20)).toEqual([]);
    expect(versionsToPrune([5, 1, 3, 2, 4], 5, 3)).toEqual([1, 2]);
  });

  it("a re-publish keeps a title the user set (C5) and takes the agent's title otherwise", async () => {
    const { store } = await freshStore();
    const a = await ok(store, { title: 'Draft' });
    expect((await ok(store, { title: 'Deal tracker v2' })).title).toBe('Deal tracker v2');
    await store.rename(a.artifactId, 'My tracker');
    const after = await ok(store, { title: 'Agent wants this' });
    expect(after.title).toBe('My tracker');
    expect((await store.getHead(a.artifactId))!.title).toBe('My tracker');
  });
});

describe('ArtifactStore reads and edits', () => {
  it('listForAgent returns only that agent, newest first, ties by id, up to the limit', async () => {
    const { db, store } = await freshStore();
    const a = await ok(store, { sourcePath: 'a.html' });
    const b = await ok(store, { sourcePath: 'b.html' });
    const c = await ok(store, { sourcePath: 'c.html' });
    await ok(store, { agentId: 'agt-2', sourcePath: 'x.html' });
    const t = new Date('2026-11-01T00:00:00Z');
    await db.updateTable('attachments_v1_artifacts').set({ updated_at: t }).where('artifact_id', 'in', [a.artifactId, b.artifactId]).execute();
    await db.updateTable('attachments_v1_artifacts').set({ updated_at: new Date('2026-11-02T00:00:00Z') }).where('artifact_id', '=', c.artifactId).execute();

    const list = await store.listForAgent('agt-1', 10);
    expect(list.map((r) => r.artifactId)).toEqual([c.artifactId, ...[a.artifactId, b.artifactId].sort()]);
    expect(list[0]!.current.version).toBe(1);
    expect((await store.listForAgent('agt-1', 2)).length).toBe(2);
    expect(await store.listForAgent('agt-none', 10)).toEqual([]);
  });

  it('rename sets the title and marks it the user\'s; an unknown id is null', async () => {
    const { store } = await freshStore();
    const a = await ok(store);
    const before = (await store.getHead(a.artifactId))!;
    const renamed = await store.rename(a.artifactId, 'Renamed');
    expect(renamed).toMatchObject({ title: 'Renamed', titleSetByUser: true });
    // P17: a rename does not reorder the list.
    expect(renamed!.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await store.rename('f'.repeat(32), 'x')).toBeNull();
  });

  it('restore moves the pointer and copies nothing; restoring a pruned version returns null', async () => {
    const { store } = await freshStore();
    let id = '';
    for (let n = 1; n <= 21; n++) id = (await ok(store, { sha256: SHA(n) })).artifactId;
    const before = (await store.getHead(id))!;

    const restored = await store.restore(id, 5);
    expect(restored).toMatchObject({ currentVersion: 5 });
    expect(restored!.current).toMatchObject({ version: 5, sha256: SHA(5) });
    expect(restored!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    // No new version row.
    expect((await store.listVersions(id)).length).toBe(20);

    expect(await store.restore(id, 1)).toBeNull();
    expect(await store.restore('f'.repeat(32), 2)).toBeNull();
    expect((await store.getHead(id))!.currentVersion).toBe(5);

    // The next publish is MAX+1, not current+1.
    expect((await ok(store, { sha256: SHA(99) })).version).toBe(22);
  });

  it('setShareCode: ensure keeps an existing code, rotate replaces it, off clears it; findByShareCode matches only the current code', async () => {
    const { store } = await freshStore();
    const a = await ok(store);
    let n = 0;
    const fresh = () => `code-${++n}`.padEnd(32, 'x');

    const first = await store.setShareCode(a.artifactId, 'ensure', fresh);
    expect(first).toBe('code-1'.padEnd(32, 'x'));
    expect(await store.setShareCode(a.artifactId, 'ensure', fresh)).toBe(first);
    expect((await store.findByShareCode(first!))?.artifactId).toBe(a.artifactId);

    const rotated = await store.setShareCode(a.artifactId, 'rotate', fresh);
    expect(rotated).not.toBe(first);
    expect(await store.findByShareCode(first!)).toBeNull();
    expect((await store.findByShareCode(rotated!))?.shareCode).toBe(rotated);

    expect(await store.setShareCode(a.artifactId, 'off', fresh)).toBeNull();
    expect(await store.findByShareCode(rotated!)).toBeNull();
    expect((await store.getHead(a.artifactId))!.shareCode).toBeNull();
    expect(await store.setShareCode('f'.repeat(32), 'ensure', fresh)).toBeNull();
  });

  it('deleteArtifact removes the head and its versions', async () => {
    const { db, store } = await freshStore();
    const a = await ok(store);
    await ok(store, { sha256: SHA(2) });
    expect(await store.deleteArtifact(a.artifactId)).toBe(true);
    expect(await store.deleteArtifact(a.artifactId)).toBe(false);
    expect(await store.getHead(a.artifactId)).toBeNull();
    expect(await db.selectFrom('attachments_v1_artifact_versions').selectAll().execute()).toEqual([]);
  });

  it("deleteForAgent removes that agent's heads and versions and nothing of another agent", async () => {
    const { store } = await freshStore();
    await ok(store, { sourcePath: 'a.html' });
    await ok(store, { sourcePath: 'a.html', sha256: SHA(2) });
    await ok(store, { sourcePath: 'b.html' });
    const other = await ok(store, { agentId: 'agt-2' });

    expect(await store.deleteForAgent('agt-1')).toEqual({ artifacts: 2, versions: 3 });
    expect(await store.listForAgent('agt-1', 10)).toEqual([]);
    expect((await store.getHead(other.artifactId))?.currentVersion).toBe(1);
    expect(await store.deleteForAgent('agt-1')).toEqual({ artifacts: 0, versions: 0 });
  });

  it('clearConversations nulls conversation_id and deletes nothing', async () => {
    const { store } = await freshStore();
    const a = await ok(store, { conversationId: 'c-1' });
    await ok(store, { conversationId: 'c-2', sha256: SHA(2) });
    const b = await ok(store, { sourcePath: 'b.html', conversationId: 'c-1' });

    expect(await store.clearConversations(['c-1'])).toBe(2);
    expect(await store.clearConversations([])).toBe(0);
    expect((await store.listVersions(a.artifactId)).map((v) => [v.version, v.conversationId])).toEqual([
      [2, 'c-2'],
      [1, null],
    ]);
    expect((await store.getHead(b.artifactId))!.current.conversationId).toBeNull();
  });

  it("blobRefs answers each version's quota owner, team keys included", async () => {
    const { store } = await freshStore();
    await ok(store, { sha256: SHA(1), quotaOwner: 'u-1' });
    await ok(store, { sha256: SHA(2), quotaOwner: 'u-1' });
    await ok(store, { agentId: 'agt-team', sha256: SHA(1), publishedBy: 'u-2', quotaOwner: 'team:t1' });

    const refs = await store.blobRefs([SHA(1), SHA(3)]);
    expect(refs).toHaveLength(2);
    expect(refs).toContainEqual({ sha256: SHA(1), userIds: ['u-1'] });
    expect(refs).toContainEqual({ sha256: SHA(1), userIds: ['team:t1'] });
    expect(await store.blobRefs([])).toEqual([]);
  });
});
