import { describe, it, expect, vi } from 'vitest';
import {
  HookBus, makeAgentContext, createLogger,
  type AgentOutcome, type ServiceHandler,
} from '@ax/core';
import { createTestHarness, TEST_PROXY_AUTH_TOKEN } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

const TEST_AGENT = {
  id: 'test-agent', ownerId: 'test-user', ownerType: 'user' as const,
  visibility: 'personal' as const, displayName: 'Test',
  allowedTools: ['file.read'], mcpConfigIds: [], model: 'anthropic/claude-sonnet-4-7',
  runner: 'claude-sdk', workspaceRef: null,
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
      'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
      'proxy:close-session': async () => ({}),
    };

    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000,
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

  it('keepalive: a terminated turn (timeout) kills the runner instead of stranding it warm', async () => {
    vi.useFakeTimers();
    try {
      const hk = makeHandle();
      const services: Record<string, ServiceHandler> = {
        'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
        'session:queue-work': async () => ({ cursor: 0 }),
        'session:terminate': async () => ({}),
        'session:is-alive': async () => ({ alive: false }),
        'conversations:get': async (_c, input: unknown) => {
          const i = input as { conversationId: string; userId: string };
          return { conversation: { conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent', activeSessionId: null, activeReqId: null } };
        },
        'conversations:bind-session': async () => undefined,
        'sandbox:open-session': async () => ({ runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle }),
        'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
        'proxy:close-session': async () => ({}),
      };
      const h = await createTestHarness({
        services,
        plugins: [createChatOrchestratorPlugin({
          runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 1_000,
          keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000,
        })],
      });

      // No chat:turn-end is fired → the turn times out (terminated outcome).
      // A terminated keepalive turn never armed the idle reaper, so the
      // orchestrator must kill the handle here rather than leave it warm.
      const p = h.bus.call<unknown, AgentOutcome>('agent:invoke',
        ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-1' }),
        { message: { role: 'user', content: 'hi' } });
      await vi.advanceTimersByTimeAsync(0);      // drain the spawn
      await vi.advanceTimersByTimeAsync(1_000);  // chat timeout elapses
      const out = await p;

      expect(out.kind).toBe('terminated');
      expect(hk.state.kills).toBe(1);            // killed, NOT stranded warm
    } finally {
      vi.useRealTimers();
    }
  });

  it('keepalive: credential rotation keeps firing on the 2nd warm turn (tracking survives the per-invoke finally)', async () => {
    // Agent with a refreshable (non-api-key) credential → the session is
    // flagged for proxy:rotate-session. The flag must outlive the first
    // agent:invoke's finally so subsequent turns on the SAME warm runner keep
    // rotating; clearing it per-invoke would disable rotation after turn 1.
    const ROTATING_AGENT = {
      ...TEST_AGENT,
      allowedHosts: ['api.example.com'],
      requiredCredentials: { TOKEN: { ref: 'oauth:foo', kind: 'oauth' } },
    };
    const conv: Record<string, { activeSessionId: string | null }> = {
      'conv-1': { activeSessionId: null },
    };
    const live = new Set<string>();
    const hk = makeHandle();
    const rotates: string[] = [];

    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({ agent: { ...ROTATING_AGENT } }),
      'session:queue-work': async () => ({ cursor: 0 }),
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
        conv['conv-1']!.activeSessionId = i.sessionId;
        live.add(i.sessionId);
        return undefined;
      },
      'sandbox:open-session': async () => ({ runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle }),
      'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
      'proxy:close-session': async () => ({}),
      'proxy:rotate-session': async (c: unknown) => {
        rotates.push((c as { sessionId: string }).sessionId);
        return { envMap: {} };
      },
    };

    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000,
        keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000,
      })],
    });

    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    // Turn 1 — fresh spawn; onTurnEnd rotates once.
    fireTurnEnd(h.bus, 's-1', 'req-1');
    await h.bus.call<unknown, AgentOutcome>('agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-1' }),
      { message: { role: 'user', content: 'hi' } });
    await flush();
    expect(rotates).toHaveLength(1);

    // Turn 2 — routed into the warm session. TASK-860 re-resolves once at
    // routing (every warm session); the turn-end rotation must fire again too,
    // which is what proves the I10 flag outlived turn 1's finally.
    fireTurnEnd(h.bus, 's-1', 'req-2');
    await h.bus.call<unknown, AgentOutcome>('agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-2' }),
      { message: { role: 'user', content: 'again' } });
    await flush();
    // turn 1's turn-end + turn 2's routing + turn 2's turn-end. Without the
    // flag surviving turn 1's finally, the last is missing (2).
    expect(rotates).toHaveLength(3);
  });

  // TASK-783 — the warm path's deferred proxy close (on handle.exited) logs a
  // failure by name/code only, never the error's message.
  it('keepalive: a failed deferred proxy close logs name/code, never the message', async () => {
    const SECRET_TEXT = 'error_description=provider-text-that-must-not-be-logged';
    const conv: Record<string, { activeSessionId: string | null }> = { 'conv-1': { activeSessionId: null } };
    const hk = makeHandle();
    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
      'session:queue-work': async () => ({ cursor: 0 }),
      'session:terminate': async () => ({}),
      'session:is-alive': async () => ({ alive: false }),
      'conversations:get': async (_c, input: unknown) => {
        const i = input as { conversationId: string; userId: string };
        return { conversation: {
          conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent',
          activeSessionId: conv[i.conversationId]!.activeSessionId, activeReqId: null,
        } };
      },
      'conversations:bind-session': async () => undefined,
      'sandbox:open-session': async () => ({ runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle }),
      'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
      'proxy:close-session': async () => {
        throw new Error(SECRET_TEXT);
      },
    };
    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000,
        keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000,
      })],
    });
    const lines: Array<Record<string, unknown>> = [];
    const ctx = makeAgentContext({
      sessionId: 's-1', agentId: 'test-agent', userId: 'test-user', conversationId: 'conv-1', reqId: 'req-1',
      logger: createLogger({
        reqId: 'req-1',
        writer: (l: string) => lines.push(JSON.parse(l) as Record<string, unknown>),
      }),
    });
    fireTurnEnd(h.bus, 's-1', 'req-1');
    const outcome = await h.bus.call<unknown, AgentOutcome>('agent:invoke', ctx, {
      message: { role: 'user', content: 'hi' },
    });
    expect(outcome.kind).toBe('complete');
    // Warm: the close was deferred to the runner's exit.
    expect(lines.some((l) => l.msg === 'proxy_close_session_failed')).toBe(false);
    hk.forceExit();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const line = lines.find((l) => l.msg === 'proxy_close_session_failed');
    expect(line).toMatchObject({ sessionId: 's-1', name: 'PluginError', causeName: 'Error' });
    expect(line).not.toHaveProperty('err');
    expect(JSON.stringify(lines)).not.toContain(SECRET_TEXT);
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
        'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
        'proxy:close-session': async () => ({}),
      };
      const h = await createTestHarness({
        services,
        plugins: [createChatOrchestratorPlugin({
          runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000,
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


it('reopens a persisted conversation after host restart instead of routing into an unowned proxy session', async () => {
  const hdl=makeHandle();const queued:string[]=[];const terminated:string[]=[];let opens=0;
  const h=await createTestHarness({services:{
    'agents:resolve':async()=>({agent:{...TEST_AGENT}}),
    'conversations:get':async()=>({conversation:{conversationId:'restart-conversation',userId:'test-user',agentId:'test-agent',activeSessionId:'previous-host-session',activeReqId:null}}),
    'conversations:bind-session':async()=>undefined,
    'session:is-alive':async()=>({alive:true}),
    'session:terminate':async(_c,input)=>{terminated.push((input as {sessionId:string}).sessionId);return {};},
    'session:queue-work':async(_c,input)=>{queued.push((input as {sessionId:string}).sessionId);return {cursor:0};},
    'sandbox:open-session':async()=>{opens++;return {runnerEndpoint:'unix:///tmp/restart.sock',handle:hdl.handle};},
    'proxy:open-session':async()=>({proxyEndpoint:'tcp://127.0.0.1:1',caCertPem:'CA',envMap:{},proxyAuthToken:'a'.repeat(32)}),
    'proxy:close-session':async()=>({}),
  },plugins:[createChatOrchestratorPlugin({runnerBinaries:{'claude-sdk':'/runner'},keepAlive:true,chatTimeoutMs:100,idleWindowMs:60000})]});
  fireTurnEnd(h.bus,'new-host-session','restart-request');
  const out=await h.bus.call('agent:invoke',ctxWith({sessionId:'new-host-session',conversationId:'restart-conversation',reqId:'restart-request'}),{message:{role:'user',content:'continue'}});
  expect(out).toEqual({kind:'complete',messages:[]});expect(opens).toBe(1);expect(terminated).toContain('previous-host-session');expect(queued).not.toContain('previous-host-session');hdl.forceExit();
});

it('preserves the new stream binding while retiring the previous host session', async () => {
  const hdl = makeHandle();
  const conversation = { activeSessionId: 'previous-host-session' as string | null, activeReqId: 'restart-request' as string | null };
  let reqIdDuringTermination: string | null = null;
  let reqIdDuringOpen: string | null = null;
  const h = await createTestHarness({ services: {
    'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
    'conversations:get': async () => ({ conversation: { conversationId: 'restart-conversation', userId: 'test-user', agentId: 'test-agent', ...conversation } }),
    'conversations:bind-session': async (_c, input) => {
      const i = input as { sessionId: string; reqId: string };
      conversation.activeSessionId = i.sessionId; conversation.activeReqId = i.reqId;
    },
    'session:is-alive': async () => ({ alive: true }),
    'session:terminate': async (_c, input) => {
      // Match the real conversations subscriber's compare-and-clear behavior.
      if (conversation.activeSessionId === (input as { sessionId: string }).sessionId) {
        conversation.activeSessionId = null; conversation.activeReqId = null;
      }
      reqIdDuringTermination = conversation.activeReqId;
      return {};
    },
    'session:queue-work': async () => ({ cursor: 0 }),
    'sandbox:open-session': async () => {
      reqIdDuringOpen = conversation.activeReqId;
      return { runnerEndpoint: 'unix:///tmp/restart.sock', handle: hdl.handle };
    },
    'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
    'proxy:close-session': async () => ({}),
  }, plugins: [createChatOrchestratorPlugin({ runnerBinaries: { 'claude-sdk': '/runner' }, keepAlive: true, chatTimeoutMs: 100, idleWindowMs: 60000 })] });
  fireTurnEnd(h.bus, 'new-host-session', 'restart-request');
  await h.bus.call('agent:invoke', ctxWith({ sessionId: 'new-host-session', conversationId: 'restart-conversation', reqId: 'restart-request' }), { message: { role: 'user', content: 'continue' } });
  hdl.forceExit();
  expect(reqIdDuringTermination).toBe('restart-request');
  expect(reqIdDuringOpen).toBe('restart-request');
});

// TASK-811 — a connector attached to (or detached from) the agent mid-chat must
// reach that chat's WARM session on its next turn. The runner loads its MCP
// servers once, at spawn, so routing the next message into the old session
// would keep offering the old tool set. The orchestrator compares the agent
// row's connector selection (resolved fresh every turn) with the one the
// session spawned from, and retires the session at the turn boundary when
// they differ.
describe('TASK-811: connector attach/detach mid-chat reaches the warm session next turn', () => {
  type Selection = { connectorAttachments: string[]; connectorExclusions: string[] };

  async function twoTurns(before: Selection, after: Selection) {
    let agentRow: typeof TEST_AGENT & Selection = { ...TEST_AGENT, ...before };
    const conv = { activeSessionId: null as string | null };
    const live = new Set<string>();
    const handles = [makeHandle(), makeHandle()];
    let opens = 0;
    const queued: Array<{ sessionId: string; type: string }> = [];
    const terminated: string[] = [];
    const logs: Array<Record<string, unknown>> = [];

    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({ agent: { ...agentRow } }),
      'session:queue-work': async (_c, input: unknown) => {
        const i = input as { sessionId: string; entry: { type: string } };
        queued.push({ sessionId: i.sessionId, type: i.entry.type });
        return { cursor: 0 };
      },
      'session:terminate': async (_c, input: unknown) => {
        const sid = (input as { sessionId: string }).sessionId;
        terminated.push(sid);
        live.delete(sid);
        return {};
      },
      'session:is-alive': async (_c, input: unknown) => ({
        alive: live.has((input as { sessionId: string }).sessionId),
      }),
      'conversations:get': async (_c, input: unknown) => {
        const i = input as { conversationId: string; userId: string };
        return { conversation: {
          conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent',
          activeSessionId: conv.activeSessionId, activeReqId: null,
        } };
      },
      'conversations:bind-session': async (_c, input: unknown) => {
        const i = input as { sessionId: string };
        conv.activeSessionId = i.sessionId;
        live.add(i.sessionId);
        return undefined;
      },
      'sandbox:open-session': async () => {
        const hk = handles[opens]!;
        opens += 1;
        return { runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle };
      },
      // TASK-840 — #920 made proxyAuthToken required: an open without one is
      // refused before the sandbox opens, so no session would spawn at all.
      'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
      'proxy:close-session': async () => ({}),
    };

    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000,
        keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000,
      })],
    });

    const mkCtx = (sessionId: string, reqId: string) =>
      makeAgentContext({
        sessionId, agentId: 'test-agent', userId: 'test-user',
        conversationId: 'conv-1', reqId,
        logger: createLogger({
          reqId,
          writer: (line: string) => { logs.push(JSON.parse(line) as Record<string, unknown>); },
        }),
      });

    // Turn 1 — fresh spawn from the `before` selection.
    fireTurnEnd(h.bus, 's-1', 'req-1');
    await h.bus.call<unknown, AgentOutcome>('agent:invoke', mkCtx('s-1', 'req-1'),
      { message: { role: 'user', content: 'hi' } });
    expect(opens).toBe(1);

    // Between turns the person attaches / detaches a connector.
    agentRow = { ...TEST_AGENT, ...after };

    // Turn 2 — same conversation, new request session id (as the channel
    // stamps it). The orchestrator either routes into the warm s-1 or retires
    // it and spawns s-2; the turn-end lands for whichever serves the turn.
    fireTurnEnd(h.bus, 's-2', 'req-2');
    const out2 = await h.bus.call<unknown, AgentOutcome>('agent:invoke', mkCtx('s-2', 'req-2'),
      { message: { role: 'user', content: 'use it' } });
    for (const hk of handles) hk.forceExit();
    return { out2, opens, queued, terminated, logs };
  }

  it('attaching a connector mid-chat retires the warm session; the next turn spawns fresh', async () => {
    const r = await twoTurns(
      { connectorAttachments: [], connectorExclusions: [] },
      { connectorAttachments: ['linear'], connectorExclusions: [] },
    );
    expect(r.out2).toEqual({ kind: 'complete', messages: [] });
    expect(r.opens).toBe(2);
    expect(r.terminated).toContain('s-1');
    expect(r.queued.filter((q) => q.sessionId === 's-1' && q.type === 'user-message')).toHaveLength(1); // turn 1 only
    expect(r.logs.find((l) => l.msg === 'stale_session_respawn'))
      .toMatchObject({ sessionId: 's-1', reason: 'connectors-changed' });
  });

  it('detaching a connector mid-chat retires the warm session too', async () => {
    const r = await twoTurns(
      { connectorAttachments: ['linear', 'github'], connectorExclusions: [] },
      { connectorAttachments: ['github'], connectorExclusions: [] },
    );
    expect(r.opens).toBe(2);
    expect(r.terminated).toContain('s-1');
    expect(r.logs.find((l) => l.msg === 'stale_session_respawn'))
      .toMatchObject({ sessionId: 's-1', reason: 'connectors-changed' });
  });

  it('a new exclusion (removing a legacy-owned connector) retires the warm session', async () => {
    const r = await twoTurns(
      { connectorAttachments: [], connectorExclusions: [] },
      { connectorAttachments: [], connectorExclusions: ['legacy-one'] },
    );
    expect(r.opens).toBe(2);
    expect(r.terminated).toContain('s-1');
    expect(r.logs.find((l) => l.msg === 'stale_session_respawn'))
      .toMatchObject({ sessionId: 's-1', reason: 'connectors-changed' });
  });

  it('an unchanged selection (even reordered) keeps routing into the warm session', async () => {
    const r = await twoTurns(
      { connectorAttachments: ['linear', 'github'], connectorExclusions: ['x'] },
      { connectorAttachments: ['github', 'linear'], connectorExclusions: ['x'] },
    );
    expect(r.out2).toEqual({ kind: 'complete', messages: [] });
    expect(r.opens).toBe(1);
    expect(r.terminated).not.toContain('s-1');
    expect(r.queued.filter((q) => q.sessionId === 's-1' && q.type === 'user-message')).toHaveLength(2); // both turns
    expect(r.logs.find((l) => l.msg === 'stale_session_respawn')).toBeUndefined();
  });
});

// TASK-833 — the TASK-811 key only sees the agent row. A connector DELETED, or
// its capabilities EDITED, leaves the row alone, so a warm session kept the old
// connector (and, for a delete, the proxy kept substituting the purged key)
// until the session idled out. The orchestrator now also compares the
// connectors the session FOLDED at spawn with what the agent resolves to on the
// next turn, and a `connectors:deleted` reaps a session holding that connector
// as soon as it is idle — which closes its credential-proxy session.
describe('TASK-833: connector delete / edit mid-chat reaches the warm session', () => {
  type Caps = {
    allowedHosts: string[];
    credentials: Array<{ slot: string; kind: 'api-key' }>;
    mcpServers: Array<{
      name: string; transport: 'http'; url: string; allowedHosts: string[];
      credentials: Array<{ slot: string; kind: 'api-key' }>;
    }>;
  };
  type Effective = {
    summary: { id: string; name?: string; usageNote?: string };
    capabilities: Caps;
    toolNamespaces: Array<{ server: string; toolNamespace: string }>;
  };
  const LINEAR_NS = 'c0123456789';
  function linear(url = 'https://mcp.linear.app/mcp'): Effective {
    return {
      summary: { id: 'linear', name: 'Linear' },
      capabilities: {
        allowedHosts: ['mcp.linear.app'],
        credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
        mcpServers: [{
          name: 'linear', transport: 'http', url, allowedHosts: ['mcp.linear.app'],
          credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
        }],
      },
      toolNamespaces: [{ server: 'linear', toolNamespace: LINEAR_NS }],
    };
  }
  /** Same content, every object's keys in reverse order (a fresh DB read may differ). */
  function reorderKeys<T>(v: T): T {
    if (Array.isArray(v)) return v.map(reorderKeys) as T;
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, reorderKeys(x)]),
      ) as T;
    }
    return v;
  }

  async function setup(opts: { runnerExitsOnKill?: boolean; idleWindowMs?: number; idleGraceMs?: number } = {}) {
    const state = { effective: [linear()] as Effective[] };
    const agentRow = { ...TEST_AGENT, connectorAttachments: ['linear'], connectorExclusions: [] as string[] };
    const conv = { activeSessionId: null as string | null };
    const live = new Set<string>();
    const handles = [makeHandle(), makeHandle()];
    // TASK-877 — a runner that does not exit promptly: neither the graceful
    // cancel nor the grace kill resolves `handle.exited` (a wedged runner, or a
    // kill still making its way through the kubelet).
    if (opts.runnerExitsOnKill === false) {
      for (const hk of handles) {
        hk.handle.kill = async () => { hk.state.kills += 1; };
      }
    }
    let opens = 0;
    const queued: Array<{ sessionId: string; type: string }> = [];
    const terminated: string[] = [];
    const proxyOpens: Array<{ sessionId: string; credentialKeys: string[] }> = [];
    const proxyCloses: string[] = [];
    // A model of the proxy's substitution table: the credential env names each
    // OPEN proxy session still injects. Close drops the session's entry.
    const proxyTables = new Map<string, string[]>();
    const logs: Array<Record<string, unknown>> = [];

    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({ agent: { ...agentRow } }),
      'connectors:list-effective': async () => ({
        connectors: state.effective.map((c) => structuredClone(c)),
      }),
      'session:queue-work': async (_c, input: unknown) => {
        const i = input as { sessionId: string; entry: { type: string } };
        queued.push({ sessionId: i.sessionId, type: i.entry.type });
        return { cursor: 0 };
      },
      'session:terminate': async (_c, input: unknown) => {
        const sid = (input as { sessionId: string }).sessionId;
        terminated.push(sid);
        live.delete(sid);
        return {};
      },
      'session:is-alive': async (_c, input: unknown) => ({
        alive: live.has((input as { sessionId: string }).sessionId),
      }),
      'conversations:get': async (_c, input: unknown) => {
        const i = input as { conversationId: string; userId: string };
        return { conversation: {
          conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent',
          activeSessionId: conv.activeSessionId, activeReqId: null,
        } };
      },
      'conversations:bind-session': async (_c, input: unknown) => {
        const i = input as { sessionId: string };
        conv.activeSessionId = i.sessionId;
        live.add(i.sessionId);
        return undefined;
      },
      'sandbox:open-session': async () => {
        const hk = handles[opens]!;
        opens += 1;
        return { runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle };
      },
      'proxy:open-session': async (_c, input: unknown) => {
        const i = input as { sessionId: string; credentials: Record<string, unknown> };
        proxyOpens.push({ sessionId: i.sessionId, credentialKeys: Object.keys(i.credentials) });
        proxyTables.set(i.sessionId, Object.keys(i.credentials));
        return { proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) };
      },
      'proxy:close-session': async (_c, input: unknown) => {
        const sid = (input as { sessionId: string }).sessionId;
        proxyCloses.push(sid);
        proxyTables.delete(sid);
        return {};
      },
    };

    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000,
        // A long idle window: a reap observed inside a test is never the
        // ordinary idle-out.
        keepAlive: true, idleWindowMs: opts.idleWindowMs ?? 60_000, idleGraceMs: opts.idleGraceMs ?? 5,
      })],
    });

    const mkCtx = (sessionId: string, reqId: string) =>
      makeAgentContext({
        sessionId, agentId: 'test-agent', userId: 'test-user',
        conversationId: 'conv-1', reqId,
        logger: createLogger({
          reqId,
          writer: (line: string) => { logs.push(JSON.parse(line) as Record<string, unknown>); },
        }),
      });

    const turn = async (sessionId: string, reqId: string, beforeTurnEnd?: () => Promise<void>) => {
      if (beforeTurnEnd === undefined) {
        fireTurnEnd(h.bus, sessionId, reqId);
      } else {
        setImmediate(() => {
          void beforeTurnEnd().then(() => fireTurnEnd(h.bus, sessionId, reqId));
        });
      }
      return h.bus.call<unknown, AgentOutcome>('agent:invoke', mkCtx(sessionId, reqId),
        { message: { role: 'user', content: 'hi' } });
    };

    const deleteConnector = (connectorId: string, toolNamespace: string) =>
      h.bus.fire('connectors:deleted', mkCtx('admin-delete', 'req-delete'), {
        connectorId,
        toolNamespaces: [{ server: 'linear', toolNamespace }],
      });

    // Let the reaper's zero-delay idle timer, its grace kill and the exited
    // watcher's proxy close all run.
    const settle = () => new Promise((r) => setTimeout(r, 50));

    return {
      state, h, handles, turn, deleteConnector, settle,
      get opens() { return opens; },
      queued, terminated, proxyOpens, proxyCloses, proxyTables, logs,
    };
  }

  /** Credential env names any still-open proxy session injects for `linear`. */
  const linearStillInjected = (t: Awaited<ReturnType<typeof setup>>) =>
    [...t.proxyTables.values()].flat().filter((k) => k.includes('linear'));

  it('the spawn hands the connector credential to the proxy (fixture sanity)', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    expect(t.proxyOpens).toHaveLength(1);
    expect(t.proxyOpens[0]!.credentialKeys.some((k) => k.includes('linear'))).toBe(true);
    for (const hk of t.handles) hk.forceExit();
  });

  it('editing an attached connector mid-chat retires the warm session at the next turn', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    t.state.effective = [linear('https://mcp.linear.app/v2/mcp')];
    const out2 = await t.turn('s-2', 'req-2');
    expect(out2).toEqual({ kind: 'complete', messages: [] });
    expect(t.opens).toBe(2);
    expect(t.terminated).toContain('s-1');
    expect(t.queued.filter((q) => q.sessionId === 's-1' && q.type === 'user-message')).toHaveLength(1);
    expect(t.logs.find((l) => l.msg === 'stale_session_respawn'))
      .toMatchObject({ sessionId: 's-1', reason: 'connectors-changed' });
    for (const hk of t.handles) hk.forceExit();
  });

  it('an unchanged connector (re-read with its keys in another order) keeps the warm session', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    t.state.effective = [reorderKeys(linear())];
    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(1);
    expect(t.terminated).not.toContain('s-1');
    expect(t.queued.filter((q) => q.sessionId === 's-1' && q.type === 'user-message')).toHaveLength(2);
    expect(t.logs.find((l) => l.msg === 'stale_session_respawn')).toBeUndefined();
    for (const hk of t.handles) hk.forceExit();
  });

  it('deleting a connector reaps an IDLE warm session at once — its proxy session (and the key) is closed', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    expect(t.proxyCloses).not.toContain('s-1');

    // The delete purges the vault row and announces itself; the connector no
    // longer resolves.
    t.state.effective = [];
    await t.deleteConnector('linear', LINEAR_NS);
    await t.settle();

    // No next turn needed: the session is reaped and its proxy session — the
    // only place the purged key still lived — is closed.
    expect(t.queued).toContainEqual({ sessionId: 's-1', type: 'cancel' });
    expect(t.handles[0]!.state.kills).toBeGreaterThanOrEqual(1);
    expect(t.proxyCloses).toContain('s-1');

    // The next turn spawns fresh, without the deleted connector's credential.
    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(2);
    expect(t.queued.filter((q) => q.sessionId === 's-1' && q.type === 'user-message')).toHaveLength(1);
    expect(t.proxyOpens.at(-1)!.credentialKeys.some((k) => k.includes('linear'))).toBe(false);
    for (const hk of t.handles) hk.forceExit();
  });

  it('deleting a connector DURING a turn reaps the session as soon as that turn ends', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1', async () => {
      t.state.effective = [];
      await t.deleteConnector('linear', LINEAR_NS);
    });
    await t.settle();
    // Not the ordinary 60s idle-out: the reap ran right after the turn.
    expect(t.queued).toContainEqual({ sessionId: 's-1', type: 'cancel' });
    expect(t.proxyCloses).toContain('s-1');
    for (const hk of t.handles) hk.forceExit();
  });

  // TASK-877 — the reap used to close the proxy session only on `handle.exited`,
  // so the deleted connector's key stayed injectable for as long as the runner
  // took to exit (bounded only by the grace kill — and not at all if the kill
  // never landed). The reap now closes the proxy session itself.
  it('deleting a connector closes an IDLE warm session\'s proxy session even if its runner does not exit', async () => {
    // A grace far beyond the test: nothing here is the forced kill.
    const t = await setup({ runnerExitsOnKill: false, idleGraceMs: 60_000 });
    await t.turn('s-1', 'req-1');
    expect(linearStillInjected(t)).not.toEqual([]);

    t.state.effective = [];
    await t.deleteConnector('linear', LINEAR_NS);
    await t.settle();

    // The reap started (graceful cancel queued) but the runner is still up...
    expect(t.queued).toContainEqual({ sessionId: 's-1', type: 'cancel' });
    expect(t.handles[0]!.state.kills).toBe(0);
    // ...and its proxy session is closed regardless: the key is gone.
    expect(t.proxyCloses).toContain('s-1');
    expect(linearStillInjected(t)).toEqual([]);
    for (const hk of t.handles) hk.forceExit();
  });

  it('a wedged runner whose grace kill never lands still loses the deleted connector\'s key', async () => {
    const t = await setup({ runnerExitsOnKill: false });
    await t.turn('s-1', 'req-1');
    t.state.effective = [];
    await t.deleteConnector('linear', LINEAR_NS);
    await t.settle();
    expect(t.handles[0]!.state.kills).toBeGreaterThanOrEqual(1); // the kill ran, the runner lived
    expect(t.proxyCloses).toContain('s-1');
    expect(linearStillInjected(t)).toEqual([]);
    for (const hk of t.handles) hk.forceExit();
  });

  it('deleting a connector while an ordinary idle-out is already in its grace window still closes the proxy session', async () => {
    // A short idle window: the ordinary reaper fires (cancel queued) and the
    // runner ignores it, so the session sits in its (long) grace window.
    const t = await setup({ runnerExitsOnKill: false, idleWindowMs: 5, idleGraceMs: 60_000 });
    await t.turn('s-1', 'req-1');
    await t.settle();
    expect(t.queued).toContainEqual({ sessionId: 's-1', type: 'cancel' });
    expect(t.proxyCloses).not.toContain('s-1');

    t.state.effective = [];
    await t.deleteConnector('linear', LINEAR_NS);
    await t.settle();
    expect(t.proxyCloses).toContain('s-1');
    expect(linearStillInjected(t)).toEqual([]);
    for (const hk of t.handles) hk.forceExit();
  });

  it('deleting a connector DURING a turn leaves that turn\'s proxy session open, then closes it when the turn ends (runner still up)', async () => {
    const t = await setup({ runnerExitsOnKill: false, idleGraceMs: 60_000 });
    let closedMidTurn: boolean | undefined;
    await t.turn('s-1', 'req-1', async () => {
      t.state.effective = [];
      await t.deleteConnector('linear', LINEAR_NS);
      await t.settle();
      // The in-flight turn is not interrupted: its proxy session stays.
      closedMidTurn = t.proxyCloses.includes('s-1');
    });
    await t.settle();
    expect(closedMidTurn).toBe(false);
    expect(t.queued).toContainEqual({ sessionId: 's-1', type: 'cancel' });
    expect(t.proxyCloses).toContain('s-1');
    expect(linearStillInjected(t)).toEqual([]);
    for (const hk of t.handles) hk.forceExit();
  });

  it('a deleted connector the session never folded (another owner\'s, same id) does not reap it', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    await t.deleteConnector('linear', 'cfedcba9876');
    await t.settle();
    expect(t.queued.filter((q) => q.type === 'cancel')).toHaveLength(0);
    expect(t.proxyCloses).not.toContain('s-1');
    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(1);
    for (const hk of t.handles) hk.forceExit();
  });

  it('a delete that misses the reap (say, another replica took it) still retires the session at the next turn', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    t.state.effective = []; // deleted, but this process never heard the event
    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(2);
    expect(t.terminated).toContain('s-1');
    expect(t.queued.filter((q) => q.sessionId === 's-1' && q.type === 'user-message')).toHaveLength(1);
    expect(t.proxyOpens.at(-1)!.credentialKeys.some((k) => k.includes('linear'))).toBe(false);
    for (const hk of t.handles) hk.forceExit();
  });
});

// TASK-785 — a message sent while a reply is still running can be FOLDED into
// that running turn by the model's CLI: one turn answers both, and it ends
// under the running message's reqId. The folded message never gets a turn-end
// of its own, so its agent:invoke waiter used to wait out the whole chat
// timeout and then fire a chat-run-timeout turn-error at a reply that had
// already arrived. The runner names folded messages in `foldedReqIds`; the
// orchestrator resolves their waiters too — but only waiters of the session
// that sent the turn-end, because the list is runner-written (untrusted).
describe('TASK-785: a folded message\'s agent:invoke waiter resolves on the turn-end that answered it', () => {
  it('resolves the folded waiter, and never one from another session', async () => {
    const conv: Record<string, { activeSessionId: string | null }> = {
      'conv-1': { activeSessionId: null },
      'conv-2': { activeSessionId: null },
    };
    const live = new Set<string>();
    const handles = [makeHandle(), makeHandle()];
    let opens = 0;
    const queuedReqIds: string[] = [];

    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
      'session:queue-work': async (_c, input: unknown) => {
        const i = input as { entry: { type: string; reqId?: string } };
        if (i.entry.type === 'user-message' && i.entry.reqId !== undefined) {
          queuedReqIds.push(i.entry.reqId);
        }
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
        const i = input as { conversationId: string; sessionId: string };
        conv[i.conversationId]!.activeSessionId = i.sessionId;
        live.add(i.sessionId);
        return undefined;
      },
      'sandbox:open-session': async () => {
        const hk = handles[opens]!;
        opens += 1;
        return { runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle };
      },
      'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: TEST_PROXY_AUTH_TOKEN }),
      'proxy:close-session': async () => ({}),
    };

    // Long enough that a waiter left to time out cannot settle inside the test.
    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 30_000,
        keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000,
      })],
    });
    const invoke = (sessionId: string, conversationId: string, reqId: string) => {
      const settled = { done: false };
      const p = h.bus.call<unknown, AgentOutcome>('agent:invoke',
        ctxWith({ sessionId, conversationId, reqId }),
        { message: { role: 'user', content: reqId } });
      void p.then(() => { settled.done = true; }, () => { settled.done = true; });
      return { p, settled };
    };
    const turnEnd = (sessionId: string, payload: Record<string, unknown>) =>
      h.bus.fire('chat:turn-end',
        makeAgentContext({ sessionId, agentId: 'a', userId: 'u', reqId: 'ipc-fresh',
          logger: createLogger({ reqId: 'ipc-fresh', writer: () => undefined }) }),
        { reason: 'user-message-wait', ...payload });

    // conv-1 warms up on s-1.
    fireTurnEnd(h.bus, 's-1', 'req-1');
    await invoke('s-1', 'conv-1', 'req-1').p;
    // conv-2 runs on its own session s-2; its turn is still going.
    const other = invoke('s-2', 'conv-2', 'req-x');
    // Two messages into the warm s-1: req-3 lands while req-2's reply runs.
    const second = invoke('s-1', 'conv-1', 'req-2');
    const third = invoke('s-1', 'conv-1', 'req-3');
    await vi.waitFor(
      () => expect(queuedReqIds).toEqual(expect.arrayContaining(['req-x', 'req-2', 'req-3'])),
      { timeout: 2_000, interval: 5 },
    );

    // The CLI folds req-3 into req-2's turn: ONE turn-end, named after req-2.
    // A runner-written list naming another session's message, or an id no one
    // waits on, must not reach past this session.
    await turnEnd('s-1', { reqId: 'req-2', foldedReqIds: ['req-3', 'req-x', 'req-unknown'] });

    expect(await second.p).toEqual({ kind: 'complete', messages: [] });
    // Before the fix this waited out the 30 s chat timeout; read it as such.
    const stillWaiting = new Promise((r) => setTimeout(() => r('still waiting'), 1_000));
    expect(await Promise.race([third.p, stillWaiting])).toEqual({ kind: 'complete', messages: [] });

    // s-2's turn is untouched — it ends on its own turn-end, not s-1's list.
    await new Promise((r) => setTimeout(r, 50));
    expect(other.settled.done).toBe(false);
    await turnEnd('s-2', { reqId: 'req-x' });
    expect(await other.p).toEqual({ kind: 'complete', messages: [] });
    for (const hk of handles) hk.forceExit();
  });
});

// TASK-860 — TASK-833 retires a warm session whose connector was deleted or
// edited, but re-entering a NEW api-key on an existing connector changes
// neither: the connector shape is the same and nothing is deleted. The
// credential proxy resolved the key once at open, and api-key slots were never
// rotated (I10 rotates only refreshable kinds), so a warm session kept
// injecting the OLD key until it idled out. The orchestrator now re-resolves
// the session's credentials (`proxy:rotate-session`) before it routes a message
// into a warm session; if that fails, the session is retired and the turn
// spawns fresh.
describe('TASK-860: a replaced api-key reaches the warm session on its next turn', () => {
  const LINEAR = {
    summary: { id: 'linear', name: 'Linear' },
    capabilities: {
      allowedHosts: ['mcp.linear.app'],
      credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' as const }],
      mcpServers: [{
        name: 'linear', transport: 'http' as const, url: 'https://mcp.linear.app/mcp',
        allowedHosts: ['mcp.linear.app'],
        credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' as const }],
      }],
    },
    toolNamespaces: [{ server: 'linear', toolNamespace: 'c0123456789' }],
  };

  async function setup(opts: {
    rotateLoaded?: boolean;
    terminateThrows?: boolean;
    /** TASK-878 — a close for this session never settles until `releaseClose()`. */
    closeHangsFor?: string;
    proxyCloseTimeoutMs?: number;
  } = {}) {
    // The vault: what `credentials:get` would answer for a ref right now.
    const vault = { version: 1, failing: false };
    const resolve = (ref: string): string => {
      if (vault.failing) throw new Error('credential store unavailable');
      return `${ref}#key-v${vault.version}`;
    };
    // A model of the proxy's substitution table: envName -> the REAL value it
    // injects. Open resolves every ref once; rotate re-resolves in place. (That
    // the real proxy then substitutes ONLY the new value is pinned by
    // credential-proxy's "proxy:rotate-session re-resolves credentials" test.)
    const proxyTables = new Map<string, { refs: Record<string, string>; injected: Record<string, string> }>();
    const conv = { activeSessionId: null as string | null };
    const live = new Set<string>();
    const handles = [makeHandle(), makeHandle()];
    let opens = 0;
    let rotates = 0;
    const events: string[] = [];
    // What the proxy would inject at the moment each user message reached a runner.
    const injectedAtQueue: Array<{ sessionId: string; injected: string[] }> = [];
    const terminated: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    let releaseClose: (() => void) | undefined;

    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({
        agent: { ...TEST_AGENT, connectorAttachments: ['linear'], connectorExclusions: [] },
      }),
      'connectors:list-effective': async () => ({ connectors: [structuredClone(LINEAR)] }),
      'session:queue-work': async (_c, input: unknown) => {
        const i = input as { sessionId: string; entry: { type: string } };
        events.push(`queue:${i.entry.type}:${i.sessionId}`);
        if (i.entry.type === 'user-message') {
          injectedAtQueue.push({
            sessionId: i.sessionId,
            injected: Object.values(proxyTables.get(i.sessionId)?.injected ?? {}),
          });
        }
        return { cursor: 0 };
      },
      'session:terminate': async (_c, input: unknown) => {
        const sid = (input as { sessionId: string }).sessionId;
        terminated.push(sid);
        // TASK-871 — a terminate that throws leaves the runner (and its handle)
        // alive: nothing here resolves `handle.exited`.
        if (opts.terminateThrows === true) throw new Error('simulated terminate failure');
        live.delete(sid);
        return {};
      },
      'session:is-alive': async (_c, input: unknown) => ({
        alive: live.has((input as { sessionId: string }).sessionId),
      }),
      'conversations:get': async (_c, input: unknown) => {
        const i = input as { conversationId: string; userId: string };
        return { conversation: {
          conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent',
          activeSessionId: conv.activeSessionId, activeReqId: null,
        } };
      },
      'conversations:bind-session': async (_c, input: unknown) => {
        const i = input as { sessionId: string };
        conv.activeSessionId = i.sessionId;
        live.add(i.sessionId);
        return undefined;
      },
      'sandbox:open-session': async () => {
        const hk = handles[opens]!;
        opens += 1;
        return { runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle };
      },
      'proxy:open-session': async (_c, input: unknown) => {
        const i = input as { sessionId: string; credentials: Record<string, { ref: string }> };
        const refs = Object.fromEntries(Object.entries(i.credentials).map(([k, v]) => [k, v.ref]));
        const injected = Object.fromEntries(Object.entries(refs).map(([k, ref]) => [k, resolve(ref)]));
        proxyTables.set(i.sessionId, { refs, injected });
        return { proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) };
      },
      'proxy:close-session': async (_c, input: unknown) => {
        const sid = (input as { sessionId: string }).sessionId;
        if (sid === opts.closeHangsFor) {
          // A wedged (e.g. remote) proxy: the close lands only when released.
          await new Promise<void>((r) => { releaseClose = r; });
        }
        proxyTables.delete(sid);
        return {};
      },
    };
    if (opts.rotateLoaded !== false) {
      services['proxy:rotate-session'] = async (_c, input: unknown) => {
        const sid = (input as { sessionId: string }).sessionId;
        rotates += 1;
        events.push(`rotate:${sid}`);
        const table = proxyTables.get(sid);
        if (table === undefined) throw new Error(`session ${sid} not open`);
        for (const [k, ref] of Object.entries(table.refs)) table.injected[k] = resolve(ref);
        return { envMap: {} };
      };
    }

    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000,
        keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 5,
        ...(opts.proxyCloseTimeoutMs !== undefined ? { proxyCloseTimeoutMs: opts.proxyCloseTimeoutMs } : {}),
      })],
    });

    const mkCtx = (sessionId: string, reqId: string) =>
      makeAgentContext({
        sessionId, agentId: 'test-agent', userId: 'test-user',
        conversationId: 'conv-1', reqId,
        logger: createLogger({
          reqId,
          writer: (line: string) => { logs.push(JSON.parse(line) as Record<string, unknown>); },
        }),
      });

    const turn = (sessionId: string, reqId: string) => {
      fireTurnEnd(h.bus, sessionId, reqId);
      return h.bus.call<unknown, AgentOutcome>('agent:invoke', mkCtx(sessionId, reqId),
        { message: { role: 'user', content: 'hi' } });
    };

    return {
      vault, handles, turn, events, injectedAtQueue, terminated, logs, proxyTables,
      releaseClose: () => releaseClose?.(),
      endTurn: (sessionId: string, reqId: string) => fireTurnEnd(h.bus, sessionId, reqId),
      get closeIsPending() { return releaseClose !== undefined; },
      get opens() { return opens; },
      get rotates() { return rotates; },
    };
  }

  it('the next warm turn injects the NEW key and no longer the old one', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    const first = t.injectedAtQueue[0]!;
    expect(first.injected.some((v) => v.includes('linear') && v.endsWith('#key-v1'))).toBe(true);

    // The user re-enters the connector's key: same connector, same ref.
    t.vault.version = 2;

    const out2 = await t.turn('s-2', 'req-2');
    expect(out2).toEqual({ kind: 'complete', messages: [] });
    // Still the SAME warm session — a key change needs no re-spawn.
    expect(t.opens).toBe(1);
    expect(t.terminated).not.toContain('s-1');
    const second = t.injectedAtQueue[1]!;
    expect(second.sessionId).toBe('s-1');
    expect(second.injected.some((v) => v.includes('linear') && v.endsWith('#key-v2'))).toBe(true);
    expect(second.injected.filter((v) => v.endsWith('#key-v1'))).toEqual([]);
    // ...and the re-resolve ran BEFORE the message reached the runner.
    const idxRotate = t.events.indexOf('rotate:s-1');
    const idxQueue = t.events.lastIndexOf('queue:user-message:s-1');
    expect(idxRotate).toBeGreaterThanOrEqual(0);
    expect(idxRotate).toBeLessThan(idxQueue);
    for (const hk of t.handles) hk.forceExit();
  });

  it('a re-resolve that fails at routing retires the warm session; the turn spawns fresh', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    // Fails for the warm session's re-resolve only: the fresh spawn's own
    // proxy:open-session resolves again and succeeds.
    t.vault.failing = true;
    t.events.length = 0;
    const origPush = t.events.push.bind(t.events);
    t.events.push = (...items: string[]) => {
      if (items.some((e) => e.startsWith('rotate:'))) queueMicrotask(() => { t.vault.failing = false; });
      return origPush(...items);
    };
    const out2 = await t.turn('s-2', 'req-2');
    expect(out2).toEqual({ kind: 'complete', messages: [] });
    expect(t.terminated).toContain('s-1');
    expect(t.opens).toBe(2);
    expect(t.events).not.toContain('queue:user-message:s-1');
    expect(t.logs.find((l) => l.msg === 'stale_session_respawn'))
      .toMatchObject({ sessionId: 's-1', reason: 'credential-rotation-failed' });
    for (const hk of t.handles) hk.forceExit();
  });

  // TASK-871 — retiring a warm session must not depend on session:terminate to
  // revoke its credentials. If terminate throws and the runner survives, its
  // handle never exits, so the deferred close on `handle.exited` never runs and
  // the proxy kept substituting the OLD key until the idle reaper.
  async function retireWithFailedRotation(t: Awaited<ReturnType<typeof setup>>) {
    await t.turn('s-1', 'req-1');
    // The key is replaced AND the warm session's re-resolve fails, so 's-1'
    // still holds the old value when it is retired. The fresh spawn's own open
    // resolves again and succeeds.
    t.vault.version = 2;
    t.vault.failing = true;
    const origPush = t.events.push.bind(t.events);
    t.events.push = (...items: string[]) => {
      if (items.some((e) => e.startsWith('rotate:'))) queueMicrotask(() => { t.vault.failing = false; });
      return origPush(...items);
    };
    return t.turn('s-2', 'req-2');
  }

  it('a retire whose session:terminate throws still closes the proxy session (old key no longer injected)', async () => {
    const t = await setup({ terminateThrows: true });
    const out2 = await retireWithFailedRotation(t);
    expect(out2).toEqual({ kind: 'complete', messages: [] });
    expect(t.terminated).toContain('s-1');
    expect(t.logs.find((l) => l.msg === 'respawn_terminate_failed'))
      .toMatchObject({ sessionId: 's-1' });
    // The runner survived (its handle never exited), yet its proxy session is gone.
    expect(t.proxyTables.has('s-1')).toBe(false);
    const injectedAnywhere = [...t.proxyTables.values()].flatMap((tb) => Object.values(tb.injected));
    expect(injectedAnywhere.filter((v) => v.endsWith('#key-v1'))).toEqual([]);
    // The fresh session is unaffected and carries the new key.
    expect(t.opens).toBe(2);
    const fresh = t.injectedAtQueue.at(-1)!;
    expect(fresh.sessionId).toBe('s-2');
    expect(fresh.injected.some((v) => v.endsWith('#key-v2'))).toBe(true);
    for (const hk of t.handles) hk.forceExit();
  });

  // Before terminate too: a terminate that hangs must not delay the revocation.
  it('a retire closes the proxy session before terminate and before the fresh spawn opens its own', async () => {
    const t = await setup();
    const closes: string[] = [];
    const origDelete = t.proxyTables.delete.bind(t.proxyTables);
    t.proxyTables.delete = (k: string) => {
      closes.push(`${k}@opens=${t.opens},terminated=${t.terminated.length}`);
      return origDelete(k);
    };
    await retireWithFailedRotation(t);
    expect(t.terminated).toContain('s-1');
    expect(t.proxyTables.has('s-1')).toBe(false);
    expect(closes[0]).toBe('s-1@opens=1,terminated=0');
    for (const hk of t.handles) hk.forceExit();
  });

  // TASK-878 — the retire awaits proxy:close-session before terminate. A close
  // that never settles (a remote or wedged proxy) used to hold the user's next
  // message for the HookBus service timeout (120 s). Bounded now: log, then
  // terminate + respawn anyway — and the close is NOT cancelled.
  it('a retire whose proxy:close-session hangs proceeds after the bound, logs it, and the close still lands later', async () => {
    const CLOSE_BOUND_MS = 250;
    const t = await setup({ closeHangsFor: 's-1', proxyCloseTimeoutMs: CLOSE_BOUND_MS });
    await t.turn('s-1', 'req-1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const settled: { out?: AgentOutcome } = {};
      void retireWithFailedRotation(t).then((o) => { settled.out = o; });
      const tick = () => new Promise<void>((r) => setImmediate(r));
      // Wall-clock budgeted (Date stays real: only setTimeout/clearTimeout are
      // faked), polled on setImmediate — vi.waitFor would advance the fake clock.
      const until = async (cond: () => boolean): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (!cond() && Date.now() < deadline) await tick();
      };
      await until(() => t.closeIsPending);
      expect(t.closeIsPending).toBe(true);
      // The bound is armed on the (fake) clock — otherwise this test proves nothing.
      expect(spy.mock.calls.some(([, ms]) => ms === CLOSE_BOUND_MS)).toBe(true);
      // Inside the bound: the retire is still waiting on the close.
      for (let i = 0; i < 20; i++) await tick();
      expect(t.terminated).not.toContain('s-1');
      expect(t.opens).toBe(1);
      expect(t.logs.some((l) => l.msg === 'proxy_close_session_timeout')).toBe(false);

      vi.advanceTimersByTime(CLOSE_BOUND_MS);
      await until(() => t.opens >= 2);
      // The turn-end `turn()` pre-fired landed while routing was held; the
      // fresh runner's turn ends now.
      t.endTurn('s-2', 'req-2');
      await until(() => settled.out !== undefined);

      expect(settled.out).toEqual({ kind: 'complete', messages: [] });
      expect(t.terminated).toContain('s-1');
      expect(t.opens).toBe(2);
      expect(t.logs.find((l) => l.msg === 'proxy_close_session_timeout'))
        .toMatchObject({ sessionId: 's-1', phase: 'retire', timeoutMs: CLOSE_BOUND_MS });
      // Not cancelled: the slow close still revokes the old session when it lands.
      expect(t.proxyTables.has('s-1')).toBe(true);
      t.releaseClose();
      await until(() => !t.proxyTables.has('s-1'));
      expect(t.proxyTables.has('s-1')).toBe(false);
      expect(t.logs.some((l) => l.msg === 'proxy_close_session_failed')).toBe(false);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
      for (const hk of t.handles) hk.forceExit();
    }
  });

  it('without proxy:rotate-session loaded, routing is unchanged (no retire)', async () => {
    const t = await setup({ rotateLoaded: false });
    await t.turn('s-1', 'req-1');
    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(1);
    expect(t.rotates).toBe(0);
    expect(t.terminated).not.toContain('s-1');
    for (const hk of t.handles) hk.forceExit();
  });
});
