import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  runAttachmentsMigration,
  type AttachmentsDatabase,
} from '../migrations.js';
import { createAttachmentsStore } from '../store.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AttachmentsDatabase>[] = [];

function makeKysely(): Kysely<AttachmentsDatabase> {
  const k = new Kysely<AttachmentsDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 2 }),
    }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('attachments_v1_temps').ifExists().execute();
      await k.schema.dropTable('attachments_v1_files').ifExists().execute();
      await k.schema.dropTable('attachments_v1_artifacts').ifExists().execute();
    } catch {
      // drained pool — ignore
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('runAttachmentsMigration', () => {
  it('creates attachments_v1_temps with the expected columns', async () => {
    const db = makeKysely();
    await runAttachmentsMigration(db);
    const result = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'attachments_v1_temps'
      ORDER BY column_name
    `.execute(db);
    const cols = result.rows.map((r) => r.column_name);
    expect(cols).toContain('attachment_id');
    expect(cols).toContain('user_id');
    expect(cols).toContain('bytes');
    expect(cols).toContain('display_name');
    expect(cols).toContain('media_type');
    expect(cols).toContain('size_bytes');
    expect(cols).toContain('expires_at');
    expect(cols).toContain('created_at');
  });

  it('is idempotent on second run', async () => {
    const db = makeKysely();
    await runAttachmentsMigration(db);
    await runAttachmentsMigration(db); // must not throw
  });

  it('indexes user_id for per-user quota lookups', async () => {
    const db = makeKysely();
    await runAttachmentsMigration(db);
    const result = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'attachments_v1_temps'
    `.execute(db);
    const indexes = result.rows.map((r) => r.indexname);
    expect(indexes.some((n) => n.includes('user_id'))).toBe(true);
  });

  it('indexes expires_at for the janitor sweep', async () => {
    const db = makeKysely();
    await runAttachmentsMigration(db);
    const result = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'attachments_v1_temps'
    `.execute(db);
    const indexes = result.rows.map((r) => r.indexname);
    expect(indexes.some((n) => n.includes('expires_at'))).toBe(true);
  });

  // TASK-776 (blob-gc design D7): @ax/attachments answers `blob:collect-refs`
  // with one `WHERE sha256 = ANY($1)` per table, once per sweep batch. Without
  // these indexes that is a full scan of each table on every batch.
  it.each(['attachments_v1_files', 'attachments_v1_artifacts'])(
    'indexes %s.sha256 for the blob:collect-refs holder lookup',
    async (table) => {
      const db = makeKysely();
      await runAttachmentsMigration(db);
      const result = await sql<{ indexdef: string }>`
        SELECT indexdef FROM pg_indexes WHERE tablename = ${table}
      `.execute(db);
      expect(result.rows.some((r) => /\(sha256\)/.test(r.indexdef))).toBe(true);
    },
  );

  async function columnsOf(db: Kysely<AttachmentsDatabase>, table: string): Promise<string[]> {
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${table} ORDER BY column_name
    `.execute(db);
    return result.rows.map((r) => r.column_name);
  }

  // Uploads are addressed by id; nothing reads or writes a path for them.
  // Artifacts keep theirs: it is the re-publish key.
  it('a fresh install has no path column on files; artifacts keep theirs', async () => {
    const db = makeKysely();
    await runAttachmentsMigration(db);
    expect(await columnsOf(db, 'attachments_v1_files')).not.toContain('path');
    expect(await columnsOf(db, 'attachments_v1_artifacts')).toContain('path');
  });

  it('an attachments_v1_files table created with a path column upgrades: path is gone and old rows still read by id', async () => {
    const db = makeKysely();
    // The table exactly as the previous release created it.
    await sql`
      CREATE TABLE attachments_v1_files (
        attachment_id   TEXT PRIMARY KEY,
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
    await sql`
      INSERT INTO attachments_v1_files
        (attachment_id, conversation_id, user_id, sha256, path, display_name, media_type, size_bytes)
      VALUES
        ('old-1', 'c-1', 'u-1', ${'a'.repeat(64)}, '.ax/uploads/c-1/t-1/ab12__report.pdf',
         'report.pdf', 'application/pdf', 42)
    `.execute(db);

    await runAttachmentsMigration(db);
    await runAttachmentsMigration(db); // idempotent once the column is gone

    expect(await columnsOf(db, 'attachments_v1_files')).not.toContain('path');
    // The (conversation_id, path) unique constraint went with the column.
    const constraints = await sql<{ def: string }>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'attachments_v1_files'::regclass
    `.execute(db);
    expect(constraints.rows.map((r) => r.def).filter((d) => d.includes('conversation_id'))).toEqual([]);

    expect(await createAttachmentsStore(db).getFileById('old-1')).toStrictEqual({
      id: 'old-1',
      conversationId: 'c-1',
      userId: 'u-1',
      sha256: 'a'.repeat(64),
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 42,
    });
  });
});
