import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { PluginError } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput,
  CreateOutput,
  DeleteInput,
  FindOrCreateInput,
  FindOrCreateOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness({ resolveOk = true }: { resolveOk?: boolean } = {}): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        if (!resolveOk) {
          throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'denied' });
        }
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

describe('conversations:find-or-create (Phase A routines foundation)', () => {
  it('creates new on first call — created=true, externalKey set, hidden=false, runnerType=claude-sdk', async () => {
    const h = await makeHarness();
    const result = await h.bus.call<FindOrCreateInput, FindOrCreateOutput>(
      'conversations:find-or-create',
      h.ctx({ userId: 'u1' }),
      {
        userId: 'u1',
        agentId: 'agt_a',
        externalKey: 'routines/daily-digest',
        fallback: { title: 'Daily Digest' },
      },
    );
    expect(result.created).toBe(true);
    expect(result.conversation.externalKey).toBe('routines/daily-digest');
    expect(result.conversation.hidden).toBe(false);
    expect(result.conversation.runnerType).toBe('claude-sdk');
    expect(result.conversation.userId).toBe('u1');
    expect(result.conversation.agentId).toBe('agt_a');
  });

  it('returns existing on second call with same key — created=false, same conversationId', async () => {
    const h = await makeHarness();
    const first = await h.bus.call<FindOrCreateInput, FindOrCreateOutput>(
      'conversations:find-or-create',
      h.ctx({ userId: 'u1' }),
      {
        userId: 'u1',
        agentId: 'agt_a',
        externalKey: 'routines/daily-digest',
        fallback: { title: 'Daily Digest' },
      },
    );
    expect(first.created).toBe(true);

    const second = await h.bus.call<FindOrCreateInput, FindOrCreateOutput>(
      'conversations:find-or-create',
      h.ctx({ userId: 'u1' }),
      {
        userId: 'u1',
        agentId: 'agt_a',
        externalKey: 'routines/daily-digest',
        fallback: { title: 'Ignored Title' },
      },
    );
    expect(second.created).toBe(false);
    expect(second.conversation.conversationId).toBe(first.conversation.conversationId);
  });

  it('scopes per userId — different userId gets a separate row', async () => {
    const h = await makeHarness();
    const r1 = await h.bus.call<FindOrCreateInput, FindOrCreateOutput>(
      'conversations:find-or-create',
      h.ctx({ userId: 'u1' }),
      {
        userId: 'u1',
        agentId: 'agt_a',
        externalKey: 'routines/daily-digest',
        fallback: {},
      },
    );
    const r2 = await h.bus.call<FindOrCreateInput, FindOrCreateOutput>(
      'conversations:find-or-create',
      h.ctx({ userId: 'u2' }),
      {
        userId: 'u2',
        agentId: 'agt_a',
        externalKey: 'routines/daily-digest',
        fallback: {},
      },
    );
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r1.conversation.conversationId).not.toBe(r2.conversation.conversationId);
  });

  it('scopes per agentId — same userId + externalKey but different agentId gets a separate row', async () => {
    const h = await makeHarness();
    const r1 = await h.bus.call<FindOrCreateInput, FindOrCreateOutput>(
      'conversations:find-or-create',
      h.ctx({ userId: 'u1' }),
      {
        userId: 'u1',
        agentId: 'agt_a',
        externalKey: 'routines/daily-digest',
        fallback: {},
      },
    );
    const r2 = await h.bus.call<FindOrCreateInput, FindOrCreateOutput>(
      'conversations:find-or-create',
      h.ctx({ userId: 'u1' }),
      {
        userId: 'u1',
        agentId: 'agt_b',
        externalKey: 'routines/daily-digest',
        fallback: {},
      },
    );
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r1.conversation.conversationId).not.toBe(r2.conversation.conversationId);
  });

  it('ignores soft-deleted rows — creates fresh after delete', async () => {
    const h = await makeHarness();
    const first = await h.bus.call<FindOrCreateInput, FindOrCreateOutput>(
      'conversations:find-or-create',
      h.ctx({ userId: 'u1' }),
      {
        userId: 'u1',
        agentId: 'agt_a',
        externalKey: 'routines/daily-digest',
        fallback: {},
      },
    );
    expect(first.created).toBe(true);

    // Soft-delete via conversations:delete.
    await h.bus.call<DeleteInput, void>(
      'conversations:delete',
      h.ctx({ userId: 'u1' }),
      { conversationId: first.conversation.conversationId, userId: 'u1' },
    );

    // find-or-create with same key — must create a NEW row.
    const second = await h.bus.call<FindOrCreateInput, FindOrCreateOutput>(
      'conversations:find-or-create',
      h.ctx({ userId: 'u1' }),
      {
        userId: 'u1',
        agentId: 'agt_a',
        externalKey: 'routines/daily-digest',
        fallback: {},
      },
    );
    expect(second.created).toBe(true);
    expect(second.conversation.conversationId).not.toBe(first.conversation.conversationId);
  });

  it('agents:resolve denial throws forbidden', async () => {
    const h = await makeHarness({ resolveOk: false });
    await expect(
      h.bus.call<FindOrCreateInput, FindOrCreateOutput>(
        'conversations:find-or-create',
        h.ctx({ userId: 'u1' }),
        {
          userId: 'u1',
          agentId: 'agt_a',
          externalKey: 'routines/daily-digest',
          fallback: {},
        },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
