import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { runAttachmentsMigration, type AttachmentsDatabase } from '../migrations.js';
import { createAttachmentsStore } from '../store.js';
import {
  createListForConversationHandler,
  createPublishArtifactBlobHandler,
} from '../handlers.js';

// ---------------------------------------------------------------------------
// TASK-68: attachments:list-for-conversation + artifacts:publish-blob against a
// real Postgres metadata store.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AttachmentsDatabase>[] = [];

function makeKysely(): Kysely<AttachmentsDatabase> {
  const k = new Kysely<AttachmentsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  opened.push(k);
  return k;
}

function makeCtx(userId: string) {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId });
}

async function freshSetup() {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  return { db, store: createAttachmentsStore(db) };
}

async function artifactRowCount(db: Kysely<AttachmentsDatabase>): Promise<number> {
  const rows = await db.selectFrom('attachments_v1_artifacts').select('artifact_id').execute();
  return rows.length;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('attachments_v1_files').ifExists().execute();
      await k.schema.dropTable('attachments_v1_artifacts').ifExists().execute();
    } catch {
      /* drained */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

/** Who owns which conversation, as conversations:get would answer. */
const OWNERS: Record<string, string> = { 'c-1': 'u-1', 'c-2': 'u-1', 'c-other': 'u-2' };

// D10: `artifacts:publish-blob` asks the blob store whether the sha is there
// before it writes a row. `stored` is the set of shas this fake store holds.
// It also asks conversations:get whether the caller owns the conversation.
function makeBlobStatBus(stored: string[] = [SHA, SHA2]): { bus: HookBus; stats: string[] } {
  const bus = new HookBus();
  const stats: string[] = [];
  bus.registerService<{ sha256: string }, { size: number } | { found: false }>(
    'blob:stat',
    'test-blob',
    async (_ctx, { sha256 }) => {
      stats.push(sha256);
      return stored.includes(sha256) ? { size: 1 } : { found: false };
    },
  );
  bus.registerService<{ conversationId: string; userId: string }, unknown>(
    'conversations:get',
    'test-conversations',
    async (_ctx, { conversationId, userId }) => {
      if (OWNERS[conversationId] !== userId) {
        throw new PluginError({ code: 'not-found', plugin: 'test-conversations', message: 'conversation not found' });
      }
      return { conversation: { conversationId, userId, agentId: 'a' }, turns: [] };
    },
  );
  return { bus, stats };
}

describe('artifacts:publish-blob handler', () => {
  it('inserts an artifact row scoped to ctx.userId and returns an opaque id', async () => {
    const { store } = await freshSetup();
    const handler = createPublishArtifactBlobHandler({ store, bus: makeBlobStatBus().bus });
    const out = await handler(makeCtx('u-1'), {
      conversationId: 'c-1',
      sha256: SHA,
      path: 'workspace/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      size: 2048,
    });
    expect(out.artifactId).toMatch(/^[a-f0-9]{32}$/);
    expect(await store.getArtifactById(out.artifactId)).toStrictEqual({
      id: out.artifactId,
      conversationId: 'c-1',
      userId: 'u-1',
      sha256: SHA,
      path: 'workspace/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 2048,
    });
  });

  it('publishes identical bytes under multiple paths and conversations', async () => {
    const { store } = await freshSetup();
    const handler = createPublishArtifactBlobHandler({ store, bus: makeBlobStatBus().bus });
    const ids: string[] = [];
    for (const [conversationId, path] of [['c-1', 'a.txt'], ['c-1', 'b.txt'], ['c-2', 'a.txt']]) {
      const result = await handler(makeCtx('u-1'), {
        conversationId: conversationId!, path: path!, sha256: SHA,
        displayName: 'file.txt', mediaType: 'text/plain', size: 1,
      });
      ids.push(result.artifactId);
      const row = await store.getArtifactById(result.artifactId);
      expect(row?.conversationId).toBe(conversationId);
      expect(row?.path).toBe(path);
      expect(row?.sha256).toBe(SHA);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it('is idempotent on (conversationId, path) — re-publish upserts', async () => {
    const { db, store } = await freshSetup();
    const handler = createPublishArtifactBlobHandler({ store, bus: makeBlobStatBus().bus });
    const base = {
      conversationId: 'c-1',
      path: 'workspace/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      size: 1,
    };
    const first = await handler(makeCtx('u-1'), { ...base, sha256: SHA });
    const second = await handler(makeCtx('u-1'), { ...base, sha256: SHA2 });
    expect(second.artifactId).toBe(first.artifactId);
    expect((await store.getArtifactById(first.artifactId))?.sha256).toBe(SHA2); // refreshed, not duplicated
    expect(await artifactRowCount(db)).toBe(1);
  });

  // TASK-776 / design D10. The bug this closes: a runner could publish a row
  // pointing at a sha the blob store no longer (or never) held, and the person
  // got a download link that 404s. The row must not be written at all.
  it('publish of an unknown sha writes no row', async () => {
    const { db, store } = await freshSetup();
    const { bus, stats } = makeBlobStatBus([]); // the store holds nothing
    const handler = createPublishArtifactBlobHandler({ store, bus });
    const input = {
      conversationId: 'c-1',
      sha256: SHA,
      path: 'workspace/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      size: 2048,
    };
    const err = await handler(makeCtx('u-1'), input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('not-found');
    expect((err as PluginError).plugin).toBe('@ax/attachments');
    expect((err as PluginError).hookName).toBe('artifacts:publish-blob');
    expect(stats).toEqual([SHA]);
    expect(await artifactRowCount(db)).toBe(0);
  });

  it('a blob:stat failure propagates and writes no row (never "assume it is there")', async () => {
    const { db, store } = await freshSetup();
    const bus = new HookBus();
    bus.registerService('blob:stat', 'test-blob', async () => {
      throw new Error('blob store unreachable');
    });
    const handler = createPublishArtifactBlobHandler({ store, bus });
    await expect(
      handler(makeCtx('u-1'), {
        conversationId: 'c-1',
        sha256: SHA,
        path: 'workspace/report.pdf',
        displayName: 'report.pdf',
        mediaType: 'application/pdf',
        size: 1,
      }),
    ).rejects.toThrow(/blob store unreachable/);
    expect(await artifactRowCount(db)).toBe(0);
  });

  it('a re-publish of an unknown sha leaves the earlier row untouched', async () => {
    const { store } = await freshSetup();
    const base = {
      conversationId: 'c-1',
      path: 'workspace/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      size: 1,
    };
    const first = await createPublishArtifactBlobHandler({ store, bus: makeBlobStatBus().bus })(
      makeCtx('u-1'),
      { ...base, sha256: SHA },
    );
    const gone = createPublishArtifactBlobHandler({ store, bus: makeBlobStatBus([]).bus });
    await expect(gone(makeCtx('u-1'), { ...base, sha256: SHA2 })).rejects.toThrow(PluginError);
    expect((await store.getArtifactById(first.artifactId))?.sha256).toBe(SHA);
  });

  // Downloads resolve by id + the row's conversation, so where a row lands
  // decides who can read it. Only the conversation's owner may record one.
  it('refuses to publish into a conversation the caller does not own, and writes no row', async () => {
    const { db, store } = await freshSetup();
    const handler = createPublishArtifactBlobHandler({ store, bus: makeBlobStatBus().bus });
    await expect(
      handler(makeCtx('u-1'), {
        conversationId: 'c-other',
        sha256: SHA,
        path: 'out/planted.html',
        displayName: 'invoice.html',
        mediaType: 'text/html',
        size: 1,
      }),
    ).rejects.toMatchObject({ code: 'forbidden', hookName: 'artifacts:publish-blob' });
    expect(await artifactRowCount(db)).toBe(0);
  });

  it("another user's publish of the same key leaves the owner's row unchanged", async () => {
    const { store } = await freshSetup();
    const handler = createPublishArtifactBlobHandler({ store, bus: makeBlobStatBus().bus });
    const key = { conversationId: 'c-other', path: 'out/report.pdf', displayName: 'report.pdf', mediaType: 'application/pdf', size: 1 };
    const owners = await handler(makeCtx('u-2'), { ...key, sha256: SHA });

    await expect(handler(makeCtx('u-1'), { ...key, sha256: SHA2 })).rejects.toBeInstanceOf(PluginError);

    const row = await store.getArtifactById(owners.artifactId);
    expect(row).toMatchObject({ userId: 'u-2', conversationId: 'c-other', sha256: SHA });
  });
});

describe('AttachmentsStore.upsertArtifact', () => {
  const row = (userId: string, sha256: string) => ({
    id: 'art-1',
    conversationId: 'c-1',
    userId,
    sha256,
    path: 'out/report.pdf',
    displayName: 'report.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 1,
  });

  it('a re-publish by the same user updates the row', async () => {
    const { store } = await freshSetup();
    expect(await store.upsertArtifact(row('u-1', SHA))).toBe(true);
    expect(await store.upsertArtifact(row('u-1', SHA2))).toBe(true);
    expect((await store.getArtifactById('art-1'))?.sha256).toBe(SHA2);
  });

  // The (conversation, path) key is shared by everyone who can name it; the
  // row is not. A different user's write must never take an existing row over.
  it('never lets a different user take over an existing row', async () => {
    const { store } = await freshSetup();
    await store.upsertArtifact(row('u-1', SHA));
    expect(await store.upsertArtifact(row('u-2', SHA2))).toBe(false);
    expect(await store.getArtifactById('art-1')).toMatchObject({ userId: 'u-1', sha256: SHA, conversationId: 'c-1' });
  });
});

describe('attachments:list-for-conversation handler', () => {
  // The runner names its copies in list order (a later duplicate becomes
  // `name (2)`), so a fresh runner must get the SAME order every time: oldest
  // first, ties broken by id.
  it('list-for-conversation returns oldest first with id and filename', async () => {
    const { db, store } = await freshSetup();
    const t0 = new Date('2026-10-31T10:00:00.000Z');
    const t1 = new Date('2026-10-31T10:05:00.000Z');
    const row = (id: string, conversationId: string, userId: string, createdAt: Date) => ({
      attachment_id: id,
      conversation_id: conversationId,
      user_id: userId,
      sha256: SHA,
      display_name: `${id}.pdf`,
      media_type: 'application/pdf',
      size_bytes: 10,
      created_at: createdAt,
    });
    await db
      .insertInto('attachments_v1_files')
      .values([
        row('late', 'c-1', 'u-1', t1),
        row('tie-b', 'c-1', 'u-1', t0),
        row('tie-a', 'c-1', 'u-1', t0),
        row('elsewhere', 'c-2', 'u-1', t0),
        row('not-mine', 'c-1', 'u-2', t0),
      ])
      .execute();

    const out = await createListForConversationHandler({ store })(makeCtx('u-1'), { conversationId: 'c-1' });

    expect(out.files).toStrictEqual([
      { attachmentId: 'tie-a', filename: 'tie-a.pdf', sha256: SHA, mediaType: 'application/pdf', sizeBytes: 10 },
      { attachmentId: 'tie-b', filename: 'tie-b.pdf', sha256: SHA, mediaType: 'application/pdf', sizeBytes: 10 },
      { attachmentId: 'late', filename: 'late.pdf', sha256: SHA, mediaType: 'application/pdf', sizeBytes: 10 },
    ]);
  });

  it('returns the empty set for a foreign user (no existence leak)', async () => {
    const { store } = await freshSetup();
    await store.insertFile({
      id: 'a-1', conversationId: 'c-1', userId: 'u-owner', sha256: SHA,
      displayName: 'a.png', mediaType: 'image/png', sizeBytes: 99,
    });
    const handler = createListForConversationHandler({ store });
    const out = await handler(makeCtx('u-attacker'), { conversationId: 'c-1' });
    expect(out.files).toEqual([]);
  });
});
