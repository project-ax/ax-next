/**
 * R27 — no phantom signals across a sandbox restart, through the REAL emitter.
 *
 * A real @ax/chat-orchestrator turn calls `restart_with_services`; the runner's
 * turn-ends go through the same `fireEventTurnEnd` the dispatcher calls. Stub
 * callers stand in for the web stream / Slack / routines (they end a turn on
 * the first `chat:turn-end` naming it, or on `chat:turn-error`), for
 * @ax/conversations (compare-and-clear of `active_req_id` on turn-end, and the
 * session:terminate unbind), and for @ax/agent-activity (forgets the turn on
 * turn-end / turn-error / chat:end). Across the restart none of them may see a
 * thing until the continuation's own turn-end, which they see once.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_TURN_SEGMENT_END_HOOK,
  createLogger,
  makeAgentContext,
  PluginError,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
// Test-only cross-plugin import (eslint allowlists `src/__tests__/**`): the
// hold answer is the orchestrator's, so it needs the real one.
import { createChatOrchestratorPlugin } from '@ax/chat-orchestrator';
import { fireEventTurnEnd } from '../handlers/event-turn-end.js';

const DIGEST = '@sha256:' + 'a'.repeat(64);
const AGENT = {
  id: 'agent-1', ownerId: 'user-1', ownerType: 'user' as const, visibility: 'personal' as const,
  displayName: 'Fern', allowedTools: ['file.read'], mcpConfigIds: [],
  model: 'anthropic/claude-sonnet-4-7', runner: 'claude-sdk',
};

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup() {
  const row = { activeSessionId: null as string | null, activeReqId: null as string | null, serviceSet: null as string | null };
  const live = new Set<string>();
  const opens: string[] = [];
  const queued: Array<{ sessionId: string; entry: { type: string; reqId?: string } }> = [];
  // What the callers observed, in order.
  const events: string[] = [];
  const activity = new Set<string>();

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({ agent: { ...AGENT } }),
    'connectors:list-effective': async () => ({
      connectors: [{
        summary: { id: 'e2e' }, source: 'attached',
        capabilities: {
          allowedHosts: [], credentials: [], mcpServers: [], servicesMode: 'on-demand',
          services: [{ name: 'mongo', image: 'mongo' + DIGEST, ports: [27017], env: {}, writablePaths: [] }],
        },
      }],
    }),
    'session:queue-work': async (_c, input: unknown) => {
      queued.push(input as (typeof queued)[number]);
      return { cursor: queued.length };
    },
    'session:terminate': async (c, input: unknown) => {
      const sessionId = (input as { sessionId: string }).sessionId;
      live.delete(sessionId);
      if (row.activeSessionId === sessionId) {
        events.push(`unbound:${row.activeReqId}`);
        row.activeSessionId = null;
        row.activeReqId = null;
      }
      await h.bus.fire('session:terminate', c, { sessionId });
      return {};
    },
    'session:is-alive': async (_c, input: unknown) => ({ alive: live.has((input as { sessionId: string }).sessionId) }),
    'conversations:get': async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      if (i.userId !== AGENT.ownerId) throw new PluginError({ code: 'not-found', plugin: 'test', message: 'nf' });
      return { conversation: { conversationId: i.conversationId, userId: i.userId, agentId: AGENT.id, ...row } };
    },
    'conversations:bind-session': async (_c, input: unknown) => {
      const i = input as { sessionId: string; reqId: string };
      row.activeSessionId = i.sessionId;
      row.activeReqId = i.reqId;
      return undefined;
    },
    'conversations:set-service-set': async (_c, input: unknown) => {
      row.serviceSet = (input as { serviceSet: string | null }).serviceSet;
      return { ok: true };
    },
    'sandbox:open-session': async (_c, input: unknown) => {
      const sessionId = (input as { sessionId: string }).sessionId;
      opens.push(sessionId);
      live.add(sessionId);
      let exit!: () => void;
      const exited = new Promise<{ code: number | null; signal: null }>((r) => { exit = () => r({ code: 0, signal: null }); });
      return { runnerEndpoint: 'unix:///tmp/x.sock', handle: { kill: async () => exit(), exited } };
    },
    'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
    'proxy:close-session': async () => ({}),
  };
  const h = await createTestHarness({
    services,
    plugins: [createChatOrchestratorPlugin({
      runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 60_000,
      keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000,
    })],
  });
  h.bus.subscribe<unknown>('chat:start', 'test/activity', async (c) => {
    activity.add(c.reqId);
    return undefined;
  });
  h.bus.subscribe<{ reqId?: string }>('chat:turn-end', 'test/callers', async (_c, p) => {
    events.push(`turn-end:${p.reqId}`);
    // @ax/conversations: compare-and-clear active_req_id. @ax/agent-activity: forget the turn.
    if (p.reqId !== undefined && row.activeReqId === p.reqId) {
      events.push(`req-cleared:${p.reqId}`);
      row.activeReqId = null;
    }
    if (p.reqId !== undefined) activity.delete(p.reqId);
    return undefined;
  });
  h.bus.subscribe<{ reqId: string; reason: string }>('chat:turn-error', 'test/callers', async (_c, p) => {
    events.push(`turn-error:${p.reqId}:${p.reason}`);
    activity.clear();
    return undefined;
  });
  h.bus.subscribe<unknown>('chat:end', 'test/callers', async () => {
    events.push('chat-end');
    activity.clear();
    return undefined;
  });
  h.bus.subscribe<{ reqId?: string }>(CHAT_TURN_SEGMENT_END_HOOK, 'test/segments', async (_c, p) => {
    events.push(`segment-end:${p.reqId}`);
    return undefined;
  });

  const ipcCtx = (sessionId: string) =>
    makeAgentContext({
      sessionId, agentId: AGENT.id, userId: AGENT.ownerId, conversationId: 'conv-1', reqId: 'ipc-fresh',
      logger: createLogger({ reqId: 'ipc-fresh', writer: () => undefined }),
    });
  const turnEnd = (sessionId: string, reqId: string, role: 'tool' | 'assistant') =>
    fireEventTurnEnd(ipcCtx(sessionId), h.bus, { reason: 'user-message-wait', role, reqId });
  const invoke = (reqId: string) =>
    h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      makeAgentContext({
        sessionId: 's-1', agentId: AGENT.id, userId: AGENT.ownerId, conversationId: 'conv-1', reqId,
        logger: createLogger({ reqId, writer: () => undefined }),
      }),
      { message: { role: 'user', content: 'run the e2e tests' } },
    );
  return { h, row, opens, queued, events, activity, ipcCtx, turnEnd, invoke };
}

describe('a services restart through the real turn-end emitter (R27)', () => {
  it('callers see exactly one chat:turn-end, at the end of the continuation, and nothing in between', async () => {
    const t = await setup();
    const p = t.invoke('req-1');
    await waitFor(() => t.queued.length === 1, 'the message');
    const accepted = await t.h.bus.call<unknown, { ok: boolean }>(
      'tool:execute:restart_with_services', t.ipcCtx('s-1'), { id: 'c1', name: 'restart_with_services', input: { set: 'e2e' } },
    );
    expect(accepted.ok).toBe(true);

    // The segment's two turn-ends, through the real emitter.
    await t.turnEnd('s-1', 'req-1', 'tool');
    await t.turnEnd('s-1', 'req-1', 'assistant');
    await waitFor(() => t.queued.some((q) => q.entry.type === 'host-note'), 'the host note');
    const newSession = t.opens[1]!;

    // Mid-restart: no turn end, no error, no active_req_id clear, no unbind,
    // and the agent's activity line still names the turn.
    expect(t.events).toEqual(['segment-end:req-1', 'segment-end:req-1']);
    expect(t.row).toMatchObject({ activeSessionId: newSession, activeReqId: 'req-1', serviceSet: 'e2e' });
    expect(t.activity.has('req-1')).toBe(true);

    await t.turnEnd(newSession, 'req-1', 'assistant');
    expect(await p).toEqual({ kind: 'complete', messages: [] });
    expect(t.events).toEqual([
      'segment-end:req-1', 'segment-end:req-1', 'turn-end:req-1', 'req-cleared:req-1',
    ]);
    expect(t.activity.has('req-1')).toBe(false);
  });

  it('a normal turn still fires chat:turn-end and no segment-end', async () => {
    const t = await setup();
    const p = t.invoke('req-1');
    await waitFor(() => t.queued.length === 1, 'the message');
    await t.turnEnd('s-1', 'req-1', 'tool');
    await t.turnEnd('s-1', 'req-1', 'assistant');
    await p;
    expect(t.events).toEqual(['turn-end:req-1', 'req-cleared:req-1', 'turn-end:req-1']);
    expect(t.opens).toHaveLength(1);
  });
});
