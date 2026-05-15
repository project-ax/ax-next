import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput, CreateOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown): Promise<{ agent: { id: string; visibility: string } }> => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'personal' } };
      },
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false }) as const,
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), createConversationsPlugin()],
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
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('conversations:drop-turn (Phase A stub)', () => {
  it('throws not-implemented (Phase B lands the runner-native rewrite)', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
        conversationId: 'cnv_any',
        userId: 'u1',
        turnId: 't1',
      }),
    ).rejects.toMatchObject({
      code: 'not-implemented',
      plugin: '@ax/conversations',
    });
  });

  it('throws not-implemented even for a known-good conversation (stub does NOT validate inputs)', async () => {
    const h = await makeHarness();
    // Create a real conversation; the stub should still throw before
    // touching the row, locking in "this is a placeholder, not a
    // partial implementation."
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'agt_a' },
    );
    await expect(
      h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
        conversationId: conv.conversationId,
        userId: 'u1',
        turnId: 'turn_xyz',
      }),
    ).rejects.toMatchObject({ code: 'not-implemented' });
  });
});
