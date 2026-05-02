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
  AppendTurnInput,
  AppendTurnOutput,
  CreateInput,
  CreateOutput,
  FetchHistoryInput,
  FetchHistoryOutput,
  StoreRunnerSessionInput,
  StoreRunnerSessionOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// conversations:fetch-history (Task 15, Week 10–12).
//
// The runner calls IPC /conversation.fetch-history at boot for resume; the
// host-side handler dispatches to this service hook. Tests pin:
//   1. Returns persisted turns in turn-index order with role + content
//      blocks; turnId/createdAt/turnIndex are NOT on the wire shape.
//   2. ACL gate fires (agents:resolve) — same shape as conversations:get.
//   3. Cross-tenant request rejects as 'not-found' (no existence-leak).
//   4. Unknown conversationId rejects as 'not-found'.
//   5. Empty conversation (no turns yet) returns turns: [].
//   6. invalid-payload on empty / oversized conversationId.
// ---------------------------------------------------------------------------

interface ResolveCall {
  agentId: string;
  userId: string;
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(opts?: {
  resolveDecide?: (call: ResolveCall) => 'allow' | 'forbid' | 'notfound';
}): Promise<{ h: TestHarness; resolveCalls: ResolveCall[] }> {
  const resolveCalls: ResolveCall[] = [];
  const decide = opts?.resolveDecide ?? (() => 'allow' as const);
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: { id: string; visibility: string } }> => {
        const call = input as ResolveCall;
        resolveCalls.push(call);
        const verdict = decide(call);
        if (verdict === 'allow') {
          return { agent: { id: call.agentId, visibility: 'personal' } };
        }
        if (verdict === 'notfound') {
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
          message: `agent '${call.agentId}' not accessible to '${call.userId}'`,
        });
      },
      // Phase D — `@ax/conversations` declares calls on `workspace:list`
      // / `workspace:read` (used by conversations:get). fetch-history
      // doesn't need them, but the manifest verification at bootstrap
      // does, so we register no-op stubs.
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false }) as const,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return { h, resolveCalls };
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

describe('@ax/conversations conversations:fetch-history', () => {
  it('returns turns in order with role + contentBlocks; strips turnId/createdAt', async () => {
    const { h } = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    // 3 turns: user → assistant → tool, mirroring a real chat trace.
    await h.bus.call<AppendTurnInput, AppendTurnOutput>(
      'conversations:append-turn',
      h.ctx({ userId: 'userA' }),
      {
        conversationId: created.conversationId,
        userId: 'userA',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hello there' }],
      },
    );
    await h.bus.call<AppendTurnInput, AppendTurnOutput>(
      'conversations:append-turn',
      h.ctx({ userId: 'userA' }),
      {
        conversationId: created.conversationId,
        userId: 'userA',
        role: 'assistant',
        contentBlocks: [
          { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
          { type: 'text', text: 'hi back' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } },
        ],
      },
    );
    await h.bus.call<AppendTurnInput, AppendTurnOutput>(
      'conversations:append-turn',
      h.ctx({ userId: 'userA' }),
      {
        conversationId: created.conversationId,
        userId: 'userA',
        role: 'tool',
        contentBlocks: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'ok',
            is_error: false,
          },
        ],
      },
    );

    const result = await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
      'conversations:fetch-history',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(result.turns).toHaveLength(3);
    expect(result.turns[0]).toEqual({
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'hello there' }],
    });
    expect(result.turns[1]?.role).toBe('assistant');
    expect(result.turns[2]?.role).toBe('tool');
    // Wire-shape promise: no turnId / turnIndex / createdAt leak.
    for (const t of result.turns) {
      expect(t).not.toHaveProperty('turnId');
      expect(t).not.toHaveProperty('turnIndex');
      expect(t).not.toHaveProperty('createdAt');
    }
    // Phase C: a freshly-created conversation has no bound runner session
    // yet. Explicit null on the wire keeps the shape stable; runners
    // branch on `null` vs string to decide replay vs SDK.resume(sessionId).
    expect(result.runnerSessionId).toBeNull();
  });

  it('returns runnerSessionId once the conversation has been bound', async () => {
    const { h } = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    // Bind a runner-session-id via the same hook the runner uses at boot.
    await h.bus.call<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
      'conversations:store-runner-session',
      h.ctx({ userId: 'userA' }),
      {
        conversationId: created.conversationId,
        runnerSessionId: 'sdk-sess-XYZ',
      },
    );
    const result = await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
      'conversations:fetch-history',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(result.runnerSessionId).toBe('sdk-sess-XYZ');
  });

  it('empty conversation returns turns: []', async () => {
    const { h } = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    const result = await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
      'conversations:fetch-history',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(result.turns).toEqual([]);
    expect(result.runnerSessionId).toBeNull();
  });

  it('cross-tenant fetch rejects as not-found (no existence leak)', async () => {
    const { h } = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    let caught: unknown;
    try {
      await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
        'conversations:fetch-history',
        h.ctx({ userId: 'userB' }),
        { conversationId: created.conversationId, userId: 'userB' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('not-found');
  });

  it('unknown conversationId rejects as not-found', async () => {
    const { h } = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
        'conversations:fetch-history',
        h.ctx({ userId: 'userA' }),
        { conversationId: 'cnv_does_not_exist', userId: 'userA' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('not-found');
  });

  it('agents:resolve gate fires (J1) — fetch-history calls agents:resolve before reading turns', async () => {
    const { h, resolveCalls } = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    const beforeFetch = resolveCalls.length;
    await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
      'conversations:fetch-history',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    // The fetch fires exactly one additional agents:resolve call.
    expect(resolveCalls.length).toBe(beforeFetch + 1);
    expect(resolveCalls[resolveCalls.length - 1]).toEqual({
      agentId: 'agt_a',
      userId: 'userA',
    });
  });

  it("agents:resolve 'forbidden' propagates as forbidden from fetch-history", async () => {
    // Only deny resolve for fetch attempts on agt_a by userA. Allow create
    // path so we can set up a row to fetch.
    let denyOn: string | null = null;
    const { h } = await makeHarness({
      resolveDecide: ({ agentId }) =>
        agentId === denyOn ? 'forbid' : 'allow',
    });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    // Now flip the policy to deny.
    denyOn = 'agt_a';

    let caught: unknown;
    try {
      await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
        'conversations:fetch-history',
        h.ctx({ userId: 'userA' }),
        { conversationId: created.conversationId, userId: 'userA' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('forbidden');
  });

  it('rejects empty conversationId as invalid-payload', async () => {
    const { h } = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
        'conversations:fetch-history',
        h.ctx({ userId: 'userA' }),
        { conversationId: '', userId: 'userA' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
  });

  it('rejects oversized conversationId (>256 chars) as invalid-payload', async () => {
    const { h } = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
        'conversations:fetch-history',
        h.ctx({ userId: 'userA' }),
        { conversationId: 'c'.repeat(257), userId: 'userA' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
  });
});
