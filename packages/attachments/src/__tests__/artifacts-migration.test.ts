import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '@ax/conversations';
import { createAttachmentsPlugin } from '../plugin.js';
import { runAttachmentsMigration, type AttachmentsDatabase } from '../migrations.js';
import { backfillArtifactAgents, finishArtifactsMigration } from '../artifacts/migrations.js';
import { createArtifactStore } from '../artifacts/store.js';

// ---------------------------------------------------------------------------
// The single-version, conversation-scoped artifacts table upgrades IN PLACE to
// agent-scoped heads + versions. Chip ids already in transcripts must keep
// resolving, so every legacy artifact_id survives.
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

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  while (opened.length > 0) await opened.pop()!.destroy().catch(() => {});
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    for (const t of [
      'attachments_v1_artifact_versions',
      'attachments_v1_artifacts',
      'attachments_v1_files',
      'attachments_v1_temps',
      'conversations_v1_turns',
      'conversations_v1_conversations',
    ]) {
      await cleanup.query(`DROP TABLE IF EXISTS ${t}`);
    }
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const SHA = 'a'.repeat(64);

/** The artifacts table exactly as the previous release created it. */
async function createLegacyTable(db: Kysely<AttachmentsDatabase>): Promise<void> {
  await sql`
    CREATE TABLE attachments_v1_artifacts (
      artifact_id     TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      sha256          TEXT NOT NULL,
      path            TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      media_type      TEXT NOT NULL,
      size_bytes      BIGINT NOT NULL CHECK (size_bytes >= 0),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (conversation_id, path)
    )
  `.execute(db);
  await sql`CREATE INDEX attachments_v1_artifacts_conversation_id_idx ON attachments_v1_artifacts (conversation_id)`.execute(db);
  await sql`CREATE INDEX attachments_v1_artifacts_sha256_idx ON attachments_v1_artifacts (sha256)`.execute(db);
}

interface LegacyRow {
  id: string;
  conversationId: string;
  userId?: string;
  path?: string;
  displayName?: string;
  mediaType?: string;
  createdAt?: string;
}

async function insertLegacy(db: Kysely<AttachmentsDatabase>, rows: LegacyRow[]): Promise<void> {
  for (const r of rows) {
    await sql`
      INSERT INTO attachments_v1_artifacts
        (artifact_id, conversation_id, user_id, sha256, path, display_name, media_type, size_bytes, created_at)
      VALUES (${r.id}, ${r.conversationId}, ${r.userId ?? 'u-1'}, ${SHA}, ${r.path ?? 'out/report.pdf'},
              ${r.displayName ?? 'report.pdf'}, ${r.mediaType ?? 'application/pdf'}, ${42},
              ${r.createdAt ?? '2026-10-01T12:00:00Z'})
    `.execute(db);
  }
}

async function columnsOf(db: Kysely<AttachmentsDatabase>, table: string): Promise<string[]> {
  const r = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns WHERE table_name = ${table} ORDER BY column_name
  `.execute(db);
  return r.rows.map((x) => x.column_name);
}

async function indexDefs(db: Kysely<AttachmentsDatabase>, table: string): Promise<string[]> {
  const r = await sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes WHERE tablename = ${table}`.execute(db);
  return r.rows.map((x) => x.indexdef);
}

const mapAll =
  (agentId: string) =>
  async (ids: string[]): Promise<Map<string, string>> =>
    new Map(ids.map((id) => [id, agentId]));

async function migrate(
  db: Kysely<AttachmentsDatabase>,
  mapAgents: (ids: string[]) => Promise<Map<string, string>> = mapAll('agt-1'),
) {
  await runAttachmentsMigration(db);
  const counts = await backfillArtifactAgents(db, mapAgents);
  await finishArtifactsMigration(db);
  return counts;
}

const HEAD_COLUMNS = [
  'agent_id',
  'artifact_id',
  'created_at',
  'created_by_user_id',
  'current_version',
  'share_code',
  'source_path',
  'title',
  'title_set_by_user',
  'updated_at',
  'visual',
];

function attachmentsHarness(services: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>>, withConversations = false) {
  return createTestHarness({
    services: {
      'blob:put': async () => ({ sha256: SHA, size: 0 }),
      'blob:get': async () => ({ found: false }),
      'blob:stat': async () => ({ found: false }),
      'agents:resolve': async (_ctx: unknown, input: unknown) => ({
        agent: { id: (input as { agentId: string }).agentId, ownerType: 'user', ownerId: 'u-1' },
      }),
      ...(withConversations
        ? {}
        : {
            'conversations:get': async () => ({ conversation: { agentId: 'agt-1' }, turns: [] }),
          }),
      ...services,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      ...(withConversations ? [createConversationsPlugin({ purgeSweepIntervalMs: 0 })] : []),
      createAttachmentsPlugin({ janitorIntervalSeconds: 3600 }),
    ],
  });
}

describe('artifact storage migration', () => {
  it('upgrades a legacy table in place: ids kept, one version each, title from the old name, no source path, no link', async () => {
    const db = makeKysely();
    await createLegacyTable(db);
    await insertLegacy(db, [
      { id: 'legacy-1', conversationId: 'c-1', displayName: 'Q3 report.pdf', createdAt: '2026-10-01T12:00:00Z' },
      { id: 'legacy-2', conversationId: 'c-2', path: 'out/chart.png', displayName: 'chart.png', mediaType: 'image/png' },
    ]);

    expect(await migrate(db)).toEqual({ mapped: 2, dropped: 0 });

    expect(await columnsOf(db, 'attachments_v1_artifacts')).toEqual(HEAD_COLUMNS);
    const store = createArtifactStore(db);
    const head = await store.getHead('legacy-1');
    expect(head).toMatchObject({
      artifactId: 'legacy-1',
      agentId: 'agt-1',
      title: 'Q3 report.pdf',
      sourcePath: null,
      currentVersion: 1,
      shareCode: null,
      titleSetByUser: false,
      createdByUserId: 'u-1',
    });
    expect(head!.updatedAt.toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(head!.createdAt.toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(head!.current).toMatchObject({
      artifactId: 'legacy-1',
      version: 1,
      sha256: SHA,
      mediaType: 'application/pdf',
      sizeBytes: 42,
      conversationId: 'c-1',
    });
    expect(await store.listVersions('legacy-1')).toHaveLength(1);
    expect((await store.getHead('legacy-2'))!.current.mediaType).toBe('image/png');
    // The old (conversation_id, path) unique constraint and indexes are gone.
    const defs = await indexDefs(db, 'attachments_v1_artifacts');
    expect(defs.filter((d) => d.includes('conversation_id') || d.includes('sha256'))).toEqual([]);
  });

  // R27: charts show_visual stored the old way (#1135) carry its
  // content-derived name; they migrate as hidden chat visuals. Nothing else does.
  it('migrates a legacy show_visual chart (visuals/<64-hex>.html) hidden, and nothing else', async () => {
    const db = makeKysely();
    await createLegacyTable(db);
    const html = { mediaType: 'text/html', displayName: 'chart' };
    await insertLegacy(db, [
      { id: 'chart', conversationId: 'c-1', path: `visuals/${'0123456789abcdef'.repeat(4)}.html`, ...html },
      { id: 'report', conversationId: 'c-1', path: 'visuals/report.html', ...html },
      { id: 'short', conversationId: 'c-1', path: `visuals/${'a'.repeat(63)}.html`, ...html },
      { id: 'upper', conversationId: 'c-1', path: `visuals/${'A'.repeat(64)}.html`, ...html },
      { id: 'nested', conversationId: 'c-1', path: `out/visuals/${'a'.repeat(64)}.html`, ...html },
      { id: 'pdf', conversationId: 'c-1' },
    ]);
    await migrate(db);
    const store = createArtifactStore(db);
    expect((await store.getHead('chart'))!.visual).toBe(true);
    for (const id of ['report', 'short', 'upper', 'nested', 'pdf']) {
      expect((await store.getHead(id))!.visual, id).toBe(false);
    }
    expect((await store.listForAgent('agt-1', 10)).map((h) => h.artifactId).sort()).toEqual([
      'nested',
      'pdf',
      'report',
      'short',
      'upper',
    ]);
  });

  it("maps legacy rows to their conversation's agent, soft-deleted chats included", async () => {
    // Real @ax/conversations: make one live and one soft-deleted chat first.
    const first = await attachmentsHarness({}, true);
    harnesses.push(first);
    const ctx = first.ctx({ userId: 'u-1' });
    const mk = async (agentId: string) =>
      (await first.bus.call<unknown, { conversationId: string }>('conversations:create', ctx, { userId: 'u-1', agentId }))
        .conversationId;
    const live = await mk('agt-live');
    const gone = await mk('agt-soft');
    await first.bus.call('conversations:delete', ctx, { conversationId: gone, userId: 'u-1' });
    await harnesses.pop()!.close({ onError: () => {} });

    // Put the artifacts table back the way the previous release left it.
    const db = makeKysely();
    await sql`DROP TABLE attachments_v1_artifact_versions`.execute(db);
    await sql`DROP TABLE attachments_v1_artifacts`.execute(db);
    await createLegacyTable(db);
    await insertLegacy(db, [
      { id: 'on-live', conversationId: live },
      { id: 'on-soft', conversationId: gone },
    ]);

    // Booting the plugin runs the whole upgrade through conversations:agent-ids.
    const second = await attachmentsHarness({}, true);
    harnesses.push(second);
    const store = createArtifactStore(db);
    expect((await store.getHead('on-live'))?.agentId).toBe('agt-live');
    expect((await store.getHead('on-soft'))?.agentId).toBe('agt-soft');
  });

  it('drops a legacy row whose conversation no longer exists', async () => {
    const db = makeKysely();
    await createLegacyTable(db);
    await insertLegacy(db, [
      { id: 'kept', conversationId: 'c-1' },
      { id: 'orphan', conversationId: 'c-purged' },
    ]);
    const counts = await migrate(db, async (ids) => new Map(ids.filter((i) => i === 'c-1').map((i) => [i, 'agt-1'])));
    expect(counts).toEqual({ mapped: 1, dropped: 1 });
    const store = createArtifactStore(db);
    expect(await store.getHead('kept')).not.toBeNull();
    expect(await store.getHead('orphan')).toBeNull();
    expect(await db.selectFrom('attachments_v1_artifact_versions').select('artifact_id').execute()).toEqual([
      { artifact_id: 'kept' },
    ]);
  });

  it('re-derives the media type from the legacy path: an .html row stored as octet-stream becomes text/html', async () => {
    const db = makeKysely();
    await createLegacyTable(db);
    await insertLegacy(db, [
      { id: 'page', conversationId: 'c-1', path: 'out/page.html', mediaType: 'application/octet-stream' },
      // An extension the table does not know keeps the type it was stored with.
      { id: 'odd', conversationId: 'c-1', path: 'out/scan.tiff', mediaType: 'image/tiff' },
    ]);
    await migrate(db);
    const store = createArtifactStore(db);
    expect((await store.getHead('page'))!.current.mediaType).toBe('text/html');
    expect((await store.getHead('odd'))!.current.mediaType).toBe('image/tiff');
  });

  it('gives legacy titles the one spelling: controls and bidi removed, too-long names fall back to the file name', async () => {
    const db = makeKysely();
    await createLegacyTable(db);
    await insertLegacy(db, [
      { id: 'bidi', conversationId: 'c-1', displayName: 'Deal\u000d\u000atracker\u202e.pdf' },
      { id: 'long', conversationId: 'c-1', path: 'out/q3-summary.pdf', displayName: 'x'.repeat(300) },
      { id: 'blank', conversationId: 'c-1', path: 'out/\u200b', displayName: '\u200b' },
    ]);
    await migrate(db);
    const store = createArtifactStore(db);
    expect((await store.getHead('bidi'))!.title).toBe('Deal tracker.pdf');
    expect((await store.getHead('long'))!.title).toBe('q3-summary.pdf');
    expect((await store.getHead('blank'))!.title).toBe('Untitled');
  });

  it("records the original publisher as the version's quota owner", async () => {
    const db = makeKysely();
    await createLegacyTable(db);
    await insertLegacy(db, [{ id: 'mine', conversationId: 'c-1', userId: 'u-publisher' }]);
    await migrate(db);
    const v = await createArtifactStore(db).getVersion('mine', 1);
    expect(v).toMatchObject({ publishedBy: 'u-publisher', quotaOwner: 'u-publisher' });
  });

  it('a mapping failure rejects init and leaves the rows to retry on the next boot', async () => {
    const db = makeKysely();
    await runAttachmentsMigration(db); // files/temps exist, artifacts are fresh
    await sql`DROP TABLE attachments_v1_artifact_versions`.execute(db);
    await sql`DROP TABLE attachments_v1_artifacts`.execute(db);
    await createLegacyTable(db);
    await insertLegacy(db, [{ id: 'retry-me', conversationId: 'c-1' }]);

    await expect(
      attachmentsHarness({
        'conversations:agent-ids': async () => {
          throw new Error('conversations store unreachable');
        },
      }),
    ).rejects.toThrow(/conversations store unreachable/);
    const pending = await sql<{ agent_id: string | null }>`
      SELECT agent_id FROM attachments_v1_artifacts WHERE artifact_id = 'retry-me'
    `.execute(db);
    expect(pending.rows).toEqual([{ agent_id: null }]);

    const ok = await attachmentsHarness({
      'conversations:agent-ids': async (_ctx, input) => ({
        conversations: (input as { conversationIds: string[] }).conversationIds.map((conversationId) => ({
          conversationId,
          agentId: 'agt-retried',
        })),
      }),
    });
    harnesses.push(ok);
    expect((await createArtifactStore(db).getHead('retry-me'))?.agentId).toBe('agt-retried');
  });

  it('backfill passes mapAgents at most 500 ids at a time', async () => {
    const db = makeKysely();
    await createLegacyTable(db);
    await insertLegacy(
      db,
      Array.from({ length: 501 }, (_, i) => ({ id: `r-${i}`, conversationId: `c-${i}` })),
    );
    await runAttachmentsMigration(db);
    const sizes: number[] = [];
    const counts = await backfillArtifactAgents(db, async (ids) => {
      sizes.push(ids.length);
      return new Map(ids.map((id) => [id, 'agt-1']));
    });
    expect(sizes.sort((a, b) => b - a)).toEqual([500, 1]);
    expect(counts).toEqual({ mapped: 501, dropped: 0 });
  });

  it('refuses to start while legacy rows are pending and conversations:agent-ids is absent; a fresh DB starts without it', async () => {
    const fresh = await attachmentsHarness({});
    harnesses.push(fresh);
    await harnesses.pop()!.close({ onError: () => {} });

    const db = makeKysely();
    await sql`DROP TABLE attachments_v1_artifact_versions`.execute(db);
    await sql`DROP TABLE attachments_v1_artifacts`.execute(db);
    await createLegacyTable(db);
    await insertLegacy(db, [{ id: 'pending', conversationId: 'c-1' }]);
    await expect(attachmentsHarness({})).rejects.toThrow(/conversations:agent-ids/);
  });

  it('adds the chat-visual column to an existing table idempotently; existing rows stay visible', async () => {
    const db = makeKysely();
    await migrate(db);
    // The table as it was before the column existed, with a row in it.
    await sql`ALTER TABLE attachments_v1_artifacts DROP COLUMN visual`.execute(db);
    await sql`
      INSERT INTO attachments_v1_artifacts
        (artifact_id, agent_id, title, source_path, current_version, created_by_user_id)
      VALUES ('old-1', 'agt-1', 'Old report', 'reports/old.pdf', 1, 'u-1')
    `.execute(db);
    await sql`
      INSERT INTO attachments_v1_artifact_versions
        (artifact_id, version, sha256, media_type, size_bytes, conversation_id, published_by_user, quota_owner)
      VALUES ('old-1', 1, ${'a'.repeat(64)}, 'application/pdf', 3, 'c-1', 'u-1', 'u-1')
    `.execute(db);
    await migrate(db);
    await migrate(db);
    expect(await columnsOf(db, 'attachments_v1_artifacts')).toEqual(HEAD_COLUMNS);
    const col = await sql<{ is_nullable: string; column_default: string | null }>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'attachments_v1_artifacts' AND column_name = 'visual'
    `.execute(db);
    expect(col.rows[0]).toEqual({ is_nullable: 'NO', column_default: 'false' });
    const store = createArtifactStore(db);
    expect((await store.getHead('old-1'))!.visual).toBe(false);
    expect((await store.listForAgent('agt-1', 10)).map((h) => h.artifactId)).toEqual(['old-1']);
    expect(await store.countForAgent('agt-1')).toBe(1);
  });

  it('is idempotent, and a fresh install creates the new shape with its unique and share-code indexes', async () => {
    const db = makeKysely();
    await migrate(db);
    await migrate(db);
    expect(await columnsOf(db, 'attachments_v1_artifacts')).toEqual(HEAD_COLUMNS);
    expect(await columnsOf(db, 'attachments_v1_artifact_versions')).toEqual([
      'artifact_id',
      'conversation_id',
      'created_at',
      'media_type',
      'published_by_user',
      'quota_owner',
      'sha256',
      'size_bytes',
      'version',
    ]);
    const heads = await indexDefs(db, 'attachments_v1_artifacts');
    expect(heads.some((d) => /UNIQUE INDEX .* \(agent_id, source_path\) WHERE \(source_path IS NOT NULL\)/.test(d))).toBe(true);
    expect(heads.some((d) => /UNIQUE INDEX .* \(share_code\) WHERE \(share_code IS NOT NULL\)/.test(d))).toBe(true);
    expect(heads.some((d) => /\(agent_id, updated_at DESC\)/.test(d))).toBe(true);
    const versions = await indexDefs(db, 'attachments_v1_artifact_versions');
    expect(versions.some((d) => /\(sha256\)$/.test(d))).toBe(true);
    expect(versions.some((d) => /\(conversation_id\) WHERE \(conversation_id IS NOT NULL\)/.test(d))).toBe(true);
    const notNull = await sql<{ column_name: string; is_nullable: string }>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'attachments_v1_artifacts' ORDER BY column_name
    `.execute(db);
    expect(notNull.rows.filter((r) => r.is_nullable === 'YES').map((r) => r.column_name)).toEqual([
      'share_code',
      'source_path',
    ]);
  });
});
