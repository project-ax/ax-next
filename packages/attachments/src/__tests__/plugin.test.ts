import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
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
    // mocks satisfy the contract without booting unrelated plugins.
    services: {
      'workspace:apply': async () => ({ commitId: 'mock-commit' }),
      'workspace:read': async () => ({ found: false }) as const,
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('@ax/attachments plugin manifest', () => {
  it('declares the three service hooks + expected calls', () => {
    const plugin = createAttachmentsPlugin();
    expect(plugin.manifest.name).toBe('@ax/attachments');
    expect(plugin.manifest.version).toBe('0.0.0');
    expect(plugin.manifest.registers).toEqual([
      'attachments:store-temp',
      'attachments:commit',
      'attachments:download',
    ]);
    expect(plugin.manifest.calls).toContain('database:get-instance');
    expect(plugin.manifest.calls).toContain('workspace:apply');
    expect(plugin.manifest.calls).toContain('workspace:read');
    expect(plugin.manifest.calls).toContain('conversations:get');
    expect(plugin.manifest.subscribes).toEqual([]);
  });
});

describe('@ax/attachments plugin init / shutdown', () => {
  it('registers all three service hooks on init', async () => {
    const harness = await makeHarness();
    expect(harness.bus.hasService('attachments:store-temp')).toBe(true);
    expect(harness.bus.hasService('attachments:commit')).toBe(true);
    expect(harness.bus.hasService('attachments:download')).toBe(true);
  });

  it('runs the attachments_v1_temps migration on init', async () => {
    const harness = await makeHarness();
    const ctx = harness.ctx();
    const { db } = await harness.bus.call<unknown, { db: any }>(
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
    const { db } = await harness.bus.call<unknown, { db: any }>(
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
