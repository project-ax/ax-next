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
});
