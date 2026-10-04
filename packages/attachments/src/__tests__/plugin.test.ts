import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAttachmentsPlugin } from '../plugin.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(
  config: Parameters<typeof createAttachmentsPlugin>[0] = {},
): Promise<TestHarness> {
  const h = await createTestHarness({
    // Mock the hooks this plugin `calls` but doesn't register itself.
    // bootstrap's verifyCalls() rejects on any missing call producer; these
    // mocks satisfy the contract without booting unrelated plugins. TASK-68:
    // the git path (workspace:apply/read) is replaced by the blob:* store.
    services: {
      'blob:put': async () => ({ sha256: 'a'.repeat(64), size: 0 }),
      'blob:get': async () => ({ found: false }) as const,
      // D10: artifacts:publish-blob stats the sha before it writes a row.
      'blob:stat': async (_ctx: unknown, input: unknown) =>
        (input as { sha256: string }).sha256 === 'a'.repeat(64)
          ? { size: 1 }
          : ({ found: false } as const),
      'conversations:get': async () => ({
        conversation: {
          conversationId: 'mock-conv',
          userId: 'test-user',
          agentId: 'test-agent',
        },
        turns: [],
      }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createAttachmentsPlugin(config),
    ],
  });
  harnesses.push(h);
  return h;
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
  const cleanup = new (await import('pg')).default.Client({ connectionString });
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

describe('@ax/attachments plugin manifest', () => {
  it('declares the service hooks + expected calls (TASK-68: blob:* not git)', () => {
    const plugin = createAttachmentsPlugin();
    expect(plugin.manifest.name).toBe('@ax/attachments');
    expect(plugin.manifest.version).toBe('0.0.0');
    expect(plugin.manifest.registers).toEqual([
      'attachments:store-temp',
      'attachments:commit',
      'attachments:download',
      'attachments:list-for-conversation',
      'artifacts:publish-blob',
    ]);
    expect(plugin.manifest.calls).toContain('database:get-instance');
    expect(plugin.manifest.calls).toContain('blob:put');
    expect(plugin.manifest.calls).toContain('blob:get');
    // TASK-776 (D10): artifacts:publish-blob refuses a sha the store lacks.
    expect(plugin.manifest.calls).toContain('blob:stat');
    expect(plugin.manifest.calls).toContain('conversations:get');
    // The git path is removed (acceptance criterion).
    expect(plugin.manifest.calls).not.toContain('workspace:apply');
    expect(plugin.manifest.calls).not.toContain('workspace:read');
    // TASK-718: drop a purged conversation's metadata rows. TASK-776: answer
    // blob:collect-refs (it stores shas in its own rows, so it is a holder).
    expect(plugin.manifest.subscribes).toEqual(['conversations:purged', 'blob:collect-refs']);
  });
});

describe('@ax/attachments plugin init / shutdown', () => {
  it('registers all service hooks on init', async () => {
    const harness = await makeHarness();
    expect(harness.bus.hasService('attachments:store-temp')).toBe(true);
    expect(harness.bus.hasService('attachments:commit')).toBe(true);
    expect(harness.bus.hasService('attachments:download')).toBe(true);
    expect(harness.bus.hasService('attachments:list-for-conversation')).toBe(true);
    expect(harness.bus.hasService('artifacts:publish-blob')).toBe(true);
  });

  it('runs the attachments_v1_temps migration on init', async () => {
    const harness = await makeHarness();
    const ctx = harness.ctx();
    const { db } = await harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctx,
      {},
    );
    const result = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'attachments_v1_temps'
    `.execute(db);
    expect(result.rows.length).toBe(1);
  });

  it('starts the janitor and stops it on shutdown', async () => {
    // Use a 1-second interval; janitor should purge an already-expired row
    // within ~1.5 seconds.
    const harness = await makeHarness({
      janitorIntervalSeconds: 1,
      tempTtlSeconds: 600,
    });
    const ctx = harness.ctx();
    const { db } = await harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctx,
      {},
    );

    // Insert an already-expired row directly so the janitor has something
    // to find on its next sweep.
    await sql`
      INSERT INTO attachments_v1_temps
        (attachment_id, user_id, bytes, display_name, media_type, size_bytes, expires_at)
      VALUES (
        'a-expired-janitor',
        'u-jan',
        '\\x00',
        'x',
        'text/plain',
        1,
        NOW() - INTERVAL '1 minute'
      )
    `.execute(db);

    // Wait long enough for at least one janitor sweep after the initial one.
    await new Promise((r) => setTimeout(r, 1500));

    const after = await sql<{ attachment_id: string }>`
      SELECT attachment_id FROM attachments_v1_temps
      WHERE attachment_id = 'a-expired-janitor'
    `.execute(db);
    expect(after.rows.length).toBe(0);

    // Close — janitor must stop within the close timeout (default 10s).
    await harness.close();
  });
});

describe('@ax/attachments artifacts:publish-blob wiring (D10)', () => {
  const publish = (sha256: string) => ({
    conversationId: 'c-1',
    sha256,
    path: 'workspace/report.pdf',
    displayName: 'report.pdf',
    mediaType: 'application/pdf',
    size: 1,
  });

  it('publishes a sha the blob store holds', async () => {
    const harness = await makeHarness();
    const out = await harness.bus.call<unknown, { artifactId: string }>(
      'artifacts:publish-blob',
      harness.ctx(),
      publish('a'.repeat(64)),
    );
    expect(out.artifactId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('refuses a sha the blob store does not hold, and leaves no row behind', async () => {
    const harness = await makeHarness();
    await expect(
      harness.bus.call('artifacts:publish-blob', harness.ctx(), publish('b'.repeat(64))),
    ).rejects.toMatchObject({ code: 'not-found', plugin: '@ax/attachments' });
    const { db } = await harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      harness.ctx(),
      {},
    );
    const rows = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM attachments_v1_artifacts
    `.execute(db);
    expect(rows.rows[0]!.n).toBe('0');
  });
});
