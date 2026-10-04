import { describe, it, expect, vi } from 'vitest';
import {
  HookBus, makeAgentContext, createLogger,
  type AgentOutcome, type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
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

    // Turn 2 — routed into the warm session; rotation must fire again.
    fireTurnEnd(h.bus, 's-1', 'req-2');
    await h.bus.call<unknown, AgentOutcome>('agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-2' }),
      { message: { role: 'user', content: 'again' } });
    await flush();
    expect(rotates).toHaveLength(2);
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
