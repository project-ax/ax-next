import { describe, it, expect } from 'vitest';
import {
  HookBus,
  makeChatContext,
  createLogger,
  type ChatMessage,
  type ChatOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// ---------------------------------------------------------------------------
// Task 16 (Week 10–12, J6) — orchestrator routes by conversationId.
//
// When `ctx.conversationId` has a live `active_session_id`, chat:run must
// enqueue into THAT session's inbox via `session:queue-work` rather than
// opening a fresh sandbox. On a fresh-session path (or stale active id),
// the orchestrator opens a new sandbox AND binds the conversation row via
// `conversations:bind-session`.
//
// Five scenarios:
//   1. ctx.conversationId unset → existing fresh-sandbox flow; no
//      conversations:* calls.
//   2. ctx.conversationId set, conversation has NO active_session_id →
//      fresh sandbox + bind.
//   3. ctx.conversationId set, active_session_id alive → route to existing
//      inbox; sandbox:open-session NOT called; bind updates the reqId.
//   4. ctx.conversationId set, active_session_id stale (is-alive=false) →
//      fresh sandbox + bind.
//   5. session:queue-work on the routed path enqueues with the correct
//      reqId.
//
// All scenarios stub agents:resolve / sandbox / session / conversations
// peers via the harness. No real runner subprocess.
// ---------------------------------------------------------------------------

const TEST_AGENT = {
  id: 'test-agent',
  ownerId: 'test-user',
  ownerType: 'user' as const,
  visibility: 'personal' as const,
  displayName: 'Test',
  systemPrompt: 'be helpful',
  allowedTools: ['file.read'],
  mcpConfigIds: [],
  model: 'claude-sonnet-4-7',
  workspaceRef: null,
};

interface CallTrace {
  sandboxOpen: number;
  queueWork: Array<{ sessionId: string; reqId: string; payload: ChatMessage }>;
  bindSession: Array<{ conversationId: string; sessionId: string; reqId: string }>;
  conversationsGet: number;
  isAlive: Array<{ sessionId: string; result: boolean }>;
}

interface BuiltMocks {
  trace: CallTrace;
  services: Record<string, ServiceHandler>;
}

// One mock conversation row keyed by conversationId. Tests pre-populate
// the active_session_id (or null) to simulate the four scenarios. The
// session-alive map decides what session:is-alive returns for each
// candidate sessionId — defaults to "alive iff present in liveSessions".
function buildMocks(opts: {
  /** conversationId → active_session_id (or null). */
  conversations: Record<string, { activeSessionId: string | null }>;
  /** sessionIds that session:is-alive should return alive=true for. */
  liveSessions: Set<string>;
  /** Optional override: when set, sandbox:open-session uses this fn. */
  openSession?: ServiceHandler;
}): BuiltMocks {
  const trace: CallTrace = {
    sandboxOpen: 0,
    queueWork: [],
    bindSession: [],
    conversationsGet: 0,
    isAlive: [],
  };

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
    'session:queue-work': async (_ctx, input: unknown) => {
      const i = input as {
        sessionId: string;
        entry: { type: string; payload?: ChatMessage; reqId?: string };
      };
      if (i.entry.type === 'user-message') {
        trace.queueWork.push({
          sessionId: i.sessionId,
          reqId: i.entry.reqId ?? '',
          payload: i.entry.payload!,
        });
      }
      return { cursor: 0 };
    },
    'session:terminate': async () => ({}),
    'session:is-alive': async (_ctx, input: unknown) => {
      const sessionId = (input as { sessionId: string }).sessionId;
      const alive = opts.liveSessions.has(sessionId);
      trace.isAlive.push({ sessionId, result: alive });
      return { alive };
    },
    'conversations:get': async (_ctx, input: unknown) => {
      trace.conversationsGet += 1;
      const i = input as { conversationId: string; userId: string };
      const row = opts.conversations[i.conversationId];
      if (row === undefined) {
        // Match @ax/conversations behavior — not-found PluginError. Tests
        // that exercise this path can subscribe to chat:run and assert the
        // outcome.
        const { PluginError } = await import('@ax/core');
        throw new PluginError({
          code: 'not-found',
          plugin: '@ax/conversations',
          hookName: 'conversations:get',
          message: 'not found',
        });
      }
      return {
        conversation: {
          conversationId: i.conversationId,
          userId: i.userId,
          agentId: 'test-agent',
          activeSessionId: row.activeSessionId,
          activeReqId: null,
        },
      };
    },
    'conversations:bind-session': async (_ctx, input: unknown) => {
      const i = input as {
        conversationId: string;
        sessionId: string;
        reqId: string;
      };
      trace.bindSession.push({ ...i });
      return undefined;
    },
    'sandbox:open-session': async (ctx, input: unknown) => {
      trace.sandboxOpen += 1;
      if (opts.openSession !== undefined) {
        return opts.openSession(ctx, input);
      }
      return {
        runnerEndpoint: 'unix:///tmp/mock.sock',
        handle: {
          kill: async () => undefined,
          // Keep pending — tests resolve via firing chat:end on the bus.
          exited: new Promise(() => undefined),
        },
      };
    },
  };

  return { trace, services };
}

function ctxWith(opts: {
  sessionId?: string;
  conversationId?: string;
  reqId?: string;
}) {
  return makeChatContext({
    sessionId: opts.sessionId ?? 'fresh-session',
    agentId: 'test-agent',
    userId: 'test-user',
    ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
    ...(opts.reqId !== undefined ? { reqId: opts.reqId } : {}),
    logger: createLogger({ reqId: 'orch-test', writer: () => undefined }),
  });
}

// Fires chat:end on the bus immediately so the orchestrator's deferred
// resolves. Used in scenarios where we want the chat:run to return
// quickly without exercising the timeout path.
function arrangeImmediateEnd(
  bus: HookBus,
  expected: ChatOutcome,
  forSessionId: string,
): void {
  setImmediate(() => {
    void bus.fire(
      'chat:end',
      makeChatContext({
        sessionId: forSessionId,
        agentId: 'a',
        userId: 'u',
        logger: createLogger({ reqId: 'r', writer: () => undefined }),
      }),
      { outcome: expected },
    );
  });
}

describe('chat-orchestrator route-by-conversationId (Task 16, J6)', () => {
  it('1) ctx.conversationId unset → fresh sandbox, no conversations:* calls', async () => {
    const mocks = buildMocks({ conversations: {}, liveSessions: new Set() });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });

    const expected: ChatOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 'fresh-session');

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      ctxWith({ sessionId: 'fresh-session' }),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome).toEqual(expected);
    expect(mocks.trace.sandboxOpen).toBe(1);
    expect(mocks.trace.conversationsGet).toBe(0);
    expect(mocks.trace.bindSession).toHaveLength(0);
    expect(mocks.trace.isAlive).toHaveLength(0);
    // Single user-message enqueue with the request's reqId.
    expect(mocks.trace.queueWork).toHaveLength(1);
    expect(mocks.trace.queueWork[0]!.sessionId).toBe('fresh-session');
  });

  it('2) ctx.conversationId set, no active_session_id → fresh sandbox + bind', async () => {
    const mocks = buildMocks({
      conversations: { 'conv-1': { activeSessionId: null } },
      liveSessions: new Set(),
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });

    const expected: ChatOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-fresh');

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      ctxWith({
        sessionId: 's-fresh',
        conversationId: 'conv-1',
        reqId: 'req-A',
      }),
      { message: { role: 'user', content: 'hello' } },
    );
    expect(outcome).toEqual(expected);
    expect(mocks.trace.sandboxOpen).toBe(1);
    expect(mocks.trace.conversationsGet).toBe(1);
    // is-alive NOT called: the row had no candidate sessionId to probe.
    expect(mocks.trace.isAlive).toHaveLength(0);
    // bind-session called once with the fresh sessionId + reqId.
    expect(mocks.trace.bindSession).toEqual([
      { conversationId: 'conv-1', sessionId: 's-fresh', reqId: 'req-A' },
    ]);
    expect(mocks.trace.queueWork).toHaveLength(1);
    expect(mocks.trace.queueWork[0]!.sessionId).toBe('s-fresh');
    expect(mocks.trace.queueWork[0]!.reqId).toBe('req-A');
  });

  it('3) ctx.conversationId set, active_session_id alive → routes to existing inbox; no sandbox:open-session', async () => {
    const mocks = buildMocks({
      conversations: { 'conv-2': { activeSessionId: 's-existing' } },
      liveSessions: new Set(['s-existing']),
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });

    const expected: ChatOutcome = {
      kind: 'complete',
      messages: [{ role: 'assistant', content: 'reuse-reply' }],
    };
    // The runner (already alive) emits chat:end on its existing sessionId.
    arrangeImmediateEnd(h.bus, expected, 's-existing');

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      ctxWith({
        sessionId: 'fresh-but-unused',
        conversationId: 'conv-2',
        reqId: 'req-B',
      }),
      { message: { role: 'user', content: 'follow-up' } },
    );
    expect(outcome).toEqual(expected);
    // J6: NO new sandbox spawned.
    expect(mocks.trace.sandboxOpen).toBe(0);
    expect(mocks.trace.conversationsGet).toBe(1);
    // is-alive probed exactly the existing sessionId.
    expect(mocks.trace.isAlive).toEqual([
      { sessionId: 's-existing', result: true },
    ]);
    // bind-session updated the row's reqId; sessionId stays the same.
    expect(mocks.trace.bindSession).toEqual([
      { conversationId: 'conv-2', sessionId: 's-existing', reqId: 'req-B' },
    ]);
    // Enqueue went to the EXISTING session, with the new reqId.
    expect(mocks.trace.queueWork).toEqual([
      {
        sessionId: 's-existing',
        reqId: 'req-B',
        payload: { role: 'user', content: 'follow-up' },
      },
    ]);
  });

  it('4) ctx.conversationId set, active_session_id stale (is-alive=false) → fresh sandbox + bind', async () => {
    const mocks = buildMocks({
      conversations: { 'conv-3': { activeSessionId: 's-stale' } },
      // s-stale is NOT in liveSessions → is-alive returns false.
      liveSessions: new Set(),
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });

    const expected: ChatOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-fresh-2');

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      ctxWith({
        sessionId: 's-fresh-2',
        conversationId: 'conv-3',
        reqId: 'req-C',
      }),
      { message: { role: 'user', content: 'hi after stale' } },
    );
    expect(outcome).toEqual(expected);
    // is-alive consulted; result false → fall through to fresh path.
    expect(mocks.trace.isAlive).toEqual([
      { sessionId: 's-stale', result: false },
    ]);
    expect(mocks.trace.sandboxOpen).toBe(1);
    // bind-session attaches the FRESH sessionId, replacing the stale one.
    expect(mocks.trace.bindSession).toEqual([
      { conversationId: 'conv-3', sessionId: 's-fresh-2', reqId: 'req-C' },
    ]);
    expect(mocks.trace.queueWork[0]!.sessionId).toBe('s-fresh-2');
  });

  it('5) routed path: session:queue-work carries the new reqId, not the original', async () => {
    // Belt-and-suspenders for J9 — the SSE handler keys off active_req_id,
    // and a stale reqId on the inbox entry would let chunks be misrouted
    // to a long-since-closed stream. This is a focused assertion on top of
    // scenario 3.
    const mocks = buildMocks({
      conversations: { 'conv-r': { activeSessionId: 's-r' } },
      liveSessions: new Set(['s-r']),
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });

    const expected: ChatOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-r');

    await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      ctxWith({
        sessionId: 'unused',
        conversationId: 'conv-r',
        reqId: 'req-NEW',
      }),
      { message: { role: 'user', content: 'two' } },
    );
    expect(mocks.trace.queueWork).toHaveLength(1);
    expect(mocks.trace.queueWork[0]!.reqId).toBe('req-NEW');
    expect(mocks.trace.queueWork[0]!.sessionId).toBe('s-r');
    expect(mocks.trace.bindSession[0]!.reqId).toBe('req-NEW');
  });

  it('routed path tolerates conversations:bind-session failure (best-effort)', async () => {
    // bind-session can race with a row delete or a session:terminate
    // subscriber that just cleared the row. The chat must still complete;
    // SSE-by-reqId may degrade but audit-log still sees one chat:end.
    const mocks = buildMocks({
      conversations: { 'conv-flaky': { activeSessionId: 's-flaky' } },
      liveSessions: new Set(['s-flaky']),
    });
    mocks.services['conversations:bind-session'] = async () => {
      throw new Error('bind boom');
    };
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });

    const expected: ChatOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-flaky');

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      ctxWith({
        sessionId: 'unused',
        conversationId: 'conv-flaky',
        reqId: 'req-X',
      }),
      { message: { role: 'user', content: 'still works' } },
    );
    expect(outcome).toEqual(expected);
    // The user message still landed on the existing inbox.
    expect(mocks.trace.queueWork).toHaveLength(1);
    expect(mocks.trace.queueWork[0]!.sessionId).toBe('s-flaky');
  });

  it('routed path: session:queue-work failure synthesizes terminated chat:end exactly once', async () => {
    let endFires = 0;
    const mocks = buildMocks({
      conversations: { 'conv-q': { activeSessionId: 's-q' } },
      liveSessions: new Set(['s-q']),
    });
    mocks.services['session:queue-work'] = async () => {
      throw new Error('queue boom');
    };
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 1_000,
        }),
      ],
    });
    h.bus.subscribe('chat:end', 'count', async () => {
      endFires += 1;
      return undefined;
    });

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      ctxWith({
        sessionId: 'unused',
        conversationId: 'conv-q',
        reqId: 'req-Q',
      }),
      { message: { role: 'user', content: 'will fail' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('queue-work-failed');
    }
    // chat:end fires exactly once (audit-log invariant).
    expect(endFires).toBe(1);
    // No sandbox was opened on the routed path.
    expect(mocks.trace.sandboxOpen).toBe(0);
  });

  it('lookup failure (conversations:get throws something other than not-found) falls through to fresh sandbox', async () => {
    const mocks = buildMocks({ conversations: {}, liveSessions: new Set() });
    // Override conversations:get to blow up unexpectedly.
    mocks.services['conversations:get'] = async () => {
      throw new Error('db unreachable');
    };
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });

    const expected: ChatOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-fallback');

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      ctxWith({
        sessionId: 's-fallback',
        conversationId: 'conv-broken',
        reqId: 'req-fb',
      }),
      { message: { role: 'user', content: 'fallback' } },
    );
    expect(outcome).toEqual(expected);
    // Fresh sandbox was opened despite the lookup failure.
    expect(mocks.trace.sandboxOpen).toBe(1);
    // Bind STILL attempted on the fresh path (and succeeds on the mock).
    expect(mocks.trace.bindSession).toEqual([
      { conversationId: 'conv-broken', sessionId: 's-fallback', reqId: 'req-fb' },
    ]);
  });
});
