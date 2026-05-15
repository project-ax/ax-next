import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type { Conversation, CreateInput, CreateOutput, GetInput, GetOutput, ListInput, ListOutput } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: { id: string; visibility: string } }> => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'personal' } };
      },
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false }) as const,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

async function markHidden(conversationId: string): Promise<void> {
  const client = new (await import('pg')).default.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'UPDATE conversations_v1_conversations SET hidden = true WHERE conversation_id = $1',
      [conversationId],
    );
  } finally {
    await client.end().catch(() => {});
  }
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

describe('@ax/conversations hidden field (Phase A)', () => {
  it('list-by-user excludes hidden conversations', async () => {
    const h = await makeHarness();

    const visible = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'agt_a' },
    );
    const hidden = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'agt_a' },
    );

    await markHidden(hidden.conversationId);

    const list = await h.bus.call<ListInput, ListOutput>(
      'conversations:list',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1' },
    );
    const ids = list.map((c: Conversation) => c.conversationId);
    expect(ids).toContain(visible.conversationId);
    expect(ids).not.toContain(hidden.conversationId);
  });

  it('get-by-id returns hidden conversations (single-row reads still work)', async () => {
    const h = await makeHarness();

    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'agt_a' },
    );

    await markHidden(conv.conversationId);

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'u1' }),
      { conversationId: conv.conversationId, userId: 'u1' },
    );
    expect(got.conversation.hidden).toBe(true);
  });
});
