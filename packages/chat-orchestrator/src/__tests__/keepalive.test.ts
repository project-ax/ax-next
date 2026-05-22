import { describe, it, expect, vi } from 'vitest';
import {
  HookBus, makeAgentContext, createLogger,
  type AgentOutcome, type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

const TEST_AGENT = {
  id: 'test-agent', ownerId: 'test-user', ownerType: 'user' as const,
  visibility: 'personal' as const, displayName: 'Test', systemPrompt: 'be helpful',
  allowedTools: ['file.read'], mcpConfigIds: [], model: 'claude-sonnet-4-7', workspaceRef: null,
};

// A controllable warm sandbox: kill() flips a flag + resolves exited.
function makeHandle() {
  let resolveExit!: () => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    resolveExit = () => res({ code: 0, signal: null });
  });
  const state = { kills: 0 };
  return {
    state,
    handle: {
      kill: async () => { state.kills += 1; resolveExit(); },
      exited,
    },
    forceExit: () => resolveExit(),
  };
}

function ctxWith(o: { sessionId: string; conversationId?: string; reqId: string }) {
  return makeAgentContext({
    sessionId: o.sessionId, agentId: 'test-agent', userId: 'test-user',
    ...(o.conversationId !== undefined ? { conversationId: o.conversationId } : {}),
    reqId: o.reqId,
    logger: createLogger({ reqId: o.reqId, writer: () => undefined }),
  });
}

// Fire chat:turn-end carrying the originating reqId (the runner stamps it).
function fireTurnEnd(bus: HookBus, sessionId: string, reqId: string) {
  setImmediate(() => {
    void bus.fire('chat:turn-end',
      makeAgentContext({ sessionId, agentId: 'a', userId: 'u', reqId: 'ipc-fresh',
        logger: createLogger({ reqId: 'ipc-fresh', writer: () => undefined }) }),
      { reason: 'user-message-wait', reqId });
  });
}

describe('chat-orchestrator keepalive', () => {
  it('keepalive: turn resolves on turn-end, runner left warm, 2nd turn reuses (no 2nd open, no kill)', async () => {
    const conv: Record<string, { activeSessionId: string | null }> = {
      'conv-1': { activeSessionId: null },
    };
    const live = new Set<string>();
    const hk = makeHandle();
    let opens = 0;
    const queued: Array<{ sessionId: string; type: string }> = [];

    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
      'session:queue-work': async (_c, input: unknown) => {
        const i = input as { sessionId: string; entry: { type: string } };
        queued.push({ sessionId: i.sessionId, type: i.entry.type });
        return { cursor: 0 };
      },
      'session:terminate': async () => ({}),
      'session:is-alive': async (_c, input: unknown) => ({
        alive: live.has((input as { sessionId: string }).sessionId),
      }),
      'conversations:get': async (_c, input: unknown) => {
        const i = input as { conversationId: string; userId: string };
        return { conversation: {
          conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent',
          activeSessionId: conv[i.conversationId]!.activeSessionId, activeReqId: null,
        } };
      },
      'conversations:bind-session': async (_c, input: unknown) => {
        const i = input as { sessionId: string };
        conv['conv-1']!.activeSessionId = i.sessionId; // simulate the row write
        live.add(i.sessionId);                          // and mark it alive
        return undefined;
      },
      'sandbox:open-session': async () => {
        opens += 1;
        return { runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle };
      },
      'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {} }),
      'proxy:close-session': async () => ({}),
    };

    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({
        runnerBinary: '/irrelevant', chatTimeoutMs: 5_000,
        keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000,
      })],
    });

    // Turn 1 — fresh spawn, resolves on turn-end.
    fireTurnEnd(h.bus, 's-1', 'req-1');
    const out1 = await h.bus.call<unknown, AgentOutcome>('agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-1' }),
      { message: { role: 'user', content: 'hi' } });
    expect(out1).toEqual({ kind: 'complete', messages: [] });
    expect(opens).toBe(1);
    expect(hk.state.kills).toBe(0);                 // NOT killed at turn end
    expect(queued.filter((q) => q.type === 'cancel')).toHaveLength(0); // NO one-shot cancel

    // Turn 2 — same conversation, session alive → routed, no new open, still warm.
    fireTurnEnd(h.bus, 's-1', 'req-2');
    const out2 = await h.bus.call<unknown, AgentOutcome>('agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-2' }),
      { message: { role: 'user', content: 'again' } });
    expect(out2).toEqual({ kind: 'complete', messages: [] });
    expect(opens).toBe(1);                          // reused — no second pod
    expect(hk.state.kills).toBe(0);
  });

  it('keepalive idle reaper: queues a graceful cancel, then force-kills after grace', async () => {
    vi.useFakeTimers();
    try {
      const live = new Set<string>(['s-1']);
      const hk = makeHandle();
      const queued: Array<{ sessionId: string; type: string }> = [];
      const services: Record<string, ServiceHandler> = {
        'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
        'session:queue-work': async (_c, input: unknown) => {
          const i = input as { sessionId: string; entry: { type: string } };
          queued.push({ sessionId: i.sessionId, type: i.entry.type });
          return { cursor: 0 };
        },
        'session:terminate': async () => ({}),
        'session:is-alive': async (_c, input: unknown) => ({ alive: live.has((input as { sessionId: string }).sessionId) }),
        'conversations:get': async (_c, input: unknown) => {
          const i = input as { conversationId: string; userId: string };
          return { conversation: { conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent', activeSessionId: null, activeReqId: null } };
        },
        'conversations:bind-session': async () => undefined,
        'sandbox:open-session': async () => ({ runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle }),
        'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {} }),
        'proxy:close-session': async () => ({}),
      };
      const h = await createTestHarness({
        services,
        plugins: [createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant', chatTimeoutMs: 5_000,
          keepAlive: true, idleWindowMs: 1_000, idleGraceMs: 500,
        })],
      });

      // ORDERING (important — differs from a naive write): start the invoke
      // FIRST so the spawn completes and the warm session is registered, THEN
      // deliver the turn-end so armReapTimer finds the warm entry to arm.
      // Microtasks (the spawn's awaits) drain before the setImmediate macrotask
      // (the turn-end), so by the time turn-end fires the warm session exists.
      const p = h.bus.call<unknown, AgentOutcome>('agent:invoke',
        ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-1' }),
        { message: { role: 'user', content: 'hi' } });
      fireTurnEnd(h.bus, 's-1', 'req-1');
      await vi.advanceTimersByTimeAsync(0); // drain spawn, then run the turn-end immediate → arm reaper
      await p;

      expect(queued.filter((q) => q.type === 'cancel')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);      // idle window elapses → graceful cancel
      expect(queued.filter((q) => q.type === 'cancel')).toHaveLength(1);
      expect(hk.state.kills).toBe(0);
      await vi.advanceTimersByTimeAsync(500);        // grace elapses → force kill
      expect(hk.state.kills).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
