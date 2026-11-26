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

/** A `conversations:bind-session` input, as the fake records it. */
interface BindInput {
  conversationId: string;
  sessionId: string;
  reqId: string;
  runnerType?: string;
  expectedSessionId?: string | null;
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
  /** The Nth sandbox:open-session (or each of these) fails, with the sidecar's diagnosis. */
  openSessionThrowsOn?: number | readonly number[];
  /** A failing open throws a plain error, with no diagnosis. */
  openSessionPlainError?: boolean;
  /** Register agents:identity:get, answering this first-run state (read at each spawn). */
  identityBootstrap?: { current: 'none' | 'pending' | 'done' };
  /** The gated open's session is alive while it opens (k8s: session:create runs inside the open). */
  aliveWhileOpening?: boolean;
  /** Hold the host-note's session:queue-work until this resolves (it lands in the inbox after). */
  noteGate?: Promise<void>;
  /** Also attach an always-on connector carrying this service (a fold collision with the set). */
  alwaysOnCollision?: boolean;
  /** Replaces the whole onDemandServices config (undefined key: omitted). */
  onDemandConfig?: { enabled?: boolean; maxPerAgent?: number } | 'omit';
  keepAlive?: boolean;
  /**
   * Runs at the start of every conversations:bind-session, before it writes:
   * lets a test move the row just before a bind lands. A conflicting bind can
   * be followed by a second one, so a hook that moves the row acts once.
   */
  onBind?: (input: BindInput, row: Row) => void;
} = {}) {
  const rows: Record<string, Row> = {};
  for (const [id, r] of Object.entries(opts.rows ?? {})) {
    rows[id] = { activeSessionId: null, activeReqId: null, serviceSet: null, ...r };
  }
  const row = (id: string): Row => (rows[id] ??= { activeSessionId: null, activeReqId: null, serviceSet: null });
  const live = new Set<string>();
  /** Every sandbox:open-session: its session, the services it folds, its system-prompt augment, and whether it opens in first-run setup. */
  const opens: Array<{ sessionId: string; services?: Array<{ name: string }>; augment: string; bootstrap?: true }> = [];
  const openThrows = (n: number): boolean =>
    typeof opts.openSessionThrowsOn === 'number'
      ? opts.openSessionThrowsOn === n
      : (opts.openSessionThrowsOn ?? []).includes(n);
  const handles = new Map<string, ReturnType<typeof makeHandle>>();
  const queued: Array<{ sessionId: string; entry: { type: string; reqId?: string; note?: string } }> = [];
  const terminated: string[] = [];
  const setServiceSetCalls: Array<{ conversationId: string; userId: string; serviceSet: string | null }> = [];
  const turnEnds: Array<{ reqId?: string; sessionId: string; foldedReqIds?: string[] }> = [];
  const segmentEnds: Array<{ reqId?: string; sessionId: string }> = [];
  const turnErrors: Array<{ reqId: string; reason: string; detail?: string }> = [];
  const activeReqClears: string[] = [];
  const logs: string[] = [];
  const registeredTools: string[] = [];
  /** Every conversations:bind-session input, in call order. */
  const binds: BindInput[] = [];

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
      }, ...(opts.alwaysOnCollision === true ? [{
        summary: { id: 'always-db' },
        source: 'attached',
        capabilities: {
          allowedHosts: [], credentials: [], mcpServers: [], servicesMode: 'always',
          services: [{ ...MONGO, publishedPorts: [] }],
        },
      }] : [])],
    }),
    'session:queue-work': async (_c, input: unknown) => {
      const q = input as (typeof queued)[number];
      if (q.entry.type === 'host-note' && opts.noteGate !== undefined) await opts.noteGate;
      queued.push(q);
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
      const i = input as BindInput;
      binds.push({ ...i });
      const r = row(i.conversationId);
      opts.onBind?.(i, r);
      // @ax/conversations' compare-and-set (TASK-1226): a bind naming the
      // session it expects (null: none bound) writes only if the row still
      // says exactly that.
      if (i.expectedSessionId !== undefined && r.activeSessionId !== i.expectedSessionId) {
        throw new PluginError({ code: 'conflict', plugin: 'test', message: 'moved on' });
      }
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
      const i = input as {
        sessionId: string;
        services?: Array<{ name: string }>;
        owner?: { agentConfig?: { systemPromptAugment?: string; identity?: { bootstrapMode?: boolean } } };
      };
      opens.push({
        sessionId: i.sessionId,
        ...(i.services !== undefined ? { services: i.services } : {}),
        augment: i.owner?.agentConfig?.systemPromptAugment ?? '',
        ...(i.owner?.agentConfig?.identity?.bootstrapMode === true ? { bootstrap: true as const } : {}),
      });
      const n = opens.length;
      if (opts.openGate !== undefined && opts.openGate.on === n) {
        if (opts.aliveWhileOpening === true) live.add(i.sessionId);
        await opts.openGate.until;
      }
      if (openThrows(n)) {
        if (opts.openSessionPlainError === true) throw new Error('boom');
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
    ...(opts.identityBootstrap !== undefined
      ? {
          'agents:identity:get': async () => ({
            identity: '', soul: '', instructions: '', bootstrap: opts.identityBootstrap!.current,
          }),
        }
      : {}),
    'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
    'proxy:close-session': async () => ({}),
    // The tool catalog (@ax/mcp-client's dispatcher): what agents are offered.
    'tool:register': async (_c, input: unknown) => {
      registeredTools.push((input as { name: string }).name);
      return { ok: true };
    },
  };
  const busRef: { bus: HookBus | null } = { bus: null };
  const h = await createTestHarness({
    services,
    plugins: [createChatOrchestratorPlugin({
      runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: opts.chatTimeoutMs ?? 60_000,
      keepAlive: opts.keepAlive ?? true, idleWindowMs: 60_000, idleGraceMs: 1_000,
      ...(opts.onDemandConfig === 'omit'
        ? {}
        : {
            onDemandServices: opts.onDemandConfig ?? {
              ...(opts.maxPerAgent !== undefined ? { maxPerAgent: opts.maxPerAgent } : {}),
              enabled: opts.enabled ?? true,
            },
          }),
    })],
  });
  busRef.bus = h.bus;
  // The callers: every chat:turn-end and chat:turn-error, by reqId. A turn-end
  // is what closes a web stream, ends a Slack reply, finishes a routine run
  // and clears active_req_id; none may arrive mid-restart.
  h.bus.subscribe<{ reqId?: string; foldedReqIds?: string[] }>('chat:turn-end', 'test/callers', async (c, p) => {
    turnEnds.push({
      reqId: p.reqId, sessionId: c.sessionId, ...(p.foldedReqIds !== undefined ? { foldedReqIds: p.foldedReqIds } : {}),
    });
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

  /**
   * Mirrors @ax/ipc-core `fireEventTurnEnd`: ask the hold, then segment-end or
   * chat:turn-end. Not held, the ids the answer names join the runner's own
   * (TASK-1224; ipc-core also bounds them, which this mirror leaves out).
   */
  async function emitTurnEnd(
    sessionId: string, conversationId: string, reqId: string, role: 'tool' | 'assistant', foldedReqIds?: string[],
  ) {
    const c = ipcCtx(sessionId, conversationId);
    const payload = { reason: 'user-message-wait', role, reqId, ...(foldedReqIds !== undefined ? { foldedReqIds } : {}) };
    const answer = await h.bus.fire<ChatTurnEndHoldPayload>(CHAT_TURN_END_HOLD_HOOK, c, { sessionId, reqId, held: false });
    if (!answer.rejected && answer.payload.held) {
      await h.bus.fire(CHAT_TURN_SEGMENT_END_HOOK, c, payload);
      return;
    }
    const own = foldedReqIds ?? [];
    const added = answer.rejected
      ? []
      : [...new Set(answer.payload.foldedReqIds ?? [])].filter((id) => id !== reqId && !own.includes(id));
    await h.bus.fire('chat:turn-end', c, added.length > 0 ? { ...payload, foldedReqIds: [...own, ...added] } : payload);
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
    activeReqClears, logs, emitTurnEnd, endSegment, tool, invoke, notes, registeredTools, binds,
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
    // TASK-1224 — and its callers hear it end: the continuation's turn-end names it.
    expect(t.turnEnds.find((e) => e.reqId === 'req-1')?.foldedReqIds).toEqual(['req-2']);
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
    // No services, and a prompt that only offers the set: nothing else.
    expect(t.opens.at(-1)).toEqual({
      sessionId: 's-c',
      augment:
        'Service sets you can start with restart_with_services: "e2e" ("e2e": mongo). Starting one ' +
        'restarts your sandbox inside this turn, so save your work first (push your branch, or write to ' +
        '/files). Turn them off with stop_services.',
    });
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

  // TASK-1226 — the swap binds the row twice, late: R19 (the restarting
  // request, onto the new sandbox) and N2 (the last moved request). A newer
  // request can bind its own sandbox before either lands; taking the row back
  // from it would orphan that sandbox.
  describe('TASK-1226: the swap never takes the row from a newer request', () => {
    const isRestartRebind = (i: BindInput): boolean => i.reqId === 'req-1' && i.sessionId !== 's-1';
    const keptNewer = (t: Awaited<ReturnType<typeof setup>>, site: string): boolean =>
      t.logs.some((l) => l.includes('conversation_bind_kept_newer') && l.includes(site));

    it('the swap\'s rebind keeps a newer binding that landed first', async () => {
      let acted = false;
      const t = await setup({
        onBind: (i, r) => {
          if (acted || !isRestartRebind(i)) return;
          acted = true;
          r.activeSessionId = 's-newer';
          r.activeReqId = 'req-9';
        },
      });
      const p1 = t.invoke('s-1', 'conv-1', 'req-1');
      await waitFor(() => t.queued.length === 1, 'turn 1');
      expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
      await t.endSegment('s-1', 'conv-1', 'req-1');
      await waitFor(() => t.notes().length === 1, 'the host note');
      const fresh = t.opens[1]!.sessionId;
      await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
      expect(await p1).toEqual({ kind: 'complete', messages: [] });

      expect(t.row('conv-1')).toMatchObject({ activeSessionId: 's-newer', activeReqId: 'req-9' });
      expect(keptNewer(t, 'restart-rebind')).toBe(true);
      expect(t.turnErrors).toEqual([]);
    });

    // An unbound row at N2 means a stale writer bound the OLD session after
    // R19 and the old session's terminate cleared it: that newer request is
    // opening its own sandbox and must get the row, so N2 is strict.
    for (const [label, newer] of [
      ['a newer session', { activeSessionId: 's-newer', activeReqId: 'req-9' }],
      ['a row a newer request is about to take', { activeSessionId: null, activeReqId: null }],
    ] as const) {
      it(`the moved-request bind keeps a newer binding that landed during the open (${label})`, async () => {
        let release!: () => void;
        const t = await setup({ openGate: { on: 2, until: new Promise<void>((r) => { release = r; }) } });
        const { p1, p2, out1, out2 } = await restartWithQueued(t);
        await t.endSegment('s-1', 'conv-1', 'req-1');
        await waitFor(() => t.opens.length === 2, 'the restart opening');
        const fresh = t.opens[1]!.sessionId;
        Object.assign(t.row('conv-1'), newer);
        release();
        await waitFor(() => t.queued.length === 4, 'the note and the moved message');
        await waitFor(() => t.binds.some((b) => b.reqId === 'req-2' && b.sessionId === fresh), 'the moved-request bind');
        await flush();

        expect(t.row('conv-1')).toMatchObject(newer);
        expect(keptNewer(t, 'restart-moved')).toBe(true);
        // Both requests still finish on the new sandbox.
        await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
        await t.emitTurnEnd(fresh, 'conv-1', 'req-2', 'assistant');
        await Promise.all([p1, p2]);
        await flush();
        expect(out1).toEqual([{ kind: 'complete', messages: [] }]);
        expect(out2).toEqual([{ kind: 'complete', messages: [] }]);
        expect(t.turnErrors).toEqual([]);
      });
    }

    it('the swap\'s binds name the session they expect', async () => {
      const t = await setup();
      const { p1, p2 } = await restartWithQueued(t);
      await t.endSegment('s-1', 'conv-1', 'req-1');
      await waitFor(() => t.queued.length === 4, 'the note and the moved message');
      const fresh = t.opens[1]!.sessionId;
      await waitFor(() => t.binds.some((b) => b.reqId === 'req-2' && b.sessionId === fresh), 'the moved-request bind');

      // R19 over the old session; N2 over the new one, which R19 just bound.
      expect(t.binds.filter((b) => b.sessionId === fresh)).toEqual([
        expect.objectContaining({ conversationId: 'conv-1', reqId: 'req-1', expectedSessionId: 's-1' }),
        expect.objectContaining({ conversationId: 'conv-1', reqId: 'req-2', expectedSessionId: fresh }),
      ]);
      expect(t.row('conv-1')).toMatchObject({ activeSessionId: fresh, activeReqId: 'req-2' });
      await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
      await t.emitTurnEnd(fresh, 'conv-1', 'req-2', 'assistant');
      await Promise.all([p1, p2]);
    });

    it('the swap\'s rebind takes an unbound row', async () => {
      // The old sandbox's row was cleared (its pod died) just before R19 lands.
      let acted = false;
      const t = await setup({
        onBind: (i, r) => {
          if (acted || !isRestartRebind(i)) return;
          acted = true;
          r.activeSessionId = null;
          r.activeReqId = null;
        },
      });
      const p1 = t.invoke('s-1', 'conv-1', 'req-1');
      await waitFor(() => t.queued.length === 1, 'turn 1');
      expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
      await t.endSegment('s-1', 'conv-1', 'req-1');
      await waitFor(() => t.notes().length === 1, 'the host note');
      const fresh = t.opens[1]!.sessionId;

      expect(t.row('conv-1')).toMatchObject({ activeSessionId: fresh, activeReqId: 'req-1' });
      expect(keptNewer(t, 'restart-rebind')).toBe(false);
      await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
      expect(await p1).toEqual({ kind: 'complete', messages: [] });
      expect(t.turnErrors).toEqual([]);
    });
  });

  // TASK-1224 — a request the runner folded into the held segment was named
  // only on that segment's turn-ends, which no caller sees, and the
  // continuation's runner never saw it. The hold's answer names it on the
  // continuation's turn-end instead, so its caller (web stream, Slack reply,
  // activity line) ends with the restarting turn.
  describe('TASK-1224: a request folded into the held segment ends with the continuation', () => {
    it('a folded request with no waiter is named too', async () => {
      // A decision continuation folded into the segment has a stream, but no waiter here.
      const t = await setup();
      const p1 = t.invoke('s-1', 'conv-1', 'req-1');
      await waitFor(() => t.queued.length === 1, 'turn 1');
      expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
      await t.endSegment('s-1', 'conv-1', 'req-1', ['cont-1']);
      await waitFor(() => t.notes().length === 1, 'the note');
      const fresh = t.opens[1]!.sessionId;
      await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
      expect(await p1).toEqual({ kind: 'complete', messages: [] });
      expect(t.turnEnds).toEqual([{ reqId: 'req-1', sessionId: fresh, foldedReqIds: ['cont-1'] }]);
    });

    // The continuation's closing turn-ends come tool, then assistant, and the
    // first one already ends the invoke (any turn-end naming it settles its
    // waiter). That one always names the folded requests; callers end a
    // request on the first turn-end naming it, whatever its role.
    it('the first closing turn-end carries the folded ids, only while the invoke runs; a moved request is not named', async () => {
      const t = await setup();
      const { p1, p2, out1, out2 } = await restartWithQueued(t);
      const p3 = t.invoke('placeholder', 'conv-1', 'req-3');
      await waitFor(() => t.queued.length === 3, 'message 3 queued on s-1');
      const out3 = track(p3);
      await t.endSegment('s-1', 'conv-1', 'req-1', ['req-3']); // req-3 folded, req-2 moved
      await waitFor(() => t.queued.length === 5, 'the note and the moved message');
      const fresh = t.opens[1]!.sessionId;

      // The moved request ends in the new sandbox while req-1's continuation
      // still runs there: the answer is keyed on the request too, so it names nothing.
      await t.emitTurnEnd(fresh, 'conv-1', 'req-2', 'assistant');
      expect(await p2).toEqual({ kind: 'complete', messages: [] });
      await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'tool');
      expect(await p1).toEqual({ kind: 'complete', messages: [] });
      // The invoke is over: a later turn-end of the new sandbox names nothing folded.
      await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
      await p3;
      await flush();
      expect(t.turnEnds).toEqual([
        { reqId: 'req-2', sessionId: fresh },
        { reqId: 'req-1', sessionId: fresh, foldedReqIds: ['req-3'] },
        { reqId: 'req-1', sessionId: fresh },
      ]);
      for (const out of [out1, out2, out3]) expect(out).toEqual([{ kind: 'complete', messages: [] }]);
      expect(t.turnErrors).toEqual([]);
    });

    it('a turn-end from another sandbox gets no ids', async () => {
      const t = await setup();
      const p1 = t.invoke('s-1', 'conv-1', 'req-1');
      await waitFor(() => t.queued.length === 1, 'turn 1');
      expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
      await t.endSegment('s-1', 'conv-1', 'req-1', ['cont-1']);
      await waitFor(() => t.notes().length === 1, 'the note');
      const fresh = t.opens[1]!.sessionId;
      // The old sandbox names the restarting request again: the answer is keyed
      // on the host-stamped session, so it names nothing.
      await t.emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant');
      expect(t.turnEnds).toEqual([{ reqId: 'req-1', sessionId: 's-1' }]);
      await t.emitTurnEnd(fresh, 'conv-1', 'req-1', 'assistant');
      await p1;
    });
  });
});

// ---- Final review C1: a message that arrives while the restart's sandbox opens ----
describe('restart_with_services: a message during the restart open (C1)', () => {
  /** Restart req-1 on s-1 up to the gated open of its new sandbox; returns that sandbox's id. */
  async function restartUpToOpen(t: Awaited<ReturnType<typeof setup>>) {
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.some((q) => q.entry.type === 'user-message'), 'the first message');
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    await t.endSegment('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.opens.length === 2, 'the restart open started');
    return { p1, restartSid: t.opens[1]!.sessionId };
  }
  /** channel-web's POST: bind the request to the row's live session, then dispatch. */
  function postMessage(t: Awaited<ReturnType<typeof setup>>, reqId: string) {
    t.row('conv-1').activeReqId = reqId;
    return t.invoke(`placeholder-${reqId}`, 'conv-1', reqId);
  }
  function track(p: Promise<AgentOutcome>) {
    const seen: AgentOutcome[] = [];
    void p.then((o) => { seen.push(o); });
    return seen;
  }
  /** Long enough for a routed turn to route, retire or spawn if it were going to. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await flush();
    await new Promise((r) => setTimeout(r, 20));
  }

  for (const aliveWhileOpening of [true, false]) {
    it(`waits for the opening sandbox (${aliveWhileOpening ? 'already alive' : 'not alive yet'}): no retire, no third sandbox, queued behind the note`, async () => {
      let release!: () => void;
      const until = new Promise<void>((r) => { release = r; });
      const t = await setup({ openGate: { on: 2, until }, aliveWhileOpening });
      const { p1, restartSid } = await restartUpToOpen(t);

      const p2 = postMessage(t, 'req-2');
      const out2 = track(p2);
      await settle();
      expect(t.terminated).not.toContain(restartSid);
      expect(t.opens).toHaveLength(2);
      expect(out2).toEqual([]);

      release();
      await waitFor(() => t.queued.some((q) => q.entry.reqId === 'req-2'), 'req-2 queued');
      const noteAt = t.queued.findIndex((q) => q.entry.type === 'host-note');
      const msgAt = t.queued.findIndex((q) => q.entry.type === 'user-message' && q.entry.reqId === 'req-2');
      expect(noteAt).toBeGreaterThanOrEqual(0);
      expect(msgAt).toBeGreaterThan(noteAt);
      expect(t.queued[msgAt]!.sessionId).toBe(restartSid);
      expect(t.opens).toHaveLength(2);
      expect(t.row('conv-1')).toMatchObject({ activeSessionId: restartSid, activeReqId: 'req-2', serviceSet: 'e2e' });

      await t.emitTurnEnd(restartSid, 'conv-1', 'req-1', 'assistant');
      expect(await p1).toEqual({ kind: 'complete', messages: [] });
      expect(t.row('conv-1').activeReqId).toBe('req-2');
      await t.emitTurnEnd(restartSid, 'conv-1', 'req-2', 'assistant');
      expect(await p2).toEqual({ kind: 'complete', messages: [] });
      expect(t.terminated).toEqual(['s-1']);
      expect(t.turnErrors).toEqual([]);
    });
  }

  it('a message arriving after the open but before the note lands behind the note', async () => {
    let releaseNote!: () => void;
    const noteGate = new Promise<void>((r) => { releaseNote = r; });
    const t = await setup({ noteGate });
    const { p1, restartSid } = await restartUpToOpen(t);
    // The new sandbox is open (warm on this host); its note isn't in the inbox yet.
    const p2 = postMessage(t, 'req-2');
    await settle();
    expect(t.queued.some((q) => q.entry.reqId === 'req-2')).toBe(false);
    // The fresh path does not rebind the row over the newer request (step 7).
    expect(t.row('conv-1')).toMatchObject({ activeSessionId: restartSid, activeReqId: 'req-2' });

    releaseNote();
    await waitFor(() => t.queued.some((q) => q.entry.reqId === 'req-2'), 'req-2 queued');
    const noteAt = t.queued.findIndex((q) => q.entry.type === 'host-note');
    const msgAt = t.queued.findIndex((q) => q.entry.type === 'user-message' && q.entry.reqId === 'req-2');
    expect(msgAt).toBeGreaterThan(noteAt);
    await t.emitTurnEnd(restartSid, 'conv-1', 'req-1', 'assistant');
    await p1;
    await t.emitTurnEnd(restartSid, 'conv-1', 'req-2', 'assistant');
    expect(await p2).toEqual({ kind: 'complete', messages: [] });
    expect(t.opens).toHaveLength(2);
    expect(t.turnErrors).toEqual([]);
  });

  it('a restart open that fails: the waiting message opens a fresh sandbox without the set', async () => {
    let release!: () => void;
    const until = new Promise<void>((r) => { release = r; });
    const t = await setup({ openGate: { on: 2, until }, openSessionThrowsOn: 2 });
    const { p1 } = await restartUpToOpen(t);
    const p2 = postMessage(t, 'req-2');
    await settle();
    expect(t.opens).toHaveLength(2);

    release();
    expect(await p1).toMatchObject({ kind: 'terminated', reason: 'dev-service-failed' });
    await waitFor(() => t.opens.length === 3, 'req-2 spawns fresh');
    expect(t.opens[2]!.services).toBeUndefined();
    // TASK-1240 — and its agent hears which service failed.
    expect(t.opens[2]!.augment).toContain('dev service "mongo" failed');
    const third = t.opens[2]!.sessionId;
    await waitFor(() => t.queued.some((q) => q.entry.reqId === 'req-2'), 'req-2 queued');
    await t.emitTurnEnd(third, 'conv-1', 'req-2', 'assistant');
    expect(await p2).toEqual({ kind: 'complete', messages: [] });
    expect(t.turnErrors.map((e) => e.reqId)).toEqual(['req-1']);
    expect(t.row('conv-1').serviceSet).toBeNull();
  });
});

// ---- Final review C2: a set whose fold fails is cleared, not stuck ----
describe('restart_with_services: a set that no longer folds (C2)', () => {
  it('a re-spawn whose set collides with an always-on service clears the set; the next turn opens', async () => {
    const t = await setup({ rows: { 'conv-1': { serviceSet: 'e2e' } }, alwaysOnCollision: true });
    const o1 = await t.invoke('s-1', 'conv-1', 'req-1');
    expect(o1).toMatchObject({ kind: 'terminated', reason: 'connector-services-invalid' });
    expect(t.opens).toHaveLength(0);
    expect(t.row('conv-1').serviceSet).toBeNull();
    expect(t.setServiceSetCalls).toEqual([{ conversationId: 'conv-1', userId: AGENT.ownerId, serviceSet: null }]);

    // The next turn is not stuck: it opens, with only the always-on service.
    const p2 = t.invoke('s-2', 'conv-1', 'req-2');
    await waitFor(() => t.queued.some((q) => q.entry.reqId === 'req-2'), 'req-2 queued');
    expect(t.opens).toHaveLength(1);
    expect(t.opens[0]!.services?.map((s) => s.name)).toEqual(['mongo']);
    await t.emitTurnEnd('s-2', 'conv-1', 'req-2', 'assistant');
    expect(await p2).toEqual({ kind: 'complete', messages: [] });
  });

  it('a fold failure with no set on leaves the conversation alone', async () => {
    const t = await setup({ alwaysOnCollision: true, connectorMode: 'always' });
    const o1 = await t.invoke('s-1', 'conv-1', 'req-1');
    expect(o1).toMatchObject({ kind: 'terminated', reason: 'connector-services-invalid' });
    expect(t.setServiceSetCalls).toEqual([]);
  });
});

// ---- Final review C3: on-demand services are off unless a preset turns them on ----
describe('restart_with_services: the on-demand switch (C3)', () => {
  it('unset, on-demand services are OFF: no set folds, the tool refuses, no tool is offered', async () => {
    const t = await setup({ onDemandConfig: 'omit', rows: { 'conv-1': { serviceSet: 'e2e' } } });
    expect(t.registeredTools).toEqual([]);
    const p = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'the message');
    expect(t.opens[0]!.services).toBeUndefined();
    const r = await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' });
    expect(r).toEqual({ ok: false, message: expect.stringContaining('turned off on this host') });
    await t.emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant');
    await p;
  });

  it('enabled: false offers neither tool', async () => {
    const t = await setup({ enabled: false });
    expect(t.registeredTools).toEqual([]);
  });

  it('enabled: true offers both tools', async () => {
    const t = await setup();
    expect(t.registeredTools.sort()).toEqual([RESTART_WITH_SERVICES, STOP_SERVICES].sort());
  });

  it('refuses enabled without keepAlive at init (the restart needs a warm sandbox to swap)', async () => {
    await expect(setup({ keepAlive: false })).rejects.toThrow(/onDemandServices\.enabled requires keepAlive/);
    // Off, keepAlive doesn't matter.
    await expect(setup({ keepAlive: false, enabled: false })).resolves.toBeDefined();
  });
});

// ---- TASK-1240: the agent hears which service failed, at its next sandbox ----
describe('restart_with_services: a failed services open is told to the agent (TASK-1240)', () => {
  const NOTICE = "service set didn't start";
  /** A sandbox exits (its runner ended): the conversation's next turn spawns fresh. */
  async function exitSandbox(t: Awaited<ReturnType<typeof setup>>, sessionId: string): Promise<void> {
    await t.handles.get(sessionId)!.handle.kill();
    await flush();
  }
  /** Invoke, wait until the request's message is queued, and return the open it spawned. */
  async function spawnTurn(
    t: Awaited<ReturnType<typeof setup>>, reqId: string, source?: AgentContextSource,
  ): Promise<{ p: Promise<AgentOutcome>; open: (typeof t.opens)[number] }> {
    const before = t.opens.length;
    const p = t.invoke(`placeholder-${reqId}`, 'conv-1', reqId, source);
    await waitFor(() => t.queued.some((q) => q.entry.reqId === reqId), `${reqId} queued`);
    expect(t.opens).toHaveLength(before + 1); // a fresh sandbox, not a routed turn
    return { p, open: t.opens.at(-1)! };
  }
  async function endTurn(t: Awaited<ReturnType<typeof setup>>, sessionId: string, reqId: string, p: Promise<AgentOutcome>) {
    await t.emitTurnEnd(sessionId, 'conv-1', reqId, 'assistant');
    expect(await p).toEqual({ kind: 'complete', messages: [] });
  }

  it('a failed restart tells the agent at its next sandbox which service failed, without the path (TASK-1240)', async () => {
    const t = await setup({ openSessionThrowsOn: 2 });
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.queued.length === 1, 'the first message');
    expect(t.opens[0]!.augment).not.toContain(NOTICE);
    expect((await t.tool(RESTART_WITH_SERVICES, 's-1', 'conv-1', { set: 'e2e' })).ok).toBe(true);
    await t.endSegment('s-1', 'conv-1', 'req-1');
    expect(await p1).toMatchObject({ kind: 'terminated', reason: 'dev-service-failed' });

    const next = await spawnTurn(t, 'req-3');
    expect(next.open).toBe(t.opens[2]);
    expect(next.open.services).toBeUndefined();
    expect(next.open.augment).toContain('"e2e"');
    expect(next.open.augment).toContain('dev service "mongo" failed (read-only filesystem)');
    expect(next.open.augment).not.toContain('/data/db');
    await endTurn(t, next.open.sessionId, 'req-3', next.p);

    // Told once: the sandbox after that one hears nothing more.
    await exitSandbox(t, next.open.sessionId);
    const after = await spawnTurn(t, 'req-4');
    expect(after.open.augment).not.toContain(NOTICE);
    await endTurn(t, after.open.sessionId, 'req-4', after.p);
  });

  it('R32 plain path: a sandbox carrying the set that fails to open tells the agent at the next sandbox', async () => {
    const t = await setup({ openSessionThrowsOn: 1, rows: { 'conv-1': { serviceSet: 'e2e' } } });
    expect(await t.invoke('s-1', 'conv-1', 'req-1')).toMatchObject({ kind: 'terminated', reason: 'dev-service-failed' });
    expect(t.opens[0]!.augment).not.toContain(NOTICE);
    const next = await spawnTurn(t, 'req-2');
    expect(t.opens[1]!.augment).toContain('dev service "mongo" failed');
    expect(next.open.augment).not.toContain('/data/db');
    await endTurn(t, next.open.sessionId, 'req-2', next.p);
  });

  it('an outsider\'s turn neither hears nor consumes the notice', async () => {
    const t = await setup({ openSessionThrowsOn: 1, rows: { 'conv-1': { serviceSet: 'e2e' } } });
    await t.invoke('s-1', 'conv-1', 'req-1'); // R32: the set's sandbox fails to open

    const outsider = await spawnTurn(t, 'req-2', 'external');
    expect(outsider.open.augment).not.toContain(NOTICE);
    expect(outsider.open.augment).not.toContain('mongo" failed');
    await endTurn(t, outsider.open.sessionId, 'req-2', outsider.p);
    await exitSandbox(t, outsider.open.sessionId);

    // The next member's turn still hears it.
    const member = await spawnTurn(t, 'req-3');
    expect(member.open.augment).toContain('dev service "mongo" failed (read-only filesystem)');
    await endTurn(t, member.open.sessionId, 'req-3', member.p);
  });

  it('a failed open with no diagnosis still tells the agent the set was turned off', async () => {
    const t = await setup({
      openSessionThrowsOn: 1, openSessionPlainError: true, rows: { 'conv-1': { serviceSet: 'e2e' } },
    });
    expect(await t.invoke('s-1', 'conv-1', 'req-1')).toMatchObject({ kind: 'terminated', reason: 'sandbox-open-failed' });
    expect(t.row('conv-1').serviceSet).toBeNull();
    const next = await spawnTurn(t, 'req-2');
    expect(next.open.augment).toContain(
      'The last sandbox this conversation opened with the "e2e" service set didn\'t start, so the set was ' +
        'turned off and this sandbox has none of its services. Tell the person before calling ' +
        'restart_with_services again.',
    );
    expect(next.open.augment).not.toContain('boom');
    await endTurn(t, next.open.sessionId, 'req-2', next.p);
  });

  it('a sandbox in first-run setup leaves the notice for the first sandbox that can hear it', async () => {
    // Bootstrap mode: the runner shows only the bootstrap augment, never the
    // system-prompt augment the notice rides, so that sandbox must not spend it.
    const identityBootstrap: { current: 'none' | 'pending' | 'done' } = { current: 'pending' };
    const t = await setup({ openSessionThrowsOn: 1, rows: { 'conv-1': { serviceSet: 'e2e' } }, identityBootstrap });
    expect(await t.invoke('s-1', 'conv-1', 'req-1')).toMatchObject({ kind: 'terminated', reason: 'dev-service-failed' });

    const setupTurn = await spawnTurn(t, 'req-2');
    expect(setupTurn.open.bootstrap).toBe(true);
    expect(setupTurn.open.augment).not.toContain(NOTICE);
    await endTurn(t, setupTurn.open.sessionId, 'req-2', setupTurn.p);

    // First-run setup is done: the next sandbox opens in normal mode and hears it.
    identityBootstrap.current = 'done';
    await exitSandbox(t, setupTurn.open.sessionId);
    const normal = await spawnTurn(t, 'req-3');
    expect(normal.open.bootstrap).toBeUndefined();
    expect(normal.open.augment).toContain('dev service "mongo" failed (read-only filesystem)');
    await endTurn(t, normal.open.sessionId, 'req-3', normal.p);
  });

  it('a failed open that carried no service set leaves no notice', async () => {
    const t = await setup({ openSessionThrowsOn: 1 });
    expect(await t.invoke('s-1', 'conv-1', 'req-1')).toMatchObject({ kind: 'terminated', reason: 'dev-service-failed' });
    expect(t.opens[0]!.services).toBeUndefined();
    const next = await spawnTurn(t, 'req-2');
    expect(next.open.augment).not.toContain(NOTICE);
    await endTurn(t, next.open.sessionId, 'req-2', next.p);
  });

  it('a sandbox that folds the failed set again is not told it has none of its services, and the notice goes', async () => {
    const t = await setup({ openSessionThrowsOn: 1, rows: { 'conv-1': { serviceSet: 'e2e' } } });
    await t.invoke('s-1', 'conv-1', 'req-1'); // R32: the set's sandbox fails to open
    expect(t.row('conv-1').serviceSet).toBeNull();
    // The write that turns the set off didn't land (or a restart turned it back
    // on): the member's next sandbox folds `e2e` while the notice is stored.
    t.row('conv-1').serviceSet = 'e2e';

    // A member's sandbox folds the set and opens fine: telling it "this sandbox
    // has none of its services" would be false. The set starts now, so the
    // notice is gone for good.
    const member = await spawnTurn(t, 'req-2');
    expect(member.open.services?.map((s) => s.name)).toEqual(['mongo']);
    expect(member.open.augment).not.toContain(NOTICE);
    expect((await t.tool(STOP_SERVICES, member.open.sessionId, 'conv-1', {})).ok).toBe(true);
    await endTurn(t, member.open.sessionId, 'req-2', member.p);

    const plain = await spawnTurn(t, 'req-3'); // the set is off again: a fresh sandbox without it
    expect(plain.open.services).toBeUndefined();
    expect(plain.open.augment).not.toContain(NOTICE);
    await endTurn(t, plain.open.sessionId, 'req-3', plain.p);
  });

  it('an outsider\'s successful open of the failed set retires the notice for every later turn', async () => {
    // Review repro: (1) a member's sandbox carrying `e2e` fails to open (R32);
    // (2) an outsider's restart_with_services opens `e2e` fine; (3) the set is
    // turned off; (4) the member's next sandbox must not be told "mongo failed".
    const t = await setup({ openSessionThrowsOn: 1, rows: { 'conv-1': { serviceSet: 'e2e' } } });
    await t.invoke('s-1', 'conv-1', 'req-1'); // R32: the notice is recorded
    const outsider = await spawnTurn(t, 'req-2', 'external');
    expect((await t.tool(RESTART_WITH_SERVICES, outsider.open.sessionId, 'conv-1', { set: 'e2e' }, 'external')).ok).toBe(true);
    await t.endSegment(outsider.open.sessionId, 'conv-1', 'req-2');
    await waitFor(() => t.notes().length === 1, 'the restart note');
    const restarted = t.opens.at(-1)!;
    expect(restarted.services?.map((s) => s.name)).toEqual(['mongo']);
    expect(restarted.augment).not.toContain(NOTICE);
    // The set goes off again (the outsider's stop_services).
    expect((await t.tool(STOP_SERVICES, restarted.sessionId, 'conv-1', {}, 'external')).ok).toBe(true);
    await endTurn(t, restarted.sessionId, 'req-2', outsider.p);

    const member = await spawnTurn(t, 'req-3');
    expect(member.open.services).toBeUndefined();
    expect(member.open.augment).not.toContain(NOTICE);
    expect(member.open.augment).not.toContain('mongo" failed');
    await endTurn(t, member.open.sessionId, 'req-3', member.p);
  });

  it('a first-run-setup sandbox that opens the failed set fine retires the notice too', async () => {
    const identityBootstrap: { current: 'none' | 'pending' | 'done' } = { current: 'pending' };
    const t = await setup({ openSessionThrowsOn: 1, rows: { 'conv-1': { serviceSet: 'e2e' } }, identityBootstrap });
    await t.invoke('s-1', 'conv-1', 'req-1'); // R32: the notice is recorded, the set off
    t.row('conv-1').serviceSet = 'e2e'; // the set comes back on (a restart elsewhere, say)
    const setupTurn = await spawnTurn(t, 'req-2');
    expect(setupTurn.open.bootstrap).toBe(true);
    expect(setupTurn.open.services?.map((s) => s.name)).toEqual(['mongo']);
    await endTurn(t, setupTurn.open.sessionId, 'req-2', setupTurn.p);

    identityBootstrap.current = 'done';
    t.row('conv-1').serviceSet = null; // and goes off again
    await exitSandbox(t, setupTurn.open.sessionId);
    const normal = await spawnTurn(t, 'req-3');
    expect(normal.open.bootstrap).toBeUndefined();
    expect(normal.open.services).toBeUndefined();
    expect(normal.open.augment).not.toContain(NOTICE);
    await endTurn(t, normal.open.sessionId, 'req-3', normal.p);
  });

  it('a newer failure recorded while a notified sandbox opens survives that open', async () => {
    let release!: () => void;
    const until = new Promise<void>((r) => { release = r; });
    const t = await setup({
      openSessionThrowsOn: [1, 3], openGate: { on: 2, until }, rows: { 'conv-1': { serviceSet: 'e2e' } },
    });
    await t.invoke('s-1', 'conv-1', 'req-1'); // R32: the first notice
    const p2 = t.invoke('placeholder-req-2', 'conv-1', 'req-2');
    await waitFor(() => t.opens.length === 2, 'req-2 opening, held');
    expect(t.opens[1]!.augment).toContain('dev service "mongo" failed');

    // Meanwhile the set comes back on (an outsider's restart, say) and another
    // sandbox of the conversation carrying it fails too: a newer notice.
    t.row('conv-1').serviceSet = 'e2e';
    expect(await t.invoke('placeholder-req-3', 'conv-1', 'req-3')).toMatchObject({
      kind: 'terminated', reason: 'dev-service-failed',
    });
    expect(t.opens).toHaveLength(3);
    expect(t.opens[2]!.services?.map((s) => s.name)).toEqual(['mongo']);
    expect(t.row('conv-1').serviceSet).toBeNull();

    // req-2's open succeeds: it consumes only the notice it was given.
    release();
    await waitFor(() => t.queued.some((q) => q.entry.reqId === 'req-2'), 'req-2 queued');
    await endTurn(t, t.opens[1]!.sessionId, 'req-2', p2);
    await exitSandbox(t, t.opens[1]!.sessionId);
    const next = await spawnTurn(t, 'req-4');
    expect(next.open.augment).toContain('dev service "mongo" failed');
    await endTurn(t, next.open.sessionId, 'req-4', next.p);
  });
});

// ---- TASK-1226: a cold spawn's late bind (step 7) never takes the row back ----
describe('TASK-1226: a cold spawn keeps a newer binding', () => {
  const userMessageQueued = (t: Awaited<ReturnType<typeof setup>>, reqId: string): boolean =>
    t.queued.some((q) => q.entry.type === 'user-message' && q.entry.reqId === reqId);
  const keptNewer = (t: Awaited<ReturnType<typeof setup>>): boolean =>
    t.logs.some((l) => l.includes('conversation_bind_kept_newer') && l.includes('fresh'));

  it('a cold spawn keeps a newer binding that landed during its open', async () => {
    let release!: () => void;
    const t = await setup({ openGate: { on: 1, until: new Promise<void>((r) => { release = r; }) } });
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.opens.length === 1, 'the open');
    // A newer request opened its own sandbox and bound it while this one opened.
    Object.assign(t.row('conv-1'), { activeSessionId: 's-newer', activeReqId: 'req-9' });
    release();
    await waitFor(() => userMessageQueued(t, 'req-1'), 'the message');

    expect(t.row('conv-1')).toMatchObject({ activeSessionId: 's-newer', activeReqId: 'req-9' });
    expect(keptNewer(t)).toBe(true);
    await t.emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant');
    expect(await p1).toEqual({ kind: 'complete', messages: [] });
    expect(t.turnErrors).toEqual([]);
  });

  it('a cold spawn whose stale row is cleared during its open still binds', async () => {
    let release!: () => void;
    const t = await setup({
      rows: { 'conv-1': { activeSessionId: 's-stale', activeReqId: 'req-0' } }, // not alive
      openGate: { on: 1, until: new Promise<void>((r) => { release = r; }) },
    });
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => t.opens.length === 1, 'the open');
    // The stale session's terminate (the idle reaper's clear) lands mid-open.
    Object.assign(t.row('conv-1'), { activeSessionId: null, activeReqId: null });
    release();
    await waitFor(() => userMessageQueued(t, 'req-1'), 'the message');

    expect(t.row('conv-1')).toMatchObject({ activeSessionId: 's-1', activeReqId: 'req-1' });
    expect(keptNewer(t)).toBe(false);
    await t.emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant');
    expect(await p1).toEqual({ kind: 'complete', messages: [] });
  });

  it('a spawn that retired the warm sandbox binds over its own retire bind', async () => {
    const t = await setup({ rows: { 'conv-1': { serviceSet: 'e2e' } } });
    const p1 = t.invoke('s-1', 'conv-1', 'req-1');
    await waitFor(() => userMessageQueued(t, 'req-1'), 'turn 1');
    expect((await t.tool(STOP_SERVICES, 's-1', 'conv-1', {})).ok).toBe(true);
    await t.emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant');
    await p1;

    // The set changed, so routing retires s-1: it binds s-2 first, then opens it.
    const p2 = t.invoke('s-2', 'conv-1', 'req-2');
    await waitFor(() => userMessageQueued(t, 'req-2'), 'turn 2');
    expect(t.terminated).toEqual(['s-1']);
    expect(t.binds.filter((b) => b.reqId === 'req-2' && b.expectedSessionId !== undefined)).toEqual([
      expect.objectContaining({ sessionId: 's-2', expectedSessionId: 's-2' }),
    ]);
    expect(t.row('conv-1')).toMatchObject({ activeSessionId: 's-2', activeReqId: 'req-2' });
    expect(keptNewer(t)).toBe(false);
    await t.emitTurnEnd('s-2', 'conv-1', 'req-2', 'assistant');
    expect(await p2).toEqual({ kind: 'complete', messages: [] });
  });
});
