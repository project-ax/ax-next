import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  BindSessionInput,
  CreateInput,
  CreateOutput,
  DeleteInput,
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
  if (container) await stopPostgresContainer(container);
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

  // TASK-785 — r2 was sent while r1's reply ran and the model folded it into
  // r1's turn. r2 is the bound active_req_id, but no turn-end will ever name
  // it: r1's turn-end lists it in `foldedReqIds`. Left set, a reload would
  // reattach to r2's stream, which never ends.
  it('chat:turn-end clears an active_req_id it lists in foldedReqIds', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    for (const reqId of ['r1', 'r2']) {
      await h.bus.call<BindSessionInput, void>(
        'conversations:bind-session',
        h.ctx({ userId: 'userA' }),
        { conversationId: created.conversationId, sessionId: 's1', reqId },
      );
    }
    const ctx = h.ctx({ userId: 'userA', agentId: 'agt_a', conversationId: created.conversationId });
    const get = () =>
      h.bus.call<GetInput, GetOutput>(
        'conversations:get',
        h.ctx({ userId: 'userA' }),
        { conversationId: created.conversationId, userId: 'userA' },
      );

    // A list that does not name the bound id, or is malformed (runner-written,
    // so untrusted), clears nothing — compare-and-clear holds.
    await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait', reqId: 'r1', role: 'tool', foldedReqIds: ['r9'],
    });
    await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait', reqId: 'r1', role: 'tool', foldedReqIds: 'r2',
    });
    expect((await get()).conversation.activeReqId).toBe('r2');

    await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait', reqId: 'r1', role: 'assistant', foldedReqIds: ['r2'],
    });
    const got = await get();
    expect(got.conversation.activeReqId).toBeNull();
    expect(got.conversation.activeSessionId).toBe('s1');
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

  // TASK-1226 — a late bind (a services restart's rebinds, a cold spawn's
  // bind after a long open) must not take the row back from a newer request
  // that bound its own session in the meantime. `expectedSessionId` makes the
  // bind a strict compare-and-set on the bound session.
  describe('bind-session with expectedSessionId (TASK-1226)', () => {
    async function boundConversation(h: TestHarness): Promise<string> {
      const created = await h.bus.call<CreateInput, CreateOutput>(
        'conversations:create',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', agentId: 'agt_a' },
      );
      await h.bus.call<BindSessionInput, void>(
        'conversations:bind-session',
        h.ctx({ userId: 'userA' }),
        {
          conversationId: created.conversationId,
          sessionId: 'sess-current',
          reqId: 'r1',
        },
      );
      return created.conversationId;
    }

    async function active(
      h: TestHarness,
      conversationId: string,
    ): Promise<{ sessionId: string | null; reqId: string | null }> {
      const got = await h.bus.call<GetInput, GetOutput>(
        'conversations:get',
        h.ctx({ userId: 'userA' }),
        { conversationId, userId: 'userA' },
      );
      return {
        sessionId: got.conversation.activeSessionId,
        reqId: got.conversation.activeReqId,
      };
    }

    it('bind-session with a stale expectedSessionId throws conflict and leaves the row alone', async () => {
      const h = await makeHarness();
      const conversationId = await boundConversation(h);

      // A different session, and "no session bound": both are stale now.
      for (const expectedSessionId of ['s0', null]) {
        const err = await h.bus
          .call<BindSessionInput, void>(
            'conversations:bind-session',
            h.ctx({ userId: 'userA' }),
            { conversationId, sessionId: 's2', reqId: 'r2', expectedSessionId },
          )
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(err).toMatchObject({
          code: 'conflict',
          plugin: '@ax/conversations',
          hookName: 'conversations:bind-session',
        });
        // Whose session holds the row is not the caller's to learn here.
        expect(String((err as Error).message)).not.toContain('sess-current');
      }

      expect(await active(h, conversationId)).toEqual({
        sessionId: 'sess-current',
        reqId: 'r1',
      });
    });

    it('bind-session with expectedSessionId binds when the row still names it', async () => {
      const h = await makeHarness();
      const conversationId = await boundConversation(h);

      await h.bus.call<BindSessionInput, void>(
        'conversations:bind-session',
        h.ctx({ userId: 'userA' }),
        {
          conversationId,
          sessionId: 's2',
          reqId: 'r2',
          expectedSessionId: 'sess-current',
        },
      );

      expect(await active(h, conversationId)).toEqual({
        sessionId: 's2',
        reqId: 'r2',
      });
    });

    it('bind-session with expectedSessionId: null binds an unbound row', async () => {
      const h = await makeHarness();
      const created = await h.bus.call<CreateInput, CreateOutput>(
        'conversations:create',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', agentId: 'agt_a' },
      );

      await h.bus.call<BindSessionInput, void>(
        'conversations:bind-session',
        h.ctx({ userId: 'userA' }),
        {
          conversationId: created.conversationId,
          sessionId: 's2',
          reqId: 'r2',
          expectedSessionId: null,
        },
      );

      expect(await active(h, created.conversationId)).toEqual({
        sessionId: 's2',
        reqId: 'r2',
      });
    });

    it('bind-session with expectedSessionId on a foreign row is not-found, not conflict', async () => {
      const h = await makeHarness();
      const conversationId = await boundConversation(h);

      // Both a matching and a non-matching expectation: userB learns nothing
      // about userA's row either way.
      for (const expectedSessionId of ['sess-current', 's0', null]) {
        await expect(
          h.bus.call<BindSessionInput, void>(
            'conversations:bind-session',
            h.ctx({ userId: 'userB' }),
            { conversationId, sessionId: 's2', reqId: 'r2', expectedSessionId },
          ),
        ).rejects.toMatchObject({
          code: 'not-found',
          plugin: '@ax/conversations',
        });
      }

      expect(await active(h, conversationId)).toEqual({
        sessionId: 'sess-current',
        reqId: 'r1',
      });
    });

    it('bind-session with expectedSessionId on a deleted row is not-found, not conflict', async () => {
      const h = await makeHarness();
      const conversationId = await boundConversation(h);
      await h.bus.call<DeleteInput, void>(
        'conversations:delete',
        h.ctx({ userId: 'userA' }),
        { conversationId, userId: 'userA' },
      );

      for (const expectedSessionId of ['sess-current', 's0', null]) {
        await expect(
          h.bus.call<BindSessionInput, void>(
            'conversations:bind-session',
            h.ctx({ userId: 'userA' }),
            { conversationId, sessionId: 's2', reqId: 'r2', expectedSessionId },
          ),
        ).rejects.toMatchObject({
          code: 'not-found',
          plugin: '@ax/conversations',
        });
      }
    });

    it('bind-session rejects an empty or oversized expectedSessionId', async () => {
      const h = await makeHarness();
      const conversationId = await boundConversation(h);

      for (const expectedSessionId of ['', 'x'.repeat(257), 7]) {
        await expect(
          h.bus.call<BindSessionInput, void>(
            'conversations:bind-session',
            h.ctx({ userId: 'userA' }),
            {
              conversationId,
              sessionId: 's2',
              reqId: 'r2',
              expectedSessionId: expectedSessionId as string,
            },
          ),
        ).rejects.toMatchObject({
          code: 'invalid-payload',
          plugin: '@ax/conversations',
        });
      }

      expect(await active(h, conversationId)).toEqual({
        sessionId: 'sess-current',
        reqId: 'r1',
      });
    });
  });
});
