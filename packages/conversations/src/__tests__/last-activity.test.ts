import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput,
  CreateOutput,
  GetMetadataInput,
  GetMetadataOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Phase B (2026-04-29). chat:turn-end subscriber bumps last_activity_at
// after a successful :append-turn. Heartbeat turn-ends (no contentBlocks)
// stay heartbeats — no row write, no timestamp leak (I8).
// ---------------------------------------------------------------------------

interface MockAgent {
  id: string;
  workspaceRef: string | null;
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(args: {
  agents: ReadonlyMap<string, MockAgent>;
}): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: MockAgent }> => {
        const { agentId } = input as { agentId: string; userId: string };
        const agent = args.agents.get(agentId);
        if (agent === undefined) {
          throw new Error(`mock agents:resolve: unknown agent '${agentId}'`);
        }
        return { agent };
      },
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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
    await cleanup.query(
      'DROP TABLE IF EXISTS conversations_v1_conversations',
    );
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('chat:turn-end → last_activity_at', () => {
  it('bumps last_activity_at on a turn with content blocks', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: null }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );
    const before = Date.now();
    await h.bus.fire('chat:turn-end', h.ctx({
      userId: 'userA',
      conversationId: conv.conversationId,
    }), {
      reqId: 'req-1',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'hello' }],
    });
    const md = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA' },
    );
    expect(md.lastActivityAt).not.toBeNull();
    const ts = new Date(md.lastActivityAt!).getTime();
    // Within 5 seconds of the fire time, both directions.
    expect(ts).toBeGreaterThanOrEqual(before - 5000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('does NOT bump last_activity_at on a heartbeat turn-end (no contentBlocks)', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: null }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );
    await h.bus.fire('chat:turn-end', h.ctx({
      userId: 'userA',
      conversationId: conv.conversationId,
    }), {
      reqId: 'req-1',
    });
    const md = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA' },
    );
    expect(md.lastActivityAt).toBeNull();
  });

  it('does NOT bump last_activity_at when ctx.conversationId is unset', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: null }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );
    // No conversationId in the context — turn-end fired but the
    // subscriber should be a no-op for the activity-bump path.
    await h.bus.fire('chat:turn-end', h.ctx({ userId: 'userA' }), {
      reqId: 'req-1',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'hello' }],
    });
    const md = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA' },
    );
    expect(md.lastActivityAt).toBeNull();
  });
});
