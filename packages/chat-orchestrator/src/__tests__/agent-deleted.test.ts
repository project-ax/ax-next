import { describe, it, expect, vi } from 'vitest';
import {
  makeAgentContext, createLogger,
  type AgentOutcome, type HookBus, type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// TASK-718 — `agents:deleted` must take the deleted agent's WARM sandboxes down
// at once. In the k8s preset (`keepAlive: true`) a finished turn leaves the
// runner alive for the idle window (5 minutes by default), still holding the
// agent's durable-files mount and its credential-proxy session. Without this
// subscriber a delete leaves both behind until the idle reaper gets there.

const TEST_AGENT = {
  id: 'agent-a', ownerId: 'test-user', ownerType: 'user' as const,
  visibility: 'personal' as const, displayName: 'Test',
  allowedTools: ['file.read'], mcpConfigIds: [], model: 'anthropic/claude-sonnet-4-7',
  runner: 'claude-sdk', workspaceRef: null,
};

interface FakeHandle {
  state: { kills: number };
  handle: {
    kill: () => Promise<void>;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  };
}

// A controllable warm sandbox. `kill()` counts the call, then either rejects
// (`killRejects`, a k8s API blip), waits on `killGate` (a slow pod delete), or
// resolves `exited` the way a real kill does.
function makeHandle(o: { killRejects?: boolean; killGate?: Promise<void> } = {}): FakeHandle {
  let resolveExit!: () => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    resolveExit = () => res({ code: 0, signal: null });
  });
  const state = { kills: 0 };
  return {
    state,
    handle: {
      kill: async () => {
        state.kills += 1;
        if (o.killRejects === true) throw new Error('kubelet unreachable');
        if (o.killGate !== undefined) await o.killGate;
        resolveExit();
      },
      exited,
    },
  };
}

type LogLine = Record<string, unknown>;

function ctxWith(o: { sessionId: string; agentId: string; reqId: string; conversationId?: string }) {
  return makeAgentContext({
    sessionId: o.sessionId, agentId: o.agentId, userId: 'test-user', reqId: o.reqId,
    ...(o.conversationId !== undefined ? { conversationId: o.conversationId } : {}),
    logger: createLogger({ reqId: o.reqId, writer: () => undefined }),
  });
}

// A ctx like the one `@ax/agents` fires `agents:deleted` with: the DELETER's
// request context, whose own agentId says nothing about the deleted agent. The
// logger is captured so a test can assert on what the subscriber said.
function deleteCtx(logs: LogLine[], agentId = 'admin-request') {
  return makeAgentContext({
    sessionId: 'delete-req', agentId, userId: 'test-user', reqId: 'req-delete',
    logger: createLogger({
      reqId: 'req-delete',
      writer: (line) => { logs.push(JSON.parse(line) as LogLine); },
    }),
  });
}

function deletedPayload(agentId: string) {
  return { agentId, ownerId: 'test-user', ownerType: 'user' as const };
}

function fireTurnEnd(bus: HookBus, sessionId: string, reqId: string) {
  setImmediate(() => {
    void bus.fire('chat:turn-end',
      makeAgentContext({ sessionId, agentId: 'a', userId: 'u', reqId: 'ipc-fresh',
        logger: createLogger({ reqId: 'ipc-fresh', writer: () => undefined }) }),
      { reason: 'user-message-wait', reqId });
  });
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface World {
  bus: HookBus;
  opened: string[];
  cancels: string[];
  proxyClosed: string[];
  /** Run one keepalive turn to completion, leaving `sessionId` warm. */
  warmUp(agentId: string, sessionId: string): Promise<void>;
}

async function makeWorld(o: {
  handles: Record<string, FakeHandle>;
  idleWindowMs?: number;
  keepAlive?: boolean;
  idleGraceMs?: number;
  extraServices?: Record<string, ServiceHandler>;
}): Promise<World> {
  const opened: string[] = [];
  const cancels: string[] = [];
  const proxyClosed: string[] = [];
  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async (_c, input: unknown) => ({
      agent: { ...TEST_AGENT, id: (input as { agentId: string }).agentId },
    }),
    'session:queue-work': async (_c, input: unknown) => {
      const i = input as { sessionId: string; entry: { type: string } };
      if (i.entry.type === 'cancel') cancels.push(i.sessionId);
      return { cursor: 0 };
    },
    'session:terminate': async () => ({}),
    'sandbox:open-session': async (_c, input: unknown) => {
      const sessionId = (input as { sessionId: string }).sessionId;
      opened.push(sessionId);
      const fake = o.handles[sessionId];
      if (fake === undefined) throw new Error(`test setup: no fake handle for ${sessionId}`);
      return { runnerEndpoint: 'unix:///tmp/m.sock', handle: fake.handle };
    },
    'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {} }),
    'proxy:close-session': async (c: unknown) => {
      proxyClosed.push((c as { sessionId: string }).sessionId);
      return {};
    },
    ...o.extraServices,
  };
  const h = await createTestHarness({
    services,
    plugins: [createChatOrchestratorPlugin({
      runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000,
      keepAlive: o.keepAlive ?? true,
      idleWindowMs: o.idleWindowMs ?? 60_000,
      idleGraceMs: o.idleGraceMs ?? 1_000,
    })],
  });
  return {
    bus: h.bus, opened, cancels, proxyClosed,
    async warmUp(agentId, sessionId) {
      fireTurnEnd(h.bus, sessionId, `req-${sessionId}`);
      const out = await h.bus.call<unknown, AgentOutcome>('agent:invoke',
        ctxWith({ sessionId, agentId, reqId: `req-${sessionId}` }),
        { message: { role: 'user', content: 'hi' } });
      expect(out).toEqual({ kind: 'complete', messages: [] });
    },
  };
}

describe('chat-orchestrator — agents:deleted', () => {
  it('manifest lists the agents:deleted subscription', () => {
    const plugin = createChatOrchestratorPlugin({ runnerBinaries: { 'claude-sdk': '/x' } });
    expect(plugin.manifest.subscribes).toContain('agents:deleted');
  });

  it('kills every warm sandbox of the deleted agent, and only that agent\'s', async () => {
    const a1 = makeHandle();
    const a2 = makeHandle();
    const b1 = makeHandle();
    const w = await makeWorld({ handles: { 's-a1': a1, 's-a2': a2, 's-b1': b1 } });
    await w.warmUp('agent-a', 's-a1');
    await w.warmUp('agent-a', 's-a2');
    await w.warmUp('agent-b', 's-b1');
    expect(w.opened).toEqual(['s-a1', 's-a2', 's-b1']);

    // The deleter's ctx names agent-b on purpose: the subscriber must key off
    // the PAYLOAD's agentId, never the request context's.
    const logs: LogLine[] = [];
    const res = await w.bus.fire('agents:deleted', deleteCtx(logs, 'agent-b'), deletedPayload('agent-a'));
    await flush();

    expect(res.rejected).toBe(false);
    expect(a1.state.kills).toBe(1);
    expect(a2.state.kills).toBe(1);
    expect(b1.state.kills).toBe(0);
    // The kill flows through the existing handle.exited cleanup: the proxy
    // session is closed for the killed sessions only.
    expect([...w.proxyClosed].sort()).toEqual(['s-a1', 's-a2']);
    expect(logs.filter((l) => l.msg === 'agent_deleted_warm_sessions_killed')).toEqual([
      expect.objectContaining({ level: 'info', agentId: 'agent-a', count: 2 }),
    ]);

    // The registry entries went with the exit: deleting A again finds nothing
    // to kill (no second kill), while B is still tracked and still warm.
    await w.bus.fire('agents:deleted', deleteCtx([]), deletedPayload('agent-a'));
    await flush();
    expect(a1.state.kills).toBe(1);
    expect(a2.state.kills).toBe(1);
    expect(b1.state.kills).toBe(0);
    await w.bus.fire('agents:deleted', deleteCtx([]), deletedPayload('agent-b'));
    await flush();
    expect(b1.state.kills).toBe(1);
    expect([...w.proxyClosed].sort()).toEqual(['s-a1', 's-a2', 's-b1']);
  });

  it('an idle reaper armed by the last turn cannot race an in-flight kill', async () => {
    // A slow pod delete: kill() is still pending while the idle window (150 ms)
    // and the grace (100 ms) both elapse. If the reaper timers were left armed
    // they would queue a graceful cancel and then force a second kill.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a1 = makeHandle({ killGate: gate });
    const w = await makeWorld({ handles: { 's-a1': a1 }, idleWindowMs: 150, idleGraceMs: 100 });
    await w.warmUp('agent-a', 's-a1');

    const firing = w.bus.fire('agents:deleted', deleteCtx([]), deletedPayload('agent-a'));
    await sleep(450);

    expect(a1.state.kills).toBe(1);
    expect(w.cancels).toEqual([]);

    release();
    await firing;
    await flush();
    expect(a1.state.kills).toBe(1);
    expect(w.proxyClosed).toEqual(['s-a1']);
  });

  it('a kill that rejects is logged and does not stop the other kills', async () => {
    const a1 = makeHandle({ killRejects: true });
    const a2 = makeHandle();
    const b1 = makeHandle();
    const w = await makeWorld({ handles: { 's-a1': a1, 's-a2': a2, 's-b1': b1 } });
    await w.warmUp('agent-a', 's-a1');
    await w.warmUp('agent-a', 's-a2');
    await w.warmUp('agent-b', 's-b1');

    const logs: LogLine[] = [];
    const res = await w.bus.fire('agents:deleted', deleteCtx(logs), deletedPayload('agent-a'));
    await flush();

    expect(res.rejected).toBe(false);
    // The first kill failed, the second still ran to completion.
    expect(a1.state.kills).toBe(1);
    expect(a2.state.kills).toBe(1);
    expect(b1.state.kills).toBe(0);
    expect(w.proxyClosed).toEqual(['s-a2']);

    const failed = logs.filter((l) => l.msg === 'agent_deleted_kill_failed');
    expect(failed).toEqual([
      expect.objectContaining({ level: 'warn', agentId: 'agent-a', sessionId: 's-a1' }),
    ]);
    expect(JSON.stringify(failed[0])).toContain('kubelet unreachable');
    // The summary counts what was actually killed, not what was attempted.
    expect(logs.filter((l) => l.msg === 'agent_deleted_warm_sessions_killed')).toEqual([
      expect.objectContaining({ level: 'info', agentId: 'agent-a', count: 1 }),
    ]);
  });

  it('a session whose kill failed falls back to the idle reaper instead of staying warm for good', async () => {
    const a1 = makeHandle({ killRejects: true });
    const w = await makeWorld({ handles: { 's-a1': a1 }, idleWindowMs: 150, idleGraceMs: 100 });
    await w.warmUp('agent-a', 's-a1');

    await w.bus.fire('agents:deleted', deleteCtx([]), deletedPayload('agent-a'));
    expect(a1.state.kills).toBe(1);

    // The delete-time kill failed, so the only thing left to retire this runner
    // is the reaper: graceful cancel after the window, forced kill after grace.
    await vi.waitFor(() => { expect(w.cancels).toEqual(['s-a1']); }, { timeout: 2_000 });
    await vi.waitFor(() => { expect(a1.state.kills).toBe(2); }, { timeout: 2_000 });
  });

  it('is a no-op for an agent with no warm sandbox, and for a malformed payload', async () => {
    // A guard against over-killing (a broad match would take other agents'
    // runners down with it), not a regression test: it also holds before the
    // subscriber exists.
    const a1 = makeHandle();
    const w = await makeWorld({ handles: { 's-a1': a1 } });
    await w.warmUp('agent-a', 's-a1');

    const logs: LogLine[] = [];
    for (const payload of [
      deletedPayload('agent-unknown'),
      deletedPayload('agent'),        // a prefix of a live agent id
      { agentId: '' },
      { agentId: 42 },
      {},
      null,
      undefined,
    ]) {
      const res = await w.bus.fire('agents:deleted', deleteCtx(logs), payload);
      expect(res.rejected).toBe(false);
    }
    await flush();

    expect(a1.state.kills).toBe(0);
    expect(w.proxyClosed).toEqual([]);
    expect(logs.filter((l) => typeof l.msg === 'string' && l.msg.startsWith('agent_deleted'))).toEqual([]);
  });

  it('forgets the agent\'s system-prompt augment generation', async () => {
    // Routing treats a live session this process did not spawn as stale once
    // its agent has any recorded augment change, and re-spawns it. Deleting the
    // agent must drop that record, otherwise the map grows by one entry per
    // deleted agent forever. Observable through routing: after the delete the
    // same live session is routed into instead of retired.
    const conv = { activeSessionId: 'ext-1' as string | null };
    const live = new Set<string>(['ext-1']);
    const fresh = makeHandle();
    const w = await makeWorld({
      handles: { 'ext-1': fresh },
      // Isolate augment-generation cleanup from the keepalive host-ownership gate.
      keepAlive: false,
      extraServices: {
        'session:is-alive': async (_c, input: unknown) => ({
          alive: live.has((input as { sessionId: string }).sessionId),
        }),
        'conversations:get': async (_c, input: unknown) => {
          const i = input as { conversationId: string; userId: string };
          return { conversation: {
            conversationId: i.conversationId, userId: i.userId, agentId: 'agent-a',
            activeSessionId: conv.activeSessionId, activeReqId: null,
          } };
        },
        'conversations:bind-session': async () => undefined,
      },
    });

    const invokeOnConversation = async (sessionId: string, reqId: string) => {
      setImmediate(() => { void w.bus.fire('chat:end', ctxWith({ sessionId, agentId: 'agent-a', reqId, conversationId: 'conv-1' }), { outcome: { kind: 'complete', messages: [] } }); });
      return w.bus.call<unknown, AgentOutcome>('agent:invoke',
        ctxWith({ sessionId, agentId: 'agent-a', reqId, conversationId: 'conv-1' }),
        { message: { role: 'user', content: 'hi' } });
    };

    // An augment change is recorded, then the agent is deleted.
    await w.bus.fire('system-prompt:augment-changed', deleteCtx([]), { agentId: 'agent-a' });
    await w.bus.fire('agents:deleted', deleteCtx([]), deletedPayload('agent-a'));

    const out = await invokeOnConversation('ext-1', 'req-1');
    expect(out).toEqual({ kind: 'complete', messages: [] });
    expect(w.opened).toEqual([]); // routed into ext-1; no stale-session respawn
  });
});
