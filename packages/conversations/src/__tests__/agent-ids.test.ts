import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type { CreateInput, CreateOutput, DeleteInput, HideInput } from '../types.js';

// conversations:agent-ids is a HOST-ONLY lookup (no ACL): artifacts use it to
// map conversation ids back to their agent. Soft-deleted and hidden rows are
// included on purpose; ids with no row are simply absent.

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => ({
        agent: { id: (input as { agentId: string }).agentId },
      }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
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
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

type AgentIdsOut = { conversations: Array<{ conversationId: string; agentId: string }> };

describe('conversations:agent-ids', () => {
  it('maps live, soft-deleted and hidden conversations to their agent, and omits unknown ids', async () => {
    const h = await makeHarness();
    const ctx = h.ctx({ userId: 'u1' });
    const mk = async (agentId: string): Promise<string> =>
      (await h.bus.call<CreateInput, CreateOutput>('conversations:create', ctx, { userId: 'u1', agentId })).conversationId;
    const live = await mk('agt_a');
    const softDeleted = await mk('agt_b');
    const hidden = await mk('agt_a');
    await h.bus.call<DeleteInput, void>('conversations:delete', ctx, { conversationId: softDeleted, userId: 'u1' });
    await h.bus.call<HideInput, void>('conversations:hide', ctx, { conversationId: hidden, userId: 'u1' });

    const out = await h.bus.call<unknown, AgentIdsOut>('conversations:agent-ids', h.ctx({ userId: 'stranger' }), {
      conversationIds: [live, softDeleted, hidden, 'cnv_missing'],
    });
    expect(out.conversations).toHaveLength(3);
    expect(out.conversations).toEqual(
      expect.arrayContaining([
        { conversationId: live, agentId: 'agt_a' },
        { conversationId: softDeleted, agentId: 'agt_b' },
        { conversationId: hidden, agentId: 'agt_a' },
      ]),
    );
  });

  it('accepts exactly 500 ids', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<unknown, AgentIdsOut>('conversations:agent-ids', h.ctx({ userId: 'u1' }), {
      conversationIds: Array.from({ length: 500 }, (_, i) => `c${i}`),
    });
    expect(out.conversations).toEqual([]);
  });

  it.each([
    [[]],
    [Array.from({ length: 501 }, (_, i) => `c${i}`)],
    [['']],
    [[42]],
  ])('refuses %j with invalid-payload', async (ids) => {
    const h = await makeHarness();
    await expect(
      h.bus.call('conversations:agent-ids', h.ctx({ userId: 'u1' }), { conversationIds: ids }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('refuses a non-object payload with invalid-payload', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call('conversations:agent-ids', h.ctx({ userId: 'u1' }), 'nope'),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});
