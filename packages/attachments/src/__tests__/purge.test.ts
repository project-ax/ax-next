import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Logger } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAttachmentsPlugin } from '../plugin.js';
import { runAttachmentsMigration, type AttachmentsDatabase } from '../migrations.js';
import { createAttachmentsStore, type AttachmentsStore } from '../store.js';

// ---------------------------------------------------------------------------
// TASK-718: `conversations:purged` -> delete the purged conversations'
// `attachments_v1_files` / `attachments_v1_artifacts` rows.
//
// Two layers, one Postgres container:
//   - AttachmentsStore.purgeForConversations, against a bare Kysely handle;
//   - the plugin's subscriber, through a real bus + @ax/database-postgres.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AttachmentsDatabase>[] = [];
const harnesses: TestHarness[] = [];

function makeKysely(): Kysely<AttachmentsDatabase> {
  const k = new Kysely<AttachmentsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  opened.push(k);
  return k;
}

async function freshDbAndStore(): Promise<{
  db: Kysely<AttachmentsDatabase>;
  store: AttachmentsStore;
}> {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  return { db, store: createAttachmentsStore(db) };
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
  while (opened.length > 0) {
    const k = opened.pop()!;
    await k.destroy().catch(() => {});
  }
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_temps');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_files');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_artifacts');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const SHARED_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

/**
 * Seed the scenario every test in this file starts from:
 *   C1, C2 -> deleted;  C3 -> kept.
 * C1 and C3 reference the SAME sha256 (content-addressed blobs are shared), so a
 * purge that cleaned up "by sha" would break C3.
 */
async function seed(store: AttachmentsStore): Promise<void> {
  const row = (
    id: string,
    conversationId: string,
    path: string,
    sha256: string,
  ) => ({
    id,
    conversationId,
    userId: 'u-1',
    sha256,
    path,
    displayName: path,
    mediaType: 'text/plain',
    sizeBytes: 1,
  });
  await store.upsertFile(row('f-c1', 'C1', 'uploads/a.txt', SHARED_SHA));
  await store.upsertFile(row('f-c1b', 'C1', 'uploads/b.txt', OTHER_SHA));
  await store.upsertFile(row('f-c2', 'C2', 'uploads/a.txt', OTHER_SHA));
  await store.upsertFile(row('f-c3', 'C3', 'uploads/a.txt', SHARED_SHA));
  await store.upsertArtifact(row('a-c1', 'C1', 'artifacts/r.pdf', SHARED_SHA));
  await store.upsertArtifact(row('a-c2', 'C2', 'artifacts/r.pdf', OTHER_SHA));
  await store.upsertArtifact(row('a-c3', 'C3', 'artifacts/r.pdf', SHARED_SHA));
  // Pre-commit uploads carry no conversation id at all; they belong to the TTL
  // janitor, never to a conversation purge.
  await store.insertTemp({
    attachmentId: 't-1',
    userId: 'u-1',
    bytes: Buffer.from('pending'),
    displayName: 'pending.txt',
    mediaType: 'text/plain',
    sizeBytes: 7,
    expiresAt: new Date(Date.now() + 600_000),
  });
}

async function fileIds(db: Kysely<AttachmentsDatabase>): Promise<string[]> {
  const rows = await db
    .selectFrom('attachments_v1_files')
    .select('attachment_id')
    .orderBy('attachment_id')
    .execute();
  return rows.map((r) => r.attachment_id);
}

async function artifactIds(db: Kysely<AttachmentsDatabase>): Promise<string[]> {
  const rows = await db
    .selectFrom('attachments_v1_artifacts')
    .select('artifact_id')
    .orderBy('artifact_id')
    .execute();
  return rows.map((r) => r.artifact_id);
}

async function tempIds(db: Kysely<AttachmentsDatabase>): Promise<string[]> {
  const rows = await db
    .selectFrom('attachments_v1_temps')
    .select('attachment_id')
    .orderBy('attachment_id')
    .execute();
  return rows.map((r) => r.attachment_id);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('AttachmentsStore.purgeForConversations', () => {
  it('deletes exactly the named conversations files + artifacts, keeps the rest, and counts them', async () => {
    const { db, store } = await freshDbAndStore();
    await seed(store);

    const out = await store.purgeForConversations(['C1', 'C2']);

    expect(out).toEqual({ files: 3, artifacts: 2 });
    // C3 survives, including the row that shares C1's sha256.
    expect(await fileIds(db)).toEqual(['f-c3']);
    expect(await artifactIds(db)).toEqual(['a-c3']);
  });

  it('never touches attachments_v1_temps', async () => {
    const { db, store } = await freshDbAndStore();
    await seed(store);

    await store.purgeForConversations(['C1', 'C2', 'C3']);

    expect(await fileIds(db)).toEqual([]);
    expect(await artifactIds(db)).toEqual([]);
    expect(await tempIds(db)).toEqual(['t-1']);
  });

  it('an empty list is a no-op that returns zeros', async () => {
    const { db, store } = await freshDbAndStore();
    await seed(store);

    const out = await store.purgeForConversations([]);

    expect(out).toEqual({ files: 0, artifacts: 0 });
    expect(await fileIds(db)).toHaveLength(4);
    expect(await artifactIds(db)).toHaveLength(3);
  });

  it('ids that own no rows delete nothing (and a repeat purge is a no-op)', async () => {
    const { db, store } = await freshDbAndStore();
    await seed(store);

    expect(await store.purgeForConversations(['nope'])).toEqual({ files: 0, artifacts: 0 });
    expect(await store.purgeForConversations(['C1'])).toEqual({ files: 2, artifacts: 1 });
    expect(await store.purgeForConversations(['C1'])).toEqual({ files: 0, artifacts: 0 });
    expect(await fileIds(db)).toEqual(['f-c2', 'f-c3']);
  });

  it('binds ids as parameters: SQL metacharacters in an id are just an id', async () => {
    const { db, store } = await freshDbAndStore();
    await seed(store);
    const hostile = `C1' OR '1'='1`;

    const out = await store.purgeForConversations([hostile, `x'); DROP TABLE attachments_v1_files; --`]);

    expect(out).toEqual({ files: 0, artifacts: 0 });
    expect(await fileIds(db)).toHaveLength(4);
    expect(await artifactIds(db)).toHaveLength(3);
  });

  it('accepts a list far past the Postgres bind-parameter limit', async () => {
    const { db, store } = await freshDbAndStore();
    await seed(store);
    // 70k > 65535 bind parameters: an unchunked `IN ($1..$70000)` cannot run.
    const many = Array.from({ length: 70_000 }, (_, i) => `filler-${i}`);
    many[0] = 'C1';
    many[69_999] = 'C2';

    const out = await store.purgeForConversations(many);

    expect(out).toEqual({ files: 3, artifacts: 2 });
    expect(await fileIds(db)).toEqual(['f-c3']);
  });

  it('is one transaction: if the artifacts delete fails, the files delete rolls back', async () => {
    const { db, store } = await freshDbAndStore();
    await seed(store);
    await sql`DROP TABLE attachments_v1_artifacts`.execute(db);

    await expect(store.purgeForConversations(['C1', 'C2'])).rejects.toThrow();

    expect(await fileIds(db)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Plugin subscriber
// ---------------------------------------------------------------------------

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function captureLogger(lines: LogLine[]): Logger {
  const at =
    (level: LogLine['level']) =>
    (msg: string, bindings?: Record<string, unknown>): void => {
      lines.push({ level, msg, bindings });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return logger;
}

interface PluginRig {
  harness: TestHarness;
  db: Kysely<AttachmentsDatabase>;
  store: AttachmentsStore;
  lines: LogLine[];
  blobDeleteCalls: unknown[];
  /** Fire `conversations:purged` as @ax/conversations would. */
  purged(payload: unknown): Promise<void>;
}

async function makePluginRig(): Promise<PluginRig> {
  const blobDeleteCalls: unknown[] = [];
  const harness = await createTestHarness({
    services: {
      'blob:put': async () => ({ sha256: 'a'.repeat(64), size: 0 }),
      'blob:get': async () => ({ found: false }) as const,
      // A spy, not a behavior: attachments must never reach for blob deletion
      // from this subscriber (blobs are content-addressed and shared).
      'blob:delete': async (_ctx: unknown, input: unknown) => {
        blobDeleteCalls.push(input);
        return { deleted: true };
      },
      'conversations:get': async () => ({
        conversation: { conversationId: 'mock-conv', userId: 'test-user', agentId: 'test-agent' },
        turns: [],
      }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createAttachmentsPlugin(),
    ],
  });
  harnesses.push(harness);
  const { db } = await harness.bus.call<unknown, { db: Kysely<AttachmentsDatabase> }>(
    'database:get-instance',
    harness.ctx(),
    {},
  );
  const lines: LogLine[] = [];
  return {
    harness,
    db,
    store: createAttachmentsStore(db),
    lines,
    blobDeleteCalls,
    async purged(payload) {
      await harness.bus.fire(
        'conversations:purged',
        harness.ctx({ logger: captureLogger(lines) }),
        payload,
      );
    },
  };
}

describe('@ax/attachments subscribes to conversations:purged', () => {
  it('lists the subscription in the manifest', () => {
    expect(createAttachmentsPlugin().manifest.subscribes).toEqual(['conversations:purged']);
  });

  it('deletes the purged conversations rows, keeps the others (shared sha256 too), leaves temps alone', async () => {
    const rig = await makePluginRig();
    await seed(rig.store);

    await rig.purged({ conversationIds: ['C1', 'C2'] });

    expect(await fileIds(rig.db)).toEqual(['f-c3']);
    expect(await artifactIds(rig.db)).toEqual(['a-c3']);
    expect(await tempIds(rig.db)).toEqual(['t-1']);
    // The surviving C3 file still resolves through the public store surface.
    const kept = await rig.store.getFileByPath('C3', 'uploads/a.txt');
    expect(kept?.sha256).toBe(SHARED_SHA);
    const info = rig.lines.find((l) => l.level === 'info');
    expect(info?.bindings).toMatchObject({ conversations: 2, files: 3, artifacts: 2 });
  });

  it('never calls blob:delete (blobs are shared by sha256; bytes stay in place)', async () => {
    const rig = await makePluginRig();
    await seed(rig.store);

    await rig.purged({ conversationIds: ['C1', 'C2'] });

    // The purge really ran (a spy that saw nothing because nothing happened
    // proves nothing) ...
    expect(await fileIds(rig.db)).toEqual(['f-c3']);
    // ... and it left the bytes alone, including the blob C3 still points at.
    expect(rig.blobDeleteCalls).toEqual([]);
  });

  it('a re-fired purge is a no-op', async () => {
    const rig = await makePluginRig();
    await seed(rig.store);

    await rig.purged({ conversationIds: ['C1', 'C2'] });
    await rig.purged({ conversationIds: ['C1', 'C2'] });

    expect(await fileIds(rig.db)).toEqual(['f-c3']);
    expect(await artifactIds(rig.db)).toEqual(['a-c3']);
    expect(rig.lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  // Passes without the subscriber too; it is here to redden a subscriber that
  // forwards `[]` to a bare `IN ()` (a Postgres syntax error -> error log).
  it('an empty conversationIds list deletes nothing and logs no error', async () => {
    const rig = await makePluginRig();
    await seed(rig.store);

    await rig.purged({ conversationIds: [] });

    expect(await fileIds(rig.db)).toHaveLength(4);
    expect(await artifactIds(rig.db)).toHaveLength(3);
    expect(rig.lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('accepts exactly 1000 ids', async () => {
    const rig = await makePluginRig();
    await seed(rig.store);
    const ids = Array.from({ length: 1000 }, (_, i) => `filler-${i}`);
    ids[0] = 'C1';

    await rig.purged({ conversationIds: ids });

    expect(await fileIds(rig.db)).toEqual(['f-c2', 'f-c3']);
  });

  // Untrusted-shape input: every one of these must delete NOTHING, even when a
  // valid purge target ('C1') rides along, and must warn instead of throwing.
  const malformed: Array<[string, unknown]> = [
    ['a null payload', null],
    ['an undefined payload', undefined],
    ['a string payload', 'C1'],
    ['a payload without conversationIds', {}],
    ['a non-array conversationIds', { conversationIds: 'C1' }],
    ['an object conversationIds', { conversationIds: { 0: 'C1' } }],
    ['a non-string entry beside a real id', { conversationIds: ['C1', 42] }],
    ['a null entry beside a real id', { conversationIds: ['C1', null] }],
    ['an empty-string entry beside a real id', { conversationIds: ['C1', ''] }],
    [
      'more than 1000 ids',
      { conversationIds: ['C1', ...Array.from({ length: 1000 }, (_, i) => `filler-${i}`)] },
    ],
  ];
  it.each(malformed)('ignores %s: deletes nothing and warns', async (_name, payload) => {
    const rig = await makePluginRig();
    await seed(rig.store);

    await rig.purged(payload);

    expect(await fileIds(rig.db)).toHaveLength(4);
    expect(await artifactIds(rig.db)).toHaveLength(3);
    expect(rig.lines.some((l) => l.level === 'warn')).toBe(true);
    expect(rig.lines.filter((l) => l.level === 'error')).toEqual([]);
    expect(rig.blobDeleteCalls).toEqual([]);
  });

  it('a failing store logs an error, rolls back, and does not throw (not even into the bus)', async () => {
    const rig = await makePluginRig();
    await seed(rig.store);
    await sql`DROP TABLE attachments_v1_artifacts`.execute(rig.db);

    await expect(rig.purged({ conversationIds: ['C1', 'C2'] })).resolves.toBeUndefined();

    const errors = rig.lines.filter((l) => l.level === 'error');
    // The subscriber's OWN log line, not the bus's `hook_subscriber_failed`
    // backstop: swallowing is this plugin's job, the bus is the last resort.
    expect(errors.map((l) => l.msg)).toEqual(['attachments_purge_for_purged_conversations_failed']);
    expect(errors[0]?.bindings).toMatchObject({ count: 2 });
    expect(errors[0]?.bindings?.err).toBeInstanceOf(Error);
    // Nothing half-deleted.
    expect(await fileIds(rig.db)).toHaveLength(4);
  });
});
