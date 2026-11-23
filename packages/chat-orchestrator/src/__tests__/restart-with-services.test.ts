import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_TURN_END_HOLD_HOOK,
  CHAT_TURN_SEGMENT_END_HOOK,
  HookBus,
  PluginError,
  createLogger,
  makeAgentContext,
  type AgentContextSource,
  type AgentOutcome,
  type ChatTurnEndHoldPayload,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';
import { RESTART_WITH_SERVICES, STOP_SERVICES, type ServiceToolResult } from '../service-tools.js';

// ---------------------------------------------------------------------------
// Dev services on demand (spec §3.2, R27) — restart_with_services swaps the
// sandbox INSIDE one agent:invoke. The runner and @ax/ipc-core are simulated:
// a tool call is a `tool:execute:<name>` call with the runner's IPC ctx, and a
// runner turn-end goes through `emitTurnEnd`, which does what ipc-core's
// `fireEventTurnEnd` does (ask `chat:turn-end-hold`, then fire the segment-end
// or `chat:turn-end`). @ax/ipc-core's own test drives the real emitter.
// ---------------------------------------------------------------------------

const DIGEST = '@sha256:' + 'a'.repeat(64);
const MONGO = {
  name: 'mongo',
  image: 'mongo' + DIGEST,
  ports: [27017],
  env: {},
  writablePaths: [],
  publishedPorts: [{ published: 47017, target: 27017 }],
};
const AGENT = {
  id: 'agent-1', ownerId: 'user-1', ownerType: 'user' as const, visibility: 'personal' as const,
  displayName: 'Fern', allowedTools: ['file.read'], mcpConfigIds: [],
  model: 'anthropic/claude-sonnet-4-7', runner: 'claude-sdk',
};

type ConnectorMode = 'on-demand' | 'always';

interface Row {
  activeSessionId: string | null;
  activeReqId: string | null;
  serviceSet: string | null;
}

function makeHandle() {
  let resolveExit!: () => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    resolveExit = () => res({ code: 0, signal: null });
  });
  const state = { kills: 0 };
  return { state, handle: { kill: async () => { state.kills += 1; resolveExit(); }, exited } };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await flush();
  }
  // Then by the clock, for steps that wait on a timer (a turn limit).
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup(opts: {
  rows?: Record<string, Partial<Row>>;
  connectorMode?: ConnectorMode;
  connectorId?: string;
  maxPerAgent?: number;
  enabled?: boolean;
  chatTimeoutMs?: number;
  /** Hold the Nth sandbox:open-session until this resolves. */
  openGate?: { on: number; until: Promise<void> };
  /** The invoking request's logger throws on a line containing this. */
  throwOnLog?: string;
  openSessionThrowsOn?: number;
} = {}) {
  const rows: Record<string, Row> = {};
  for (const [id, r] of Object.entries(opts.rows ?? {})) {
    rows[id] = { activeSessionId: null, activeReqId: null, serviceSet: null, ...r };
  }
  const row = (id: string): Row => (rows[id] ??= { activeSessionId: null, activeReqId: null, serviceSet: null });
  const live = new Set<string>();
  const opens: Array<{ sessionId: string; services?: Array<{ name: string }> }> = [];
  const handles = new Map<string, ReturnType<typeof makeHandle>>();
  const queued: Array<{ sessionId: string; entry: { type: string; reqId?: string; note?: string } }> = [];
  const terminated: string[] = [];
  const setServiceSetCalls: Array<{ conversationId: string; userId: string; serviceSet: string | null }> = [];
  const turnEnds: Array<{ reqId?: string; sessionId: string }> = [];
  const segmentEnds: Array<{ reqId?: string; sessionId: string }> = [];
  const turnErrors: Array<{ reqId: string; reason: string; detail?: string }> = [];
  const activeReqClears: string[] = [];
  const logs: string[] = [];

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({ agent: { ...AGENT } }),
    'connectors:list-effective': async () => ({
      connectors: [{
        summary: { id: opts.connectorId ?? 'e2e' },
        source: 'attached',
        capabilities: {
          allowedHosts: [], credentials: [], mcpServers: [],
          servicesMode: opts.connectorMode ?? 'on-demand',
          services: [MONGO],
        },
      }],
    }),
    'session:queue-work': async (_c, input: unknown) => {
      queued.push(input as (typeof queued)[number]);
      return { cursor: queued.length };
    },
    'session:terminate': async (c, input: unknown) => {
      const sessionId = (input as { sessionId: string }).sessionId;
      terminated.push(sessionId);
      live.delete(sessionId);
      // @ax/conversations' session:terminate subscriber: clear rows still bound to it.
      for (const [id, r] of Object.entries(rows)) {
        if (r.activeSessionId === sessionId) {
          r.activeSessionId = null;
          if (r.activeReqId !== null) activeReqClears.push(`${id}:${r.activeReqId}`);
          r.activeReqId = null;
        }
      }
      await busRef.bus!.fire('session:terminate', c, { sessionId });
      return {};
    },
    'session:is-alive': async (_c, input: unknown) => ({ alive: live.has((input as { sessionId: string }).sessionId) }),
    'conversations:get': async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      if (i.userId !== AGENT.ownerId) throw new PluginError({ code: 'not-found', plugin: 'test', message: 'nf' });
      const r = row(i.conversationId);
      return { conversation: { conversationId: i.conversationId, userId: i.userId, agentId: AGENT.id, ...r } };
    },
    'conversations:bind-session': async (_c, input: unknown) => {
      const i = input as { conversationId: string; sessionId: string; reqId: string };
      const r = row(i.conversationId);
      r.activeSessionId = i.sessionId;
      r.activeReqId = i.reqId;
      return undefined;
    },
    'conversations:set-service-set': async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string; serviceSet: string | null };
      setServiceSetCalls.push(i);
      row(i.conversationId).serviceSet = i.serviceSet;
      return { ok: true };
    },
    'sandbox:open-session': async (_c, input: unknown) => {
      const i = input as { sessionId: string; services?: Array<{ name: string }> };
      opens.push({ sessionId: i.sessionId, ...(i.services !== undefined ? { services: i.services } : {}) });
      if (opts.openGate !== undefined && opts.openGate.on === opens.length) await opts.openGate.until;
      if (opts.openSessionThrowsOn === opens.length) {
        throw new PluginError({
          code: 'service-sidecar-failed', plugin: '@ax/sandbox-k8s', hookName: 'sandbox:open-session',
          message: "dev service 'mongo' failed to start",
          diagnosis: { service: 'mongo', path: '/data/db', reason: 'read-only filesystem' },
        });
      }
      live.add(i.sessionId);
      const hk = makeHandle();
      handles.set(i.sessionId, hk);
      return { runnerEndpoint: 'unix:///tmp/x.sock', handle: hk.handle };
    },
    'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
    'proxy:close-session': async () => ({}),
  };
  const busRef: { bus: HookBus | null } = { bus: null };
  const h = await createTestHarness({
    services,
    plugins: [createChatOrchestratorPlugin({
      runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: opts.chatTimeoutMs ?? 60_000,
      keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000,
      onDemandServices: {
        ...(opts.maxPerAgent !== undefined ? { maxPerAgent: opts.maxPerAgent } : {}),
        ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
      },
    })],
  });
  busRef.bus = h.bus;
  // The callers: every chat:turn-end and chat:turn-error, by reqId. A turn-end
  // is what closes a web stream, ends a Slack reply, finishes a routine run
  // and clears active_req_id; none may arrive mid-restart.
  h.bus.subscribe<{ reqId?: string }>('chat:turn-end', 'test/callers', async (c, p) => {
    turnEnds.push({ reqId: p.reqId, sessionId: c.sessionId });
    // @ax/conversations: compare-and-clear active_req_id on the turn's end.
    const r = c.conversationId !== undefined ? rows[c.conversationId] : undefined;
    if (r !== undefined && p.reqId !== undefined && r.activeReqId === p.reqId) r.activeReqId = null;
    return undefined;
  });
  h.bus.subscribe<{ reqId?: string }>(CHAT_TURN_SEGMENT_END_HOOK, 'test/segments', async (c, p) => {
    segmentEnds.push({ reqId: p.reqId, sessionId: c.sessionId });
    return undefined;
  });
  h.bus.subscribe<{ reqId: string; reason: string; detail?: string }>('chat:turn-error', 'test/callers', async (_c, p) => {
    turnErrors.push(p);
    return undefined;
  });

  const ipcCtx = (sessionId: string, conversationId: string, source?: AgentContextSource) =>
    makeAgentContext({
      sessionId, agentId: AGENT.id, userId: AGENT.ownerId, conversationId, reqId: 'ipc-fresh',
      ...(source !== undefined ? { source } : {}),
      logger: createLogger({ reqId: 'ipc-fresh', writer: (line) => { logs.push(line); } }),
    });

  /** Mirrors @ax/ipc-core `fireEventTurnEnd`: ask the hold, then segment-end or chat:turn-end. */
  async function emitTurnEnd(
    sessionId: string, conversationId: string, reqId: string, role: 'tool' | 'assistant', foldedReqIds?: string[],
  ) {
    const c = ipcCtx(sessionId, conversationId);
    const payload = { reason: 'user-message-wait', role, reqId, ...(foldedReqIds !== undefined ? { foldedReqIds } : {}) };
    const answer = await h.bus.fire<ChatTurnEndHoldPayload>(CHAT_TURN_END_HOLD_HOOK, c, { sessionId, reqId, held: false });
    if (!answer.rejected && answer.payload.held) await h.bus.fire(CHAT_TURN_SEGMENT_END_HOOK, c, payload);
    else await h.bus.fire('chat:turn-end', c, payload);
  }
  /** A runner segment ends: its two turn-ends, tool then assistant. */
  async function endSegment(sessionId: string, conversationId: string, reqId: string, foldedReqIds?: string[]) {
    await emitTurnEnd(sessionId, conversationId, reqId, 'tool', foldedReqIds);
    await emitTurnEnd(sessionId, conversationId, reqId, 'assistant', foldedReqIds);
  }
  function tool(name: string, sessionId: string, conversationId: string, input: unknown, source?: AgentContextSource) {
    return h.bus.call<unknown, ServiceToolResult>(`tool:execute:${name}`, ipcCtx(sessionId, conversationId, source), {
      id: 'call-1', name, input,
    });
  }
  function invoke(sessionId: string, conversationId: string, reqId: string, source?: AgentContextSource) {
    return h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      makeAgentContext({
        sessionId, agentId: AGENT.id, userId: AGENT.ownerId, conversationId, reqId,
        ...(source !== undefined ? { source } : {}),
        logger: createLogger({
          reqId,
          writer: (line) => {
            logs.push(line);
            if (opts.throwOnLog !== undefined && line.includes(opts.throwOnLog)) throw new Error('log sink down');
          },
        }),
      }),
      { message: { role: 'user', content: 'run the e2e tests' } },
    );
  }
  const notes = () => queued.filter((q) => q.entry.type === 'host-note');
  return {
    h, rows, row, opens, handles, queued, terminated, setServiceSetCalls, turnEnds, segmentEnds, turnErrors,
    activeReqClears, logs, emitTurnEnd, endSegment, tool, invoke, notes,
  };
}

describe('restart_with_services (dev services on demand)', () => {
  it('restart swaps the sandbox inside one invoke and the turn continues', async () => {
    const t = await setup();
    const p = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.some((q) => q.entry.type === 'user-message'), 'the first message');
    expect(t.opens).toHaveLength(1);
    expect(t.opens[0]!.services).toBeUndefined(); // an on-demand set is off until asked for

    const r = await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' });
    expect(r).toEqual({ ok: true, message: expect.stringContaining('Your turn ends here') });
    expect(t.row('conv-1').serviceSet).toBe('e2e');

    await t.endSegment('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.notes().length === 1, 'the host note');
    // Two opens, the second with the set; the note under the SAME request.
    expect(t.opens).toHaveLength(2);
    const second = t.opens[1]!;
    expect(second.sessionId).not.toBe('s-1');
    expect(second.services?.map((s) => s.name)).toEqual(['mongo']);
    const note = t.notes()[0]!;
    expect(note.sessionId).toBe(second.sessionId);
    expect(note.entry.reqId).toBe('req-1');
    expect(note.entry.note).toContain('mongo at mongo:27017 (also localhost:47017)');
    // The old sandbox is closed; the conversation names the new one and still the request.
    expect(t.terminated).toContain('s-1');
    expect(t.handles.get('s-1')!.state.kills).toBe(1);
    expect(t.row('conv-1')).toMatchObject({ activeSessionId: second.sessionId, activeReqId: 'req-1' });

    // The continuation ends the turn: ONE chat:turn-end for the request, at the very end.
    expect(t.turnEnds).toEqual([]);
    await t.emitTurnEnd(second.sessionId, 'conv-1', 'req-1', 'assistant');
    const out = await p;
    expect(out).toEqual({ kind: 'complete', messages: [] });
    expect(t.turnEnds.filter((e) => e.reqId === 'req-1')).toHaveLength(1);
    expect(t.segmentEnds.map((e) => e.sessionId)).toEqual(['s-1', 's-1']);
    expect(t.turnErrors).toEqual([]);
    expect(t.activeReqClears).toEqual([]);
  });

  it('a restart from a routed (warm) turn swaps without a turn-error (R19)', async () => {
    const t = await setup();
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'turn 1');
    await t.emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant');
    await p1;
    const p2 = t.invoke('placeholder', 'conv-1', 'req-2');
    await waitFor(() => t.queued.length === 2, 'turn 2 routed');
    expect(t.opens).toHaveLength(1); // routed into s-1
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    await t.endSegment('s-1', 'conv-1', 'req-2');
    await waitFor(() => t.notes().length === 1, 'the host note');
    const second = t.opens[1]!;
    await t.emitTurnEnd(second.sessionId, 'conv-1', 'req-2', 'assistant');
    expect(await p2).toEqual({ kind: 'complete', messages: [] });
    expect(t.turnErrors).toEqual([]);
    expect(t.turnEnds.filter((e) => e.reqId === 'req-2')).toHaveLength(1);
  });

  it('refuses when services are already on', async () => {
    const t = await setup({ rows: { 'conv-1': { serviceSet: 'e2e' } } });
    const p = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'the first message');
    expect(t.opens[0]!.services?.map((s) => s.name)).toEqual(['mongo']); // the set is on: folded
    const r = await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('already running');
    expect(r.message).toContain('stop_services');
    // Not held: the turn ends as usual, with no second sandbox.
    await t.endSegment('s-1', 'conv-1', 'req-1');
    await p;
    expect(t.opens).toHaveLength(1);
    expect(t.setServiceSetCalls).toEqual([]);
  });

  it('refuses a second restart in the same invoke', async () => {
    const t = await setup();
    const p = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'the first message');
    const [a, b] = await Promise.all([
      t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' }),
      t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((a.ok ? b : a).message).toContain('already restarted once');
    await t.endSegment('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.notes().length === 1, 'the host note');
    const second = t.opens[1]!.sessionId;
    // From the new sandbox, the same request can't restart again.
    const again = await t.tool(RESTART_WITH_SERVICES, second, 'conv-1', { set: 'e2e' });
    expect(again.ok).toBe(false);
    expect(again.message).toContain('already restarted once');
    await t.emitTurnEnd(second, 'conv-1', 'req-1', 'assistant');
    await p;
    expect(t.opens).toHaveLength(2);
  });

  it('refuses an unknown set', async () => {
    const t = await setup();
    const p = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'the first message');
    const r = await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'nope' });
    expect(r).toEqual({ ok: false, message: expect.stringContaining('Yours: e2e') });
    const bad = await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e', extra: 1 });
    expect(bad.ok).toBe(false);
    await t.endSegment('s-1', 'conv-1', 'req-1');
    await p;
    expect(t.opens).toHaveLength(1);
    expect(t.row('conv-1').serviceSet).toBeNull();
  });

  it('concurrent restarts at the cap admit one', async () => {
    const t = await setup({ maxPerAgent: 1 });
    const pa = t.invoke('s-a', 'conv-a', 'req-a');
    const pb = t.invoke('s-b', 'conv-b', 'req-b');
    await waitFor(() => t.queued.length === 2, 'both messages');
    const [a, b] = await Promise.all([
      t.tool(RESTART_WITH_SERVICES, 's-a', 'conv-a', { set: 'e2e' }),
      t.tool(RESTART_WITH_SERVICES, 's-b', 'conv-b', { set: 'e2e' }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const loser = a.ok ? b : a;
    expect(loser.message).toContain('already has 1 conversations running services');
    const [winConv, winSession, winReq, loseConv, loseSession, loseReq] = a.ok
      ? ['conv-a', 's-a', 'req-a', 'conv-b', 's-b', 'req-b']
      : ['conv-b', 's-b', 'req-b', 'conv-a', 's-a', 'req-a'];
    expect(t.row(loseConv).serviceSet).toBeNull();
    // The loser's turn ends normally; the winner restarts.
    await t.endSegment(loseSession, loseConv, loseReq);
    await t.endSegment(winSession, winConv, winReq);
    await waitFor(() => t.notes().length === 1, 'the host note');
    await t.emitTurnEnd(t.opens[2]!.sessionId, winConv, winReq, 'assistant');
    await Promise.all([pa, pb]);
    expect(t.opens.filter((o) => o.services !== undefined)).toHaveLength(1);
  });

  it('a failed restart clears serviceSet and reports the service', async () => {
    const t = await setup({ openSessionThrowsOn: 2 });
    const p = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'the first message');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    await t.endSegment('s-1', 'conv-1', 'req-1');
    const out = await p;
    expect(out).toMatchObject({ kind: 'terminated', reason: 'dev-service-failed' });
    // TASK-160's diagnosis on the request's own turn-error.
    expect(t.turnErrors).toEqual([
      { reqId: 'req-1', reason: 'dev-service-failed', detail: expect.stringContaining('mongo') },
    ]);
    // The set is cleared, so the next turn isn't stuck failing the same way.
    expect(t.setServiceSetCalls.at(-1)).toEqual({ conversationId: 'conv-1', userId: AGENT.ownerId, serviceSet: null });
    expect(t.row('conv-1').serviceSet).toBeNull();
    // No orphan: the new session was terminated too, and the old one before it.
    const failed = t.opens[1]!.sessionId;
    expect(t.terminated).toEqual(['s-1', failed]);
    // No leaked slot: with a cap of 1 this would refuse. Next turn re-spawns plainly.
    const p2 = t.invoke('s-2', 'conv-1', 'req-2');
    await waitFor(() => t.queued.filter((q) => q.entry.type === 'user-message').length === 2, 'turn 2');
    expect(t.opens.at(-1)!.services).toBeUndefined();
    await t.emitTurnEnd(t.opens.at(-1)!.sessionId, 'conv-1', 'req-2', 'assistant');
    await p2;
  });

  it('a failed restart releases its slot (cap of 1)', async () => {
    const t = await setup({ openSessionThrowsOn: 2, maxPerAgent: 1 });
    const p = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'the first message');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    await t.endSegment('s-1', 'conv-1', 'req-1');
    await p;
    const p2 = t.invoke('s-2', 'conv-2', 'req-2');
    await waitFor(() => t.queued.filter((q) => q.entry.type === 'user-message').length === 2, 'turn 2');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-2', 'conv-2', { set: 'e2e' })).ok).toBe(true);
    await t.endSegment('s-2', 'conv-2', 'req-2');
    await waitFor(() => t.notes().length === 1, 'the host note');
    await t.emitTurnEnd(t.opens.at(-1)!.sessionId, 'conv-2', 'req-2', 'assistant');
    await p2;
  });

  it('a Stop before the segment ends calls the restart off; callers see the turn end', async () => {
    const t = await setup();
    const p = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'the first message');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    const stop = await t.h.bus.call<unknown, { interrupted: boolean }>(
      'agent:interrupt', makeAgentContext({ sessionId: 'x', agentId: AGENT.id, userId: AGENT.ownerId }),
      { conversationId: 'conv-1', userId: AGENT.ownerId },
    );
    expect(stop.interrupted).toBe(true);
    await t.endSegment('s-1', 'conv-1', 'req-1');
    await p;
    expect(t.segmentEnds).toEqual([]);
    expect(t.turnEnds.filter((e) => e.reqId === 'req-1')).toHaveLength(2);
    expect(t.opens).toHaveLength(1);
    await waitFor(() => t.row('conv-1').serviceSet === null, 'the set cleared');
  });

  it('a vanished set is cleared at routing', async () => {
    // The row names a set no on-demand connector offers any more (deleted).
    const gone = await setup({ rows: { 'conv-1': { serviceSet: 'old-set' } } });
    const p = gone.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => gone.queued.length === 1, 'the message');
    expect(gone.opens[0]!.services).toBeUndefined();
    expect(gone.setServiceSetCalls).toEqual([{ conversationId: 'conv-1', userId: AGENT.ownerId, serviceSet: null }]);
    await gone.emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant');
    expect(await p).toEqual({ kind: 'complete', messages: [] });
    expect(gone.turnErrors).toEqual([]);

    // The connector was switched to always-on: its services fold as always-on, and the set is cleared.
    const always = await setup({ rows: { 'conv-1': { serviceSet: 'e2e' } }, connectorMode: 'always' });
    const p2 = always.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => always.queued.length === 1, 'the message');
    expect(always.opens[0]!.services?.map((s) => s.name)).toEqual(['mongo']);
    expect(always.row('conv-1').serviceSet).toBeNull();
    await always.emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant');
    await p2;
  });

  it('stop_services clears the set; the next routing retires the warm sandbox', async () => {
    const t = await setup({ rows: { 'conv-1': { serviceSet: 'e2e' } } });
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'turn 1');
    expect(t.opens[0]!.services?.map((s) => s.name)).toEqual(['mongo']);
    const stop = await t.tool(STOP_SERVICES, 's-1', 'conv-1', {});
    expect(stop).toEqual({ ok: true, message: expect.stringContaining('Services are off') });
    expect(t.row('conv-1').serviceSet).toBeNull();
    await t.emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant');
    await p1;
    expect(t.terminated).toEqual([]); // nothing restarts now

    const p2 = t.invoke('placeholder', 'conv-1', 'req-2');
    await waitFor(() => t.queued.length === 2, 'turn 2');
    expect(t.terminated).toEqual(['s-1']);
    expect(t.opens).toHaveLength(2);
    expect(t.opens[1]!.services).toBeUndefined();
    expect(t.logs.some((l) => l.includes('service-set-changed'))).toBe(true);
    await t.emitTurnEnd(t.opens[1]!.sessionId, 'conv-1', 'req-2', 'assistant');
    await p2;
  });

  it('a routine invoke can restart; the next check-in starts without services', async () => {
    const t = await setup();
    const p = t.invoke('s-r1', 'conv-run-1', 'req-r1', 'routine');
    await waitFor(() => t.queued.length === 1, 'check-in 1');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-r1', 'conv-run-1', { set: 'e2e' }, 'routine')).ok).toBe(true);
    await t.endSegment('s-r1', 'conv-run-1', 'req-r1');
    await waitFor(() => t.notes().length === 1, 'the host note');
    expect(t.opens[1]!.services?.map((s) => s.name)).toEqual(['mongo']);
    await t.emitTurnEnd(t.opens[1]!.sessionId, 'conv-run-1', 'req-r1', 'assistant');
    expect(await p).toEqual({ kind: 'complete', messages: [] });
    expect(t.turnEnds.filter((e) => e.reqId === 'req-r1')).toHaveLength(1);

    // The next check-in is a fresh conversation: no services.
    const p2 = t.invoke('s-r2', 'conv-run-2', 'req-r2', 'routine');
    await waitFor(() => t.queued.filter((q) => q.entry.type === 'user-message').length === 2, 'check-in 2');
    expect(t.opens.at(-1)!.services).toBeUndefined();
    await t.emitTurnEnd(t.opens.at(-1)!.sessionId, 'conv-run-2', 'req-r2', 'assistant');
    await p2;
  });

  it('a normal turn is not held: chat:turn-end, no segment-end', async () => {
    const t = await setup();
    const p = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'the message');
    await t.endSegment('s-1', 'conv-1', 'req-1');
    await p;
    expect(t.segmentEnds).toEqual([]);
    expect(t.turnEnds.map((e) => e.reqId)).toEqual(['req-1', 'req-1']);
  });

  it('on-demand services off on this host: nothing folds and the tool refuses', async () => {
    const t = await setup({ enabled: false, rows: { 'conv-1': { serviceSet: 'e2e' } } });
    const p = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'the message');
    expect(t.opens[0]!.services).toBeUndefined();
    const r = await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' });
    expect(r).toEqual({ ok: false, message: expect.stringContaining('turned off on this host') });
    await t.endSegment('s-1', 'conv-1', 'req-1');
    await p;
    expect(t.opens).toHaveLength(1);
  });

  it('refuses a cap that is not a positive integer at init', async () => {
    for (const maxPerAgent of [0, -1, 1.5, Number.NaN]) {
      await expect(setup({ maxPerAgent })).rejects.toThrow(/maxPerAgent must be a positive integer/);
    }
  });

  // ---- Fix round 1 -------------------------------------------------------

  /** Settles-once probe: how many times an invoke's promise settled, and with what. */
  function track(p: Promise<AgentOutcome>) {
    const seen: AgentOutcome[] = [];
    void p.then((o) => { seen.push(o); });
    return seen;
  }

  it('R30: a message queued behind the restarting turn moves to the new sandbox, after the note', async () => {
    const t = await setup();
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'turn 1');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    // A second message arrives while the segment runs: routed into the busy s-1, not yet claimed.
    const p2 = t.invoke('placeholder', 'conv-1', 'req-2');
    await waitFor(() => t.queued.length === 2, 'message 2 queued on s-1');
    expect(t.queued[1]).toMatchObject({ sessionId: 's-1', entry: { type: 'user-message', reqId: 'req-2' } });
    const out1 = track(p1);
    const out2 = track(p2);

    await t.endSegment('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 4, 'the note and the moved message');
    const fresh = t.opens[1]!.sessionId;
    // On the new sandbox: the host note first, then the moved message.
    expect(t.queued.slice(2)).toEqual([
      { sessionId: fresh, entry: expect.objectContaining({ type: 'host-note', reqId: 'req-1' }) },
      { sessionId: fresh, entry: expect.objectContaining({ type: 'user-message', reqId: 'req-2' }) },
    ]);
    expect(t.turnErrors).toEqual([]);
    expect(out2).toEqual([]);

    await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
    await t.emitTurnEnd(fresh, 'conv-1', 'req-2', 'assistant');
    await Promise.all([p1, p2]);
    await flush();
    expect(out1).toEqual([{ kind: 'complete', messages: [] }]);
    expect(out2).toEqual([{ kind: 'complete', messages: [] }]);
    expect(t.turnErrors).toEqual([]);
  });

  it('R30: a message folded into the held segment settles with the restarting turn, never sandbox-terminated', async () => {
    const t = await setup();
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'turn 1');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    const p2 = t.invoke('placeholder', 'conv-1', 'req-2');
    await waitFor(() => t.queued.length === 2, 'message 2 queued on s-1');
    const out1 = track(p1);
    const out2 = track(p2);

    // The runner folded req-2 into the segment that called the restart.
    await t.endSegment('s-1', 'conv-1', 'req-1', ['req-2']);
    await waitFor(() => t.notes().length === 1, 'the note');
    const fresh = t.opens[1]!.sessionId;
    // Answered already: not queued again.
    expect(t.queued.filter((q) => q.sessionId === fresh).map((q) => q.entry.type)).toEqual(['host-note']);
    expect(t.turnErrors).toEqual([]);
    expect(out2).toEqual([]);

    await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
    await Promise.all([p1, p2]);
    await flush();
    expect(out1).toEqual([{ kind: 'complete', messages: [] }]);
    expect(out2).toEqual([{ kind: 'complete', messages: [] }]);
    expect(t.turnErrors).toEqual([]);
  });

  it('a live restarted sandbox keeps its slot; it comes back when that sandbox goes', async () => {
    const t = await setup({ maxPerAgent: 1 });
    const pa = t.invoke('s-a', 'conv-a', 'req-a');
    await waitFor(() => t.queued.length === 1, 'turn a');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-a', 'conv-a', { set: 'e2e' })).ok).toBe(true);
    await t.endSegment('s-a', 'conv-a', 'req-a');
    await waitFor(() => t.notes().length === 1, 'the note');
    const live = t.opens[1]!.sessionId;
    await t.emitTurnEnd(live, 'conv-a', 'req-a', 'assistant');
    await pa; // the request is over; its sandbox stays warm with the set

    const pb = t.invoke('s-b', 'conv-b', 'req-b');
    await waitFor(() => t.queued.filter((q) => q.entry.type === 'user-message').length === 2, 'turn b');
    const refused = await t.tool(RESTART_WITH_SERVICES, 's-b', 'conv-b', { set: 'e2e' });
    expect(refused).toEqual({ ok: false, message: expect.stringContaining('already has 1 conversations running services') });

    // conv-a's sandbox goes (reaped / terminated): the slot comes back.
    await t.h.bus.call('session:terminate', makeAgentContext({ sessionId: live, agentId: AGENT.id, userId: AGENT.ownerId }), { sessionId: live });
    expect((await t.tool(RESTART_WITH_SERVICES, 's-b', 'conv-b', { set: 'e2e' })).ok).toBe(true);
    await t.endSegment('s-b', 'conv-b', 'req-b');
    await waitFor(() => t.notes().length === 2, 'note b');
    await t.emitTurnEnd(t.opens.at(-1)!.sessionId, 'conv-b', 'req-b', 'assistant');
    await pb;
  });

  it('R29: a re-spawn at the cap opens without the set and clears it', async () => {
    const t = await setup({ maxPerAgent: 1, rows: { 'conv-c': { serviceSet: 'e2e' } } });
    const pa = t.invoke('s-a', 'conv-a', 'req-a');
    await waitFor(() => t.queued.length === 1, 'turn a');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-a', 'conv-a', { set: 'e2e' })).ok).toBe(true);
    await t.endSegment('s-a', 'conv-a', 'req-a');
    await waitFor(() => t.notes().length === 1, 'the note');
    await t.emitTurnEnd(t.opens[1]!.sessionId, 'conv-a', 'req-a', 'assistant');
    await pa;

    // conv-c had its set on; its sandbox was reaped; the agent is at its cap.
    const pc = t.invoke('s-c', 'conv-c', 'req-c');
    await waitFor(() => t.queued.filter((q) => q.entry.type === 'user-message').length === 2, 'turn c');
    expect(t.opens.at(-1)).toEqual({ sessionId: 's-c' }); // no services
    expect(t.row('conv-c').serviceSet).toBeNull();
    expect(t.setServiceSetCalls.at(-1)).toEqual({ conversationId: 'conv-c', userId: AGENT.ownerId, serviceSet: null });
    await t.emitTurnEnd('s-c', 'conv-c', 'req-c', 'assistant');
    await pc;
  });

  it('R32: a failed open of a sandbox carrying the set clears it (a re-spawn, not only a restart)', async () => {
    const t = await setup({ openSessionThrowsOn: 1, rows: { 'conv-1': { serviceSet: 'e2e' } } });
    const out = await t.invoke('s-1', 'conv-1', 'req-1');
    expect(out).toMatchObject({ kind: 'terminated', reason: 'dev-service-failed' });
    expect(t.opens[0]!.services?.map((s) => s.name)).toEqual(['mongo']);
    expect(t.row('conv-1').serviceSet).toBeNull();
    expect(t.turnErrors).toEqual([
      { reqId: 'req-1', reason: 'dev-service-failed', detail: expect.stringContaining('mongo') },
    ]);
  });

  it('R31: a held segment end settles only its own request, never the oldest waiter', async () => {
    // req-1 times out while its restart is pending; its turn-error is held up
    // by a slow subscriber, so the restart isn't called off yet. A segment end
    // naming req-1 then arrives: req-2, routed into the same sandbox, must not
    // be settled in its place.
    const t = await setup({ chatTimeoutMs: 150 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    t.h.bus.subscribe<{ reqId: string }>('chat:turn-error', 'test/slow', async (_c, p) => {
      if (p.reqId === 'req-1') await gate;
      return undefined;
    });
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'turn 1');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100)); // req-2's own clock runs out well after req-1's
    const p2 = t.invoke('placeholder', 'conv-1', 'req-2');
    await waitFor(() => t.queued.length === 2, 'message 2');
    const out2 = track(p2);
    await waitFor(() => t.turnErrors.some((e) => e.reqId === 'req-1'), 'req-1 timed out');
    await t.emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant');
    await flush();
    expect(out2).toEqual([]); // req-2 still waiting
    release();
    await p1;
    await p2;
    await flush();
    expect(out2).toEqual([expect.objectContaining({ kind: 'terminated', reason: 'chat-run-timeout' })]);
    expect(t.opens).toHaveLength(1);
  });

  // ---- Fix round 2 -------------------------------------------------------

  /** Restart req-1 on s-1 with req-2 routed in behind it; returns once the swap's note is queued. */
  async function restartWithQueued(t: Awaited<ReturnType<typeof setup>>) {
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'turn 1');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    const p2 = t.invoke('placeholder', 'conv-1', 'req-2');
    await waitFor(() => t.queued.length === 2, 'message 2 queued on s-1');
    return { p1, p2, out1: track(p1), out2: track(p2) };
  }

  it('N2: after the restarting turn ends, the row still binds the moved request, and Stop reaches it', async () => {
    const t = await setup();
    const { p1, p2, out2 } = await restartWithQueued(t);
    await t.endSegment('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 4, 'the note and the moved message');
    const fresh = t.opens[1]!.sessionId;
    expect(t.row('conv-1')).toMatchObject({ activeSessionId: fresh, activeReqId: 'req-2' });

    await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
    await p1;
    // req-1's turn end compare-and-clears req-1 only: the moved req-2 still owns the row.
    expect(t.row('conv-1').activeReqId).toBe('req-2');
    expect(out2).toEqual([]);

    const stop = await t.h.bus.call<unknown, { interrupted: boolean }>(
      'agent:interrupt', makeAgentContext({ sessionId: 'x', agentId: AGENT.id, userId: AGENT.ownerId }),
      { conversationId: 'conv-1', userId: AGENT.ownerId },
    );
    expect(stop.interrupted).toBe(true);
    expect(t.queued.at(-1)).toEqual({ sessionId: fresh, entry: { type: 'interrupt' } });
    await t.emitTurnEnd(fresh, 'conv-1', 'req-2', 'assistant');
    await p2;
    expect(t.row('conv-1').activeReqId).toBeNull();
    expect(t.turnErrors).toEqual([]);
  });

  it('N1: a moved request whose own turn timer fires during the swap is not re-attached or re-queued', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let openNew!: () => void;
      const t = await setup({
        chatTimeoutMs: 1_000,
        openGate: { on: 2, until: new Promise<void>((r) => { openNew = r; }) },
      });
      const { p1, p2, out2 } = await restartWithQueued(t);
      await t.endSegment('s-1', 'conv-1', 'req-1');
      await waitFor(() => t.opens.length === 2, 'the restart opening'); // held at the gate
      await vi.advanceTimersByTimeAsync(1_100); // req-2's own limit runs out while it is detached
      await waitFor(() => out2.length === 1, 'req-2 timed out');
      expect(out2).toEqual([expect.objectContaining({ kind: 'terminated', reason: 'chat-run-timeout' })]);

      openNew();
      await waitFor(() => t.notes().length === 1, 'the note');
      const fresh = t.opens[1]!.sessionId;
      await flush();
      // Only the note on the new sandbox: req-2 is not queued again, and the row stays on req-1.
      expect(t.queued.filter((q) => q.sessionId === fresh).map((q) => q.entry.type)).toEqual(['host-note']);
      expect(t.row('conv-1').activeReqId).toBe('req-1');
      expect(t.turnErrors.filter((e) => e.reqId === 'req-2')).toHaveLength(1);

      await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
      await p1;
      await p2;
      expect(out2).toHaveLength(1);
      // No leaked mid-turn rotation interval for req-2: the one timer left is
      // the idle reaper req-1's turn end armed for the warm sandbox.
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a restart that throws still ends every detached request exactly once', async () => {
    // The restart's own open fails, and logging that failure throws, so the
    // continuation throws instead of returning an outcome.
    const t = await setup({ openSessionThrowsOn: 2, throwOnLog: 'dev-service-failed' });
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'turn 1');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    const p2 = t.invoke('placeholder', 'conv-1', 'req-2');
    const p3 = t.invoke('placeholder', 'conv-1', 'req-3');
    await waitFor(() => t.queued.length === 3, 'messages 2 and 3');
    const out2 = track(p2);
    const out3 = track(p3);
    const thrown = p1.then(() => null, (err: unknown) => err);
    await t.endSegment('s-1', 'conv-1', 'req-1', ['req-3']); // req-3 folded, req-2 queued
    expect(await thrown).toBeInstanceOf(Error);
    await Promise.all([p2, p3]);
    await flush();
    // Promptly, not at their own limits (60 s), and once each.
    expect(out2).toEqual([expect.objectContaining({ kind: 'terminated', reason: 'sandbox-terminated' })]);
    expect(out3).toEqual([expect.objectContaining({ kind: 'terminated', reason: 'chat-run-error' })]);
    expect(t.turnErrors.filter((e) => e.reqId === 'req-2')).toHaveLength(1);
    expect(t.turnErrors.filter((e) => e.reqId === 'req-3')).toHaveLength(1);
    expect(t.row('conv-1').serviceSet).toBeNull();
  });

  it('N3: a moved request\'s R19 listener works on the new sandbox', async () => {
    const t = await setup();
    const { p1, p2, out2 } = await restartWithQueued(t);
    await t.endSegment('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 4, 'the note and the moved message');
    const fresh = t.opens[1]!.sessionId;
    expect(out2).toEqual([]);

    // The new sandbox dies.
    await t.h.bus.call('session:terminate', makeAgentContext({ sessionId: fresh, agentId: AGENT.id, userId: AGENT.ownerId }), { sessionId: fresh });
    await waitFor(() => out2.length === 1, 'req-2 ended');
    expect(out2).toEqual([expect.objectContaining({ kind: 'terminated', reason: 'sandbox-terminated' })]);
    await p2;
    expect(t.turnErrors.filter((e) => e.reqId === 'req-2')).toEqual([
      { reqId: 'req-2', reason: 'sandbox-terminated' },
    ]);
    // Let req-1 end too (its own path watches the handle).
    await t.handles.get(fresh)!.handle.kill();
    await p1;
  });
});
