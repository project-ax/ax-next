import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput,
  CreateOutput,
  GetInput,
  GetOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// chat:turn-end auto-append subscriber test (Task 3 of Week 10–12).
//
// When the runner emits event.turn-end, the IPC handler fires
// `chat:turn-end` on the host bus. This subscriber appends the assistant
// (or tool) turn to ctx.conversationId via the existing :append-turn
// service hook so the same agents:resolve gate (Invariant J1) runs.
//
// We exercise the subscriber directly via `bus.fire('chat:turn-end', ...)`
// rather than spawning a runner: that's the contract surface the IPC
// handler uses, and it lets us assert no-op vs append-success vs
// append-failure-must-not-throw without a sandbox.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

interface ResolvePolicy {
  decide(call: { agentId: string; userId: string }):
    | 'allow'
    | 'forbid'
    | 'notfound';
}

async function makeHarness(
  policy: ResolvePolicy = { decide: () => 'allow' },
): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: { id: string; visibility: string } }> => {
        const call = input as { agentId: string; userId: string };
        const decision = policy.decide(call);
        if (decision === 'allow') {
          return {
            agent: { id: call.agentId, visibility: 'personal' },
          };
        }
        if (decision === 'notfound') {
          throw new PluginError({
            code: 'not-found',
            plugin: 'mock-agents',
            hookName: 'agents:resolve',
            message: `agent '${call.agentId}' not found`,
          });
        }
        throw new PluginError({
          code: 'forbidden',
          plugin: 'mock-agents',
          hookName: 'agents:resolve',
          message: `agent '${call.agentId}' forbidden for '${call.userId}'`,
        });
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

describe('@ax/conversations chat:turn-end auto-append', () => {
  it('appends the assistant turn when ctx.conversationId is set and contentBlocks is non-empty', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    const ctx = h.ctx({
      userId: 'userA',
      agentId: 'agt_a',
      conversationId: created.conversationId,
    });

    const result = await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'hello world' }],
    });
    expect(result.rejected).toBe(false);

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toHaveLength(1);
    expect(got.turns[0]!.role).toBe('assistant');
    expect(got.turns[0]!.contentBlocks).toEqual([
      { type: 'text', text: 'hello world' },
    ]);
  });

  it('defaults role to assistant when payload.role is omitted', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    const ctx = h.ctx({
      userId: 'userA',
      agentId: 'agt_a',
      conversationId: created.conversationId,
    });

    await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      contentBlocks: [{ type: 'text', text: 'no role on payload' }],
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toHaveLength(1);
    expect(got.turns[0]!.role).toBe('assistant');
  });

  it('persists role=tool with tool_result blocks (replay round-trip)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    const ctx = h.ctx({
      userId: 'userA',
      agentId: 'agt_a',
      conversationId: created.conversationId,
    });

    await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      role: 'tool',
      contentBlocks: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: '/tmp',
          is_error: false,
        },
      ],
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toHaveLength(1);
    expect(got.turns[0]!.role).toBe('tool');
    expect(got.turns[0]!.contentBlocks).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: '/tmp',
        is_error: false,
      },
    ]);
  });

  it('no-ops when ctx.conversationId is unset (canary chats)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    // Note: ctx WITHOUT conversationId — what every chat:run looks like
    // until Task 16 lands the orchestrator change.
    const ctx = h.ctx({ userId: 'userA', agentId: 'agt_a' });

    await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'this should NOT be persisted' }],
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toHaveLength(0);
  });

  it('no-ops when contentBlocks is empty/missing (heartbeat turn-ends)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    const ctx = h.ctx({
      userId: 'userA',
      agentId: 'agt_a',
      conversationId: created.conversationId,
    });

    // Missing contentBlocks.
    await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      role: 'assistant',
    });

    // Empty array.
    await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [],
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toHaveLength(0);
  });

  it('append-turn failure is caught — chat:turn-end fire does NOT throw or reject', async () => {
    // We need a conversation row to exist so the :append-turn lookup
    // doesn't fail at the conversation-row stage. Each harness shares
    // the same postgres database, so a row created via the seed harness
    // persists for the forbid-harness fire path.
    const seedHarness = await makeHarness({ decide: () => 'allow' });
    const created = await seedHarness.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      seedHarness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    // Forbid harness: agents:resolve denies, so :append-turn raises a
    // PluginError forbidden. The subscriber MUST swallow it; otherwise a
    // transient ACL change would tear down the running chat.
    const h = await makeHarness({ decide: () => 'forbid' });

    const ctx = h.ctx({
      userId: 'userA',
      agentId: 'agt_a',
      conversationId: created.conversationId,
    });

    let threw: unknown;
    try {
      // bus.fire returns a FireResult — it doesn't throw on subscriber
      // errors itself, but a misbehaving subscriber that re-throws WOULD
      // be caught by HookBus and logged. We assert the subscriber
      // does NOT trigger that error path AND does not reject the fire.
      const result = await h.bus.fire('chat:turn-end', ctx, {
        reason: 'user-message-wait',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'denied' }],
      });
      expect(result.rejected).toBe(false);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeUndefined();

    // Sanity: nothing got persisted.
    const got = await seedHarness.bus.call<GetInput, GetOutput>(
      'conversations:get',
      seedHarness.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toHaveLength(0);
  });
});
