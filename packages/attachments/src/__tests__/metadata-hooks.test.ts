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
  return { store: createAttachmentsStore(db) };
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

// D10: `artifacts:publish-blob` asks the blob store whether the sha is there
// before it writes a row. `stored` is the set of shas this fake store holds.
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
    const row = await store.getArtifactByPath('c-1', 'workspace/report.pdf');
    expect(row).not.toBeNull();
    expect(row!.sha256).toBe(SHA);
    expect(row!.userId).toBe('u-1');
    expect(row!.mediaType).toBe('application/pdf');
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
      expect((await store.getArtifactByPath(conversationId!, path!))?.sha256).toBe(SHA);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it('is idempotent on (conversationId, path) — re-publish upserts', async () => {
    const { store } = await freshSetup();
    const handler = createPublishArtifactBlobHandler({ store, bus: makeBlobStatBus().bus });
    const base = {
      conversationId: 'c-1',
      path: 'workspace/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      size: 1,
    };
    await handler(makeCtx('u-1'), { ...base, sha256: SHA });
    await handler(makeCtx('u-1'), { ...base, sha256: SHA2 });
    const row = await store.getArtifactByPath('c-1', 'workspace/report.pdf');
    expect(row!.sha256).toBe(SHA2); // refreshed, not duplicated
  });

  // TASK-776 / design D10. The bug this closes: a runner could publish a row
  // pointing at a sha the blob store no longer (or never) held, and the person
  // got a download link that 404s. The row must not be written at all.
  it('publish of an unknown sha writes no row', async () => {
    const { store } = await freshSetup();
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
    expect(await store.getArtifactByPath('c-1', 'workspace/report.pdf')).toBeNull();
  });

  it('a blob:stat failure propagates and writes no row (never "assume it is there")', async () => {
    const { store } = await freshSetup();
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
    expect(await store.getArtifactByPath('c-1', 'workspace/report.pdf')).toBeNull();
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
    await createPublishArtifactBlobHandler({ store, bus: makeBlobStatBus().bus })(
      makeCtx('u-1'),
      { ...base, sha256: SHA },
    );
    const gone = createPublishArtifactBlobHandler({ store, bus: makeBlobStatBus([]).bus });
    await expect(gone(makeCtx('u-1'), { ...base, sha256: SHA2 })).rejects.toThrow(PluginError);
    expect((await store.getArtifactByPath('c-1', 'workspace/report.pdf'))?.sha256).toBe(SHA);
  });
});

describe('attachments:list-for-conversation handler', () => {
  it('returns the conversation uploads scoped to ctx.userId', async () => {
    const { store } = await freshSetup();
    await store.upsertFile({
      id: 'a-1', conversationId: 'c-1', userId: 'u-1', sha256: SHA,
      path: '.ax/uploads/c-1/t-1/a.png', displayName: 'a.png',
      mediaType: 'image/png', sizeBytes: 99,
    });
    const handler = createListForConversationHandler({ store });
    const out = await handler(makeCtx('u-1'), { conversationId: 'c-1' });
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toEqual({
      path: '.ax/uploads/c-1/t-1/a.png',
      sha256: SHA,
      mediaType: 'image/png',
      displayName: 'a.png',
      sizeBytes: 99,
    });
  });

  it('returns the empty set for a foreign user (no existence leak)', async () => {
    const { store } = await freshSetup();
    await store.upsertFile({
      id: 'a-1', conversationId: 'c-1', userId: 'u-owner', sha256: SHA,
      path: '.ax/uploads/c-1/t-1/a.png', displayName: 'a.png',
      mediaType: 'image/png', sizeBytes: 99,
    });
    const handler = createListForConversationHandler({ store });
    const out = await handler(makeCtx('u-attacker'), { conversationId: 'c-1' });
    expect(out.files).toEqual([]);
  });
});
