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
  BindSessionInput,
  CreateInput,
  CreateOutput,
  GetInput,
  GetOutput,
  UnbindSessionInput,
} from '../types.js';

// ---------------------------------------------------------------------------
// active_session_id lifecycle test (Task 14 of Week 10–12, J6).
//
// Covers:
//   1. bind-session sets active_session_id + active_req_id atomically.
//   2. bind-session for a foreign user → not-found (no cross-tenant bind).
//   3. unbind-session clears both fields.
//   4. session:terminate fire clears every conversation bound to the
//      sessionId (host-internal, no userId scope).
//   5. chat:turn-end clears active_req_id while keeping active_session_id.
//   6. chat:turn-end with a stale reqId is a no-op (compare-and-clear).
//
// Strategy mirrors subscribe.test.ts: spin up postgres in testcontainers,
// stub `agents:resolve`, drive the bus directly.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      // Always allow — these tests aren't exercising the agents:resolve
      // gate; bind-session / unbind-session deliberately don't call it.
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: { id: string; visibility: string } }> => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'personal' } };
      },
      // Phase D — conversations:get reads from workspace jsonl. The
      // session-lifecycle tests use conversations:get to inspect row
      // state (active_session_id / active_req_id) but don't care
      // about turns. Default to "no jsonl" → empty turns.
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

describe('@ax/conversations active_session_id lifecycle (J6)', () => {
  it('bind-session sets active_session_id and active_req_id atomically', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, sessionId: 's1', reqId: 'r1' },
    );

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.conversation.activeSessionId).toBe('s1');
    expect(got.conversation.activeReqId).toBe('r1');
  });

  it('bind-session for a foreign ctx.userId throws PluginError(not-found)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    await expect(
      h.bus.call<BindSessionInput, void>(
        'conversations:bind-session',
        h.ctx({ userId: 'userB' }),
        {
          conversationId: created.conversationId,
          sessionId: 's1',
          reqId: 'r1',
        },
      ),
    ).rejects.toMatchObject({
      code: 'not-found',
      plugin: '@ax/conversations',
    });

    // Sanity: nothing was set on the row.
    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.conversation.activeSessionId).toBeNull();
    expect(got.conversation.activeReqId).toBeNull();
  });

  it('unbind-session clears active_session_id and active_req_id', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, sessionId: 's1', reqId: 'r1' },
    );

    await h.bus.call<UnbindSessionInput, void>(
      'conversations:unbind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId },
    );

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.conversation.activeSessionId).toBeNull();
    expect(got.conversation.activeReqId).toBeNull();
  });

  it('unbind-session for a foreign ctx.userId throws PluginError(not-found)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, sessionId: 's1', reqId: 'r1' },
    );

    await expect(
      h.bus.call<UnbindSessionInput, void>(
        'conversations:unbind-session',
        h.ctx({ userId: 'userB' }),
        { conversationId: created.conversationId },
      ),
    ).rejects.toMatchObject({
      code: 'not-found',
      plugin: '@ax/conversations',
    });

    // Sanity: still bound from userA's perspective.
    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.conversation.activeSessionId).toBe('s1');
    expect(got.conversation.activeReqId).toBe('r1');
  });

  it('session:terminate fire clears every conversation bound to that sessionId', async () => {
    const h = await makeHarness();
    const c1 = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    const c2 = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    // Bind both to the same sessionId. Normally one sandbox → one
    // conversation (J6); we force the multi-row case here to exercise the
    // defensive multi-row clear in store.clearBySessionId.
    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: c1.conversationId, sessionId: 's1', reqId: 'r1' },
    );
    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: c2.conversationId, sessionId: 's1', reqId: 'r2' },
    );

    const result = await h.bus.fire('session:terminate', h.ctx(), {
      sessionId: 's1',
    });
    expect(result.rejected).toBe(false);

    const got1 = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: c1.conversationId, userId: 'userA' },
    );
    const got2 = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: c2.conversationId, userId: 'userA' },
    );
    expect(got1.conversation.activeSessionId).toBeNull();
    expect(got1.conversation.activeReqId).toBeNull();
    expect(got2.conversation.activeSessionId).toBeNull();
    expect(got2.conversation.activeReqId).toBeNull();
  });

  it('session:terminate fire leaves rows bound to a different sessionId untouched', async () => {
    const h = await makeHarness();
    const cA = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    const cB = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: cA.conversationId, sessionId: 's1', reqId: 'r1' },
    );
    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: cB.conversationId, sessionId: 's2', reqId: 'r2' },
    );

    await h.bus.fire('session:terminate', h.ctx(), { sessionId: 's1' });

    const gotB = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: cB.conversationId, userId: 'userA' },
    );
    expect(gotB.conversation.activeSessionId).toBe('s2');
    expect(gotB.conversation.activeReqId).toBe('r2');
  });

  it('chat:turn-end clears active_req_id while keeping active_session_id', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, sessionId: 's1', reqId: 'r1' },
    );

    const ctx = h.ctx({
      userId: 'userA',
      agentId: 'agt_a',
      conversationId: created.conversationId,
    });
    const result = await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      reqId: 'r1',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'done' }],
    });
    expect(result.rejected).toBe(false);

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.conversation.activeSessionId).toBe('s1');
    expect(got.conversation.activeReqId).toBeNull();
  });

  it('chat:turn-end with a stale reqId is a no-op (compare-and-clear)', async () => {
    // The flow we're protecting against: turn-end for r1 fires AFTER a
    // fresh r2 has been bound. The subscriber sees r1, but the row's
    // active_req_id is r2 — we must NOT clear it.
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, sessionId: 's1', reqId: 'r1' },
    );
    // Re-bind to r2 (same sessionId). This is what the orchestrator does
    // when a second user message arrives while the first is still in-
    // flight; r1's turn-end subscriber will run later than r2's bind.
    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, sessionId: 's1', reqId: 'r2' },
    );

    // Fire a stale turn-end for r1.
    const ctx = h.ctx({
      userId: 'userA',
      agentId: 'agt_a',
      conversationId: created.conversationId,
    });
    await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      reqId: 'r1',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'stale' }],
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.conversation.activeSessionId).toBe('s1');
    // CRITICAL: r2 must still be there. If the subscriber blindly cleared,
    // a second user message would lose its in-flight reqId between the
    // bind and the next runner emission.
    expect(got.conversation.activeReqId).toBe('r2');
  });

  it('chat:turn-end without ctx.conversationId is a no-op', async () => {
    // Defensive: the orchestrator (Task 16) sets ctx.conversationId, but
    // canary acceptance tests run without one. The subscriber MUST NOT
    // try to clear when there's no row to target.
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await h.bus.call<BindSessionInput, void>(
      'conversations:bind-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, sessionId: 's1', reqId: 'r1' },
    );

    // ctx WITHOUT conversationId.
    const ctx = h.ctx({ userId: 'userA', agentId: 'agt_a' });
    await h.bus.fire('chat:turn-end', ctx, {
      reqId: 'r1',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'no conv ctx' }],
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    // Both fields untouched.
    expect(got.conversation.activeSessionId).toBe('s1');
    expect(got.conversation.activeReqId).toBe('r1');
  });

  it('bind-session rejects empty / missing string fields', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    await expect(
      h.bus.call<BindSessionInput, void>(
        'conversations:bind-session',
        h.ctx({ userId: 'userA' }),
        // sessionId empty
        { conversationId: created.conversationId, sessionId: '', reqId: 'r1' },
      ),
    ).rejects.toBeInstanceOf(PluginError);
  });
});
