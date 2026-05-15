import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput, CreateOutput,
  GetInput, GetOutput,
  HideInput,
  ListInput, ListOutput,
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
      'workspace:apply': async () => ({ version: 'v-stub', delta: { before: null, after: 'v-stub', changes: [] } }),
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

describe('conversations:hide (Phase A routines foundation)', () => {
  it('marks a conversation hidden', async () => {
    const h = await makeHarness();
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'agt_a' },
    );
    await h.bus.call<HideInput, void>('conversations:hide', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId,
      userId: 'u1',
    });
    const got = await h.bus.call<GetInput, GetOutput>('conversations:get', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId,
      userId: 'u1',
    });
    expect(got.conversation.hidden).toBe(true);
  });

  it('is idempotent — hiding an already-hidden conversation is a no-op success', async () => {
    const h = await makeHarness();
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'agt_a' },
    );
    await h.bus.call<HideInput, void>('conversations:hide', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId,
      userId: 'u1',
    });
    // Second call must not throw.
    await h.bus.call<HideInput, void>('conversations:hide', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId,
      userId: 'u1',
    });
    const got = await h.bus.call<GetInput, GetOutput>('conversations:get', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId,
      userId: 'u1',
    });
    expect(got.conversation.hidden).toBe(true);
  });

  it('throws not-found for an unknown conversation id', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<HideInput, void>('conversations:hide', h.ctx({ userId: 'u1' }), {
        conversationId: 'cnv_does_not_exist',
        userId: 'u1',
      }),
    ).rejects.toMatchObject({ code: 'not-found', plugin: '@ax/conversations' });
  });

  it('throws not-found for a foreign user (no cross-tenant existence leak)', async () => {
    const h = await makeHarness();
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'agt_a' },
    );
    await expect(
      h.bus.call<HideInput, void>('conversations:hide', h.ctx({ userId: 'u2' }), {
        conversationId: conv.conversationId,
        userId: 'u2',
      }),
    ).rejects.toMatchObject({ code: 'not-found', plugin: '@ax/conversations' });
    // Sanity: row was not mutated.
    const got = await h.bus.call<GetInput, GetOutput>('conversations:get', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId,
      userId: 'u1',
    });
    expect(got.conversation.hidden).toBe(false);
  });

  it('hidden conversations are excluded from conversations:list', async () => {
    const h = await makeHarness();
    const visible = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'agt_a' },
    );
    const toHide = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'agt_a' },
    );
    await h.bus.call<HideInput, void>('conversations:hide', h.ctx({ userId: 'u1' }), {
      conversationId: toHide.conversationId,
      userId: 'u1',
    });
    const list = await h.bus.call<ListInput, ListOutput>(
      'conversations:list',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1' },
    );
    const ids = list.map((c) => c.conversationId);
    expect(ids).toContain(visible.conversationId);
    expect(ids).not.toContain(toHide.conversationId);
  });
});
