import { describe, it, expect } from 'vitest';
import {
  HookBus,
  makeAgentContext,
  createLogger,
  type AgentMessage,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// ---------------------------------------------------------------------------
// Task 16 (Week 10–12, J6) — orchestrator routes by conversationId.
//
// When `ctx.conversationId` has a live `active_session_id`, agent:invoke must
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
  /**
   * Captured `sandbox:open-session` input on each call. Tests that need to
   * assert the orchestrator forwarded `ctx.conversationId` into
   * `owner.conversationId` read from here.
   */
  openSessionInputs: unknown[];
  queueWork: Array<{ sessionId: string; reqId: string; payload: AgentMessage }>;
  bindSession: Array<{ conversationId: string; sessionId: string; reqId: string }>;
  conversationsGet: number;
  isAlive: Array<{ sessionId: string; result: boolean }>;
  /** TASK-66: captured `conversations:append-event` inputs (user-turn persist). */
  appendEvent: unknown[];
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
    openSessionInputs: [],
    queueWork: [],
    bindSession: [],
    conversationsGet: 0,
    isAlive: [],
    appendEvent: [],
  };

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
    'session:queue-work': async (_ctx, input: unknown) => {
      const i = input as {
        sessionId: string;
        entry: { type: string; payload?: AgentMessage; reqId?: string };
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
        // that exercise this path can subscribe to agent:invoke and assert the
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
    // TASK-66: the orchestrator persists the user display turn here.
    'conversations:append-event': async (_ctx, input: unknown) => {
      trace.appendEvent.push(input);
      return undefined;
    },
    'sandbox:open-session': async (ctx, input: unknown) => {
      trace.sandboxOpen += 1;
      trace.openSessionInputs.push(input);
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
    // Phase 6: credential-proxy is mandatory. Stub the proxy hooks so the
    // orchestrator's `proxy-not-loaded` gate (Task 8) doesn't short-circuit
    // these route-by-conversationId scenarios, which only care about the
    // routing decision — not the proxy lifecycle.
    'proxy:open-session': async () => ({
      proxyEndpoint: 'tcp://127.0.0.1:54321',
      caCertPem: 'TEST-CA-PEM',
      envMap: {},
    }),
    'proxy:close-session': async () => ({}),
  };

  return { trace, services };
}

function ctxWith(opts: {
  sessionId?: string;
  conversationId?: string;
  reqId?: string;
}) {
  return makeAgentContext({
    sessionId: opts.sessionId ?? 'fresh-session',
    agentId: 'test-agent',
    userId: 'test-user',
    ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
    ...(opts.reqId !== undefined ? { reqId: opts.reqId } : {}),
    logger: createLogger({ reqId: 'orch-test', writer: () => undefined }),
  });
}

// Fires chat:end on the bus immediately so the orchestrator's deferred
// resolves. Used in scenarios where we want the agent:invoke to return
// quickly without exercising the timeout path.
//
// The waiter map is keyed by ctx.reqId (server-minted, unique per
// agent:invoke), so the chat:end fire MUST carry the originating agent:invoke's
// reqId — otherwise onChatEnd's lookup misses and the deferred only
// resolves on timeout.
function arrangeImmediateEnd(
  bus: HookBus,
  expected: AgentOutcome,
  forSessionId: string,
  forReqId: string,
): void {
  setImmediate(() => {
    void bus.fire(
      'chat:end',
      makeAgentContext({
        sessionId: forSessionId,
        agentId: 'a',
        userId: 'u',
        reqId: forReqId,
        logger: createLogger({ reqId: forReqId, writer: () => undefined }),
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

    const expected: AgentOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 'fresh-session', 'req-1');

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxWith({ sessionId: 'fresh-session', reqId: 'req-1' }),
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
    // No ctx.conversationId → owner.conversationId is omitted (not null,
    // not empty string) so non-orchestrator callers and pre-Week-10
    // sessions stay structurally identical to before.
    const openInput = mocks.trace.openSessionInputs[0] as {
      owner: { conversationId?: unknown };
    };
    expect(openInput.owner.conversationId).toBeUndefined();
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

    const expected: AgentOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-fresh', 'req-A');

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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
    // ctx.conversationId is forwarded into sandbox:open-session.owner so
    // the v2 row's conversation_id column is written atomically with
    // session:create. Without this forwarding, the runner reads
    // conversationId=null from session:get-config, never calls
    // conversation.store-runner-session, and resume-on-second-turn fails
    // (regression: runner-owned-sessions-k8s-gap.test.ts:137).
    const openInput = mocks.trace.openSessionInputs[0] as {
      owner: { conversationId?: string };
    };
    expect(openInput.owner.conversationId).toBe('conv-1');
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

    const expected: AgentOutcome = {
      kind: 'complete',
      messages: [{ role: 'assistant', content: 'reuse-reply' }],
    };
    // The runner (already alive) emits chat:end on its existing sessionId.
    arrangeImmediateEnd(h.bus, expected, 's-existing', 'req-B');

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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

  // TASK-112 (Bug 2) — a connector draft proposed mid-turn must be carded on the
  // NEXT (warm-resume) turn. The routed/warm branch returns BEFORE the fresh-spawn
  // connector-card block, so before this fix a pending draft on a live session was
  // never carded (it surfaced a reactive egress wall instead). Assert the warm
  // path fires ONE kind:'connector' chat:permission-request.
  it('TASK-112: a pending connector draft fires ONE connector card on the WARM/routed path', async () => {
    const mocks = buildMocks({
      conversations: { 'conv-w': { activeSessionId: 's-warm' } },
      liveSessions: new Set(['s-warm']),
    });
    Object.assign(mocks.services, {
      'connectors:list-authored': async () => ({
        drafts: [
          {
            connectorId: 'linear',
            name: 'Linear',
            usageNote: '',
            keyMode: 'personal',
            status: 'pending',
            proposal: {
              allowedHosts: ['api.linear.app'],
              credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
              mcpServers: [],
              packages: { npm: [], pypi: [] },
            },
          },
        ],
      }),
    } satisfies Record<string, ServiceHandler>);

    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });

    const cards: Array<Record<string, unknown>> = [];
    h.bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      if ((p as { kind?: string }).kind === 'connector') cards.push(p as Record<string, unknown>);
      return undefined;
    });

    const expected: AgentOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-warm', 'req-W');

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxWith({ sessionId: 'unused', conversationId: 'conv-w', reqId: 'req-W' }),
      { message: { role: 'user', content: 'follow-up' } },
    );

    // Routed warm path — NO fresh sandbox, yet the connector card still fired.
    expect(mocks.trace.sandboxOpen).toBe(0);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: 'connector',
      connectorId: 'linear',
      name: 'Linear',
      hosts: ['api.linear.app'],
    });
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

    const expected: AgentOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-fresh-2', 'req-C');

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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
    // Stale-session path also spawns a fresh sandbox — conversationId
    // must be forwarded just like the no-active-session path (scenario 2).
    // Without this, a regression on the stale branch would silently drop
    // conversationId and break runner-side bind on the recovered session.
    const openInput = mocks.trace.openSessionInputs[0] as {
      owner: { conversationId?: string };
    };
    expect(openInput.owner.conversationId).toBe('conv-3');
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

    const expected: AgentOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-r', 'req-NEW');

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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

    const expected: AgentOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-flaky', 'req-X');

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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

    const expected: AgentOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-fallback', 'req-fb');

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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

  it('two concurrent agent:invoke on same conversation each receive their own outcome (waiter map keyed by reqId, not sessionId)', async () => {
    // Regression: when two agent:invokes hit the same conversation while a
    // sandbox is alive, both routed branches register waiters on the
    // SAME sessionId. A sessionId-keyed map would let the second
    // agent:invoke overwrite the first — first request times out, second
    // resolves with the wrong outcome. Re-keying by ctx.reqId fixes it.
    const mocks = buildMocks({
      conversations: { 'conv-cc': { activeSessionId: 's-cc' } },
      liveSessions: new Set(['s-cc']),
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 1_000,
        }),
      ],
    });

    const outcomeR1: AgentOutcome = {
      kind: 'complete',
      messages: [{ role: 'assistant', content: 'reply-r1' }],
    };
    const outcomeR2: AgentOutcome = {
      kind: 'complete',
      messages: [{ role: 'assistant', content: 'reply-r2' }],
    };

    // Fire chat:end for r1 first, then r2 — each carrying its own reqId.
    setImmediate(() => {
      void h.bus.fire(
        'chat:end',
        makeAgentContext({
          sessionId: 's-cc',
          agentId: 'a',
          userId: 'u',
          reqId: 'r1',
          logger: createLogger({ reqId: 'r1', writer: () => undefined }),
        }),
        { outcome: outcomeR1 },
      );
      void h.bus.fire(
        'chat:end',
        makeAgentContext({
          sessionId: 's-cc',
          agentId: 'a',
          userId: 'u',
          reqId: 'r2',
          logger: createLogger({ reqId: 'r2', writer: () => undefined }),
        }),
        { outcome: outcomeR2 },
      );
    });

    const [resA, resB] = await Promise.all([
      h.bus.call<unknown, AgentOutcome>(
        'agent:invoke',
        ctxWith({
          sessionId: 'unused-A',
          conversationId: 'conv-cc',
          reqId: 'r1',
        }),
        { message: { role: 'user', content: 'msg-1' } },
      ),
      h.bus.call<unknown, AgentOutcome>(
        'agent:invoke',
        ctxWith({
          sessionId: 'unused-B',
          conversationId: 'conv-cc',
          reqId: 'r2',
        }),
        { message: { role: 'user', content: 'msg-2' } },
      ),
    ]);

    // Each agent:invoke resolved with its OWN outcome — no cross-contamination.
    expect(resA).toEqual(outcomeR1);
    expect(resB).toEqual(outcomeR2);
    // Both routed to the SAME existing sandbox (no fresh open).
    expect(mocks.trace.sandboxOpen).toBe(0);
    expect(mocks.trace.queueWork).toHaveLength(2);
    expect(mocks.trace.queueWork[0]!.sessionId).toBe('s-cc');
    expect(mocks.trace.queueWork[1]!.sessionId).toBe('s-cc');
  });

  // TASK-66 (out-of-git Part B / B1): the orchestrator persists the USER turn
  // into the display event log host-side (the runner only ships tool/assistant
  // turn-ends; a runner-side user turn-end would trip the host's turn-end side
  // effects). Verify conversations:append-event is called once with the user's
  // text + attachment blocks, and that a conversationId-less invoke does not.
  it('TASK-66) persists the user turn via conversations:append-event (text + attachment blocks)', async () => {
    const mocks = buildMocks({
      conversations: { 'conv-u': { activeSessionId: null } },
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

    const expected: AgentOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 's-u', 'req-u');

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxWith({ sessionId: 's-u', conversationId: 'conv-u', reqId: 'req-u' }),
      {
        message: {
          role: 'user',
          content: 'summarize this',
          contentBlocks: [
            {
              type: 'attachment',
              path: '.ax/uploads/conv-u/t1/report.pdf',
              displayName: 'report.pdf',
              mediaType: 'application/pdf',
              sizeBytes: 10,
            },
          ],
        },
      },
    );

    expect(mocks.trace.appendEvent).toHaveLength(1);
    expect(mocks.trace.appendEvent[0]).toMatchObject({
      conversationId: 'conv-u',
      kind: 'turn',
      role: 'user',
      payload: {
        blocks: [
          { type: 'text', text: 'summarize this' },
          {
            type: 'attachment',
            path: '.ax/uploads/conv-u/t1/report.pdf',
            displayName: 'report.pdf',
          },
        ],
      },
    });
  });

  it('TASK-66) does NOT persist a user turn when ctx.conversationId is unset', async () => {
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
    const expected: AgentOutcome = { kind: 'complete', messages: [] };
    arrangeImmediateEnd(h.bus, expected, 'fresh-session', 'req-n');

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxWith({ sessionId: 'fresh-session', reqId: 'req-n' }),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(mocks.trace.appendEvent).toHaveLength(0);
  });
});
