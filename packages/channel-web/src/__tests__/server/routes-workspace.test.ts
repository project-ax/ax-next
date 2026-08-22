/**
 * Tier-A direct-handler tests for the agent-workspace BFF (TASK-230 / AW-9).
 *
 * The whole point of these routes is that every byte is DERIVED from something
 * that already exists — the agent roster, the conversation list, the stored
 * turns. So the tests are mostly "did we invent anything?" checks: no `stats`
 * key, no fixture decisions, no guessed state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import {
  ACTIVITY_AGENT_ID_QUERY_KEY,
  ACTIVITY_BEFORE_QUERY_KEY,
  ACTIVITY_DETAIL_MAX_CHARS,
  ACTIVITY_LABEL_MAX_CHARS,
  ACTIVITY_LIMIT_QUERY_KEY,
  ACTIVITY_MAX_LIMIT,
  CONVERSATION_ID_QUERY_KEY,
  fireToActivityEvent,
  makeWorkspaceHandlers,
} from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

function mkReq(
  params: Record<string, string> = {},
  body?: unknown,
): RouteRequest {
  return {
    headers: {},
    body:
      body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf-8'),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}

interface CapturedRes {
  statusCode: number;
  body: unknown;
}
function mkRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text(_s: string) {
      /* unused */
    },
    end() {
      /* unused */
    },
  };
  return { res, captured };
}

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

function notFound(): PluginError {
  return new PluginError({
    code: 'not-found',
    plugin: 'mock-agents',
    message: 'nope',
  });
}

interface ConvRow {
  conversationId: string;
  userId: string;
  agentId: string;
  title: string | null;
  activeSessionId: string | null;
  activeReqId: string | null;
  createdAt: string;
  lastActivityAt: string | null;
}

function conv(over: Partial<ConvRow> & { conversationId: string }): ConvRow {
  return {
    userId: 'u1',
    agentId: 'a1',
    title: null,
    activeSessionId: null,
    activeReqId: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActivityAt: null,
    ...over,
  };
}

/**
 * The @ax/routines `FireRow`, as the hook actually hands it over: `firedAt` is
 * a real `Date` in-process, NOT an ISO string. A test that seeded strings here
 * would agree with a route that is broken against the live registrar.
 */
interface FireRowLike {
  id: number;
  agentId: string;
  path: string;
  firedAt: Date;
  triggerSource: 'tick' | 'webhook' | 'manual';
  conversationId: string | null;
  status: 'ok' | 'silenced' | 'error';
  error: string | null;
  renderedPrompt: string | null;
}

function fire(o: {
  id: number;
  firedAt: string;
  agentId?: string;
  path?: string;
  status?: FireRowLike['status'];
  error?: string | null;
  triggerSource?: FireRowLike['triggerSource'];
}): FireRowLike {
  return {
    id: o.id,
    agentId: o.agentId ?? 'a1',
    path: o.path ?? 'daily.md',
    firedAt: new Date(o.firedAt),
    triggerSource: o.triggerSource ?? 'tick',
    conversationId: null,
    status: o.status ?? 'ok',
    error: o.error ?? null,
    renderedPrompt: null,
  };
}

describe('channel-web agent-workspace BFF', () => {
  let bus: HookBus;
  let conversations: ConvRow[];
  let aliveSessions: Set<string>;
  let turnsByConversation: Map<string, unknown[]>;
  let fires: FireRowLike[];
  let routinesByAgent: Map<string, Array<{ path: string; name: string }>>;
  let firesReadFailure: Map<string, Error>;

  function registerAuth(user: { id: string; isAdmin: boolean } | null): void {
    bus.registerService('auth:require-user', 'auth', async () => {
      if (user === null) {
        throw new PluginError({
          code: 'unauthenticated',
          plugin: 'auth',
          message: 'no session',
        });
      }
      return { user };
    });
  }

  /**
   * The two routines reads the Activity feed makes. Registered per-test rather
   * than in `beforeEach` so a deployment WITHOUT @ax/routines is testable — an
   * absent registrar is a real configuration, not an error case.
   */
  function registerRoutines(): void {
    bus.registerService(
      'routines:recent-fires-for-agent',
      'routines',
      async (_c, i: unknown) => {
        const { agentId, limit, before } = i as {
          agentId: string;
          limit?: number;
          before?: Date;
        };
        const boom = firesReadFailure.get(agentId);
        if (boom !== undefined) throw boom;
        const rows = fires
          .filter((f) => f.agentId === agentId)
          .filter(
            (f) => before === undefined || f.firedAt.getTime() < before.getTime(),
          )
          .sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())
          .slice(0, limit ?? 20);
        return { fires: rows };
      },
    );
    bus.registerService('routines:list', 'routines', async (_c, i: unknown) => {
      const { agentId } = i as { agentId?: string };
      // Reproduces the real hazard: `routines:list` with NO agentId returns
      // EVERY agent's routines. A route that forgets to scope the call would
      // silently label one agent's fires with another agent's routine names,
      // so this mock makes that mistake fail here instead of in production.
      const routines: Array<{ path: string; name: string }> = [];
      for (const [id, rows] of routinesByAgent.entries()) {
        if (agentId === undefined || id === agentId) routines.push(...rows);
      }
      return { routines };
    });
  }

  beforeEach(() => {
    bus = new HookBus();
    conversations = [];
    aliveSessions = new Set<string>();
    turnsByConversation = new Map<string, unknown[]>();
    fires = [];
    routinesByAgent = new Map<string, Array<{ path: string; name: string }>>();
    firesReadFailure = new Map<string, Error>();

    bus.registerService('agents:list-for-user', 'agents', async () => ({
      agents: [
        { id: 'a1', displayName: 'Inbox', visibility: 'personal' },
        { id: 'a2', displayName: 'Research', visibility: 'personal' },
      ],
    }));
    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const { agentId } = i as { agentId: string };
      if (agentId !== 'a1' && agentId !== 'a2') throw notFound();
      return {
        agent: {
          id: agentId,
          displayName: agentId === 'a1' ? 'Inbox' : 'Research',
          visibility: 'personal',
        },
      };
    });
    bus.registerService('conversations:list', 'conversations', async (_c, i: unknown) => {
      const { userId, agentId } = i as { userId: string; agentId?: string };
      return conversations.filter(
        (c) => c.userId === userId && (agentId === undefined || c.agentId === agentId),
      );
    });
    bus.registerService('conversations:get', 'conversations', async (_c, i: unknown) => {
      const { conversationId, userId } = i as {
        conversationId: string;
        userId: string;
      };
      const row = conversations.find((c) => c.conversationId === conversationId);
      if (row === undefined || row.userId !== userId) throw notFound();
      return { conversation: row, turns: turnsByConversation.get(conversationId) ?? [] };
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/features — the public flag echo.
  // -------------------------------------------------------------------------

  it('GET /api/features echoes the flag without requiring auth', async () => {
    registerAuth(null);
    const on = makeWorkspaceHandlers({ bus, initCtx, agentWorkspacePreview: true });
    const { res, captured } = mkRes();
    await on.features(mkReq(), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ agentWorkspacePreview: true });

    const off = makeWorkspaceHandlers({ bus, initCtx });
    const second = mkRes();
    await off.features(mkReq(), second.res);
    expect(second.captured.statusCode).toBe(200);
    expect(second.captured.body).toEqual({ agentWorkspacePreview: false });
  });

  // -------------------------------------------------------------------------
  // Auth.
  // -------------------------------------------------------------------------

  it('401s an unauthenticated caller on /state and /agents/:agentId', async () => {
    registerAuth(null);
    const h = makeWorkspaceHandlers({ bus, initCtx });

    const s = mkRes();
    await h.state(mkReq(), s.res);
    expect(s.captured.statusCode).toBe(401);
    expect(s.captured.body).toEqual({ error: 'unauthenticated' });

    const d = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), d.res);
    expect(d.captured.statusCode).toBe(401);

    const r = mkRes();
    await h.route(mkReq({}, { text: 'anything' }), r.res);
    expect(r.captured.statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // GET /api/workspace/state
  // -------------------------------------------------------------------------

  it('returns only the caller\'s agents, mapped to the wire shape', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.state(mkReq(), res);

    expect(captured.statusCode).toBe(200);
    const body = captured.body as {
      agents: Array<Record<string, unknown>>;
      decisions: unknown[];
      activity: unknown[];
    };
    expect(body.agents).toEqual([
      {
        id: 'a1',
        name: 'Inbox',
        state: 'resting',
        now: null,
        counter: null,
        startedAt: null,
        stoppedReason: null,
      },
      {
        id: 'a2',
        name: 'Research',
        state: 'resting',
        now: null,
        counter: null,
        startedAt: null,
        stoppedReason: null,
      },
    ]);
  });

  it('returns honest empty decisions and NO activity key at all', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.state(mkReq(), res);
    const body = captured.body as Record<string, unknown>;
    expect(body.decisions).toEqual([]);
    // The feed has exactly ONE producer — GET /api/workspace/activity. A
    // second field here would be a second source of truth for one collection
    // (invariant 4), and the one that shipped was always `[]`, which renders
    // as "nothing has happened" over an agent that has been running for weeks.
    expect(Object.keys(body)).not.toContain('activity');
  });

  it('reports working for an agent with a live session, resting otherwise', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('session:is-alive', 'session', async (_c, i: unknown) => ({
      alive: aliveSessions.has((i as { sessionId: string }).sessionId),
    }));
    conversations = [
      conv({ conversationId: 'c1', agentId: 'a1', activeSessionId: 'sess-live' }),
      // a2 has a STALE activeSessionId — the row is there but the session is
      // gone, which is exactly the case that must not read as "working".
      conv({ conversationId: 'c2', agentId: 'a2', activeSessionId: 'sess-dead' }),
    ];
    aliveSessions.add('sess-live');

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.state(mkReq(), res);
    const body = captured.body as { agents: Array<{ id: string; state: string }> };
    expect(body.agents.find((a) => a.id === 'a1')?.state).toBe('working');
    expect(body.agents.find((a) => a.id === 'a2')?.state).toBe('resting');
  });

  it('reports resting for everyone when session:is-alive is not registered', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    conversations = [
      conv({ conversationId: 'c1', agentId: 'a1', activeSessionId: 'sess-live' }),
    ];
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.state(mkReq(), res);
    const body = captured.body as { agents: Array<{ id: string; state: string }> };
    expect(body.agents.every((a) => a.state === 'resting')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // GET /api/workspace/agents/:agentId
  // -------------------------------------------------------------------------

  it('404s (not 403) an agent the caller cannot reach', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'someone-elses' }), res);
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
  });

  it('400s a missing :agentId', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({}), res);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'missing-agent-id' });
  });

  it('returns empty permissions/files and NO stats key', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), res);
    expect(captured.statusCode).toBe(200);
    const body = captured.body as Record<string, unknown>;
    expect(body.permissions).toEqual([]);
    expect(body.files).toEqual([]);
    // No memory plugin registered in this bus → no rows at all. NOT an empty
    // rules row: an editor over storage that does not exist is the promise
    // AW-13 exists to stop making.
    expect(body.memory).toEqual([]);
    // A zero is a claim. We are not counting anything yet, so there is no
    // place on the wire to put one.
    expect(Object.keys(body)).not.toContain('stats');
    expect(Object.keys(body)).not.toContain('suggestions');
    // No conversations at all → no current conversation, empty thread.
    expect(body.conversationId).toBeNull();
    expect(body.thread).toEqual([]);
    expect(body.past).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The Memory tab (AW-13). What the route may and may not claim.
  // -------------------------------------------------------------------------

  function registerMemory(state: {
    rules: string;
    learned: Array<{ name: string; body: string }>;
    calls: Array<{ hook: string; agentId: string; userId: string }>;
    readThrows?: boolean;
    learnedThrows?: boolean;
  }): void {
    bus.registerService('memory:rules:read', 'memory', async (ctx, i: unknown) => {
      state.calls.push({
        hook: 'read',
        agentId: ctx.agentId,
        userId: ctx.userId ?? '',
      });
      void i;
      if (state.readThrows === true) throw new Error('tier unreachable');
      return { body: state.rules };
    });
    bus.registerService('memory:learned:read', 'memory', async (ctx) => {
      state.calls.push({
        hook: 'learned',
        agentId: ctx.agentId,
        userId: ctx.userId ?? '',
      });
      if (state.learnedThrows === true) throw new Error('tier unreachable');
      return { docs: state.learned };
    });
    bus.registerService('memory:rules:write', 'memory', async (ctx, i: unknown) => {
      const { agentId, body } = i as { agentId: string; body: string };
      state.calls.push({
        hook: 'write',
        agentId: ctx.agentId,
        userId: ctx.userId ?? '',
      });
      expect(agentId).toBe(ctx.agentId);
      state.rules = body;
      return { written: true, body };
    });
  }

  it('splits memory by owner, and routes every read on the agent\'s own ctx', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const state = {
      rules: '- Always cc Priya',
      learned: [{ name: 'What it knows about you', body: '# User\n' }],
      calls: [] as Array<{ hook: string; agentId: string; userId: string }>,
    };
    registerMemory(state);
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), res);

    expect(captured.statusCode).toBe(200);
    expect((captured.body as { memory: unknown }).memory).toEqual([
      { name: 'Your rules', scope: 'rules', body: '- Always cc Priya' },
      { name: 'What it knows about you', scope: 'learned', body: '# User\n' },
    ]);
    // Every call carried the agent + the authenticated caller — never
    // initCtx's `@ax/channel-web` / `system` identity, which would route a
    // later write into the wrong workspace.
    expect(state.calls).toEqual([
      { hook: 'read', agentId: 'a1', userId: 'u1' },
      { hook: 'learned', agentId: 'a1', userId: 'u1' },
    ]);
  });

  it('omits the rules row when the read failed, rather than shipping an empty one', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerMemory({
      rules: '- Always cc Priya',
      learned: [{ name: 'ignored', body: 'ignored' }],
      calls: [],
      readThrows: true,
    });
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), res);

    expect(captured.statusCode).toBe(200);
    /*
      An empty rules row would render as a blank editor over rules the user
      still has — one Save away from destroying them. "We could not read it"
      and "you wrote nothing" are different answers and this surface must not
      confuse them.
    */
    expect((captured.body as { memory: unknown }).memory).toEqual([]);
  });

  it('keeps the editor when only the LEARNED read fails, and invents no learned doc', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerMemory({
      rules: '- Always cc Priya',
      learned: [{ name: 'ignored', body: 'ignored' }],
      calls: [],
      learnedThrows: true,
    });
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), res);

    expect(captured.statusCode).toBe(200);
    // The worst a dropped learned row can cost is a section that says the
    // agent has written nothing yet — so it degrades, and the editor stays.
    expect((captured.body as { memory: unknown }).memory).toEqual([
      { name: 'Your rules', scope: 'rules', body: '- Always cc Priya' },
    ]);
  });

  it('saveRules writes through the hook and never touches storage itself', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const state = { rules: '', learned: [], calls: [] as Array<{ hook: string; agentId: string; userId: string }> };
    registerMemory(state);
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.saveRules(mkReq({ agentId: 'a1' }, { body: '- Always cc Priya' }), res);

    expect(captured.statusCode).toBe(200);
    // The stored text rides back so the editor can adopt it instead of
    // guessing at the writer's normalization.
    expect(captured.body).toEqual({ saved: true, body: '- Always cc Priya' });
    expect(state.rules).toBe('- Always cc Priya');
    expect(state.calls).toEqual([{ hook: 'write', agentId: 'a1', userId: 'u1' }]);
  });

  it('refuses a saveRules with no string body, and 401s an anonymous one', async () => {
    registerAuth(null);
    const anon = makeWorkspaceHandlers({ bus, initCtx });
    const a = mkRes();
    await anon.saveRules(mkReq({ agentId: 'a1' }, { body: 'x' }), a.res);
    expect(a.captured.statusCode).toBe(401);

    bus = new HookBus();
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const { agentId } = i as { agentId: string };
      if (agentId !== 'a1') throw notFound();
      return { agent: { id: 'a1', displayName: 'Inbox' } };
    });
    registerMemory({ rules: '', learned: [], calls: [] });
    const h = makeWorkspaceHandlers({ bus, initCtx });

    const missing = mkRes();
    await h.saveRules(mkReq({ agentId: 'a1' }, { notBody: 1 }), missing.res);
    expect(missing.captured.statusCode).toBe(400);
    expect(missing.captured.body).toEqual({ error: 'invalid-body' });

    const noAgent = mkRes();
    await h.saveRules(mkReq({}, { body: 'x' }), noAgent.res);
    expect(noAgent.captured.statusCode).toBe(400);
    expect(noAgent.captured.body).toEqual({ error: 'missing-agent-id' });

    const foreign = mkRes();
    await h.saveRules(mkReq({ agentId: 'a2' }, { body: 'x' }), foreign.res);
    expect(foreign.captured.statusCode).toBe(404);
  });

  it('builds the thread from real turns, dropping thinking + tool blocks', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    conversations = [conv({ conversationId: 'c1', agentId: 'a1' })];
    turnsByConversation.set('c1', [
      {
        turnId: 't1',
        turnIndex: 0,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'summarise my inbox' }],
        createdAt: '2026-08-01T10:00:00.000Z',
      },
      {
        turnId: 't2',
        turnIndex: 1,
        role: 'assistant',
        contentBlocks: [
          { type: 'thinking', thinking: 'secret scratchpad' },
          { type: 'text', text: 'Four things need you.' },
          { type: 'tool_use', id: 'tu1', name: 'gmail_list', input: {} },
        ],
        createdAt: '2026-08-01T10:00:05.000Z',
      },
      // A turn that is ONLY a tool call has nothing to render — it must be
      // skipped, not turned into an empty bubble.
      {
        turnId: 't3',
        turnIndex: 2,
        role: 'assistant',
        contentBlocks: [{ type: 'tool_use', id: 'tu2', name: 'gmail_get', input: {} }],
        createdAt: '2026-08-01T10:00:06.000Z',
      },
      // Tool-result turns belong to AW-10's tool view, not the thread.
      {
        turnId: 't4',
        turnIndex: 3,
        role: 'tool',
        contentBlocks: [
          { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'x' }] },
        ],
        createdAt: '2026-08-01T10:00:07.000Z',
      },
    ]);

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), res);
    const body = captured.body as {
      conversationId: string | null;
      thread: Array<Record<string, unknown>>;
    };
    expect(body.conversationId).toBe('c1');
    expect(body.thread).toHaveLength(2);
    expect(body.thread[0]).toEqual({
      kind: 'user',
      id: 't1',
      text: 'summarise my inbox',
    });
    expect(body.thread[1]).toMatchObject({
      kind: 'agent',
      id: 't2',
      text: 'Four things need you.',
    });
    expect(String(body.thread[1]!.time)).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/);
    // The scratchpad never crosses the wire.
    expect(JSON.stringify(body.thread)).not.toContain('secret scratchpad');
  });

  it('splits current vs past conversations, newest first', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    conversations = [
      conv({
        conversationId: 'old',
        agentId: 'a1',
        title: 'Last month',
        createdAt: '2026-07-01T10:00:00.000Z',
      }),
      conv({
        conversationId: 'newest',
        agentId: 'a1',
        title: 'Right now',
        createdAt: '2026-07-02T10:00:00.000Z',
        lastActivityAt: new Date().toISOString(),
      }),
      conv({
        conversationId: 'middle',
        agentId: 'a1',
        // No title — the UI never renders a blank row.
        createdAt: '2026-07-15T10:00:00.000Z',
      }),
    ];

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), res);
    const body = captured.body as {
      conversationId: string | null;
      past: Array<{ id: string; title: string; meta: string }>;
    };
    expect(body.conversationId).toBe('newest');
    expect(body.past.map((p) => p.id)).toEqual(['middle', 'old']);
    expect(body.past[0]!.title).toBe('Untitled conversation');
    expect(body.past[0]!.meta.length).toBeGreaterThan(0);
    // A past row carries NO transcript and NO fold count. Both were fixtures:
    // `msgs: []` rendered as "an empty conversation" and `folded: 0` as
    // "0 messages were summarised". The excerpt now comes from a real re-read
    // through `?conversationId=`.
    expect(Object.keys(body.past[0]!)).toEqual(['id', 'title', 'meta']);
  });

  it('serves a past conversation\'s turns when ?conversationId= names one', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    conversations = [
      conv({
        conversationId: 'now',
        agentId: 'a1',
        lastActivityAt: new Date().toISOString(),
      }),
      conv({
        conversationId: 'back-then',
        agentId: 'a1',
        title: 'March',
        createdAt: '2026-03-01T10:00:00.000Z',
      }),
    ];
    turnsByConversation.set('now', [
      {
        turnId: 'n1',
        turnIndex: 0,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'what is on today' }],
        createdAt: '2026-08-01T10:00:00.000Z',
      },
    ]);
    turnsByConversation.set('back-then', [
      {
        turnId: 'b1',
        turnIndex: 0,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'what happened in March' }],
        createdAt: '2026-03-01T10:00:00.000Z',
      },
    ]);

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    const req = mkReq({ agentId: 'a1' });
    // LOWERCASED on purpose: http-server projects every query key through
    // `k.toLowerCase()`, so a camelCase key never reaches a handler. Writing
    // the camelCase key here would make this test agree with a handler that
    // is broken in production.
    (req.query as Record<string, string>)[CONVERSATION_ID_QUERY_KEY] = 'back-then';
    await h.agentDetail(req, res);

    expect(captured.statusCode).toBe(200);
    const body = captured.body as {
      conversationId: string | null;
      thread: Array<Record<string, unknown>>;
    };
    expect(body.conversationId).toBe('back-then');
    expect(body.thread).toEqual([
      { kind: 'user', id: 'b1', text: 'what happened in March' },
    ]);
  });

  it('404s a ?conversationId= that belongs to a different agent', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    conversations = [
      conv({ conversationId: 'mine', agentId: 'a1' }),
      // Same owner, different agent. Rendering it under a1's name would be
      // the exact cross-agent leak the current-conversation check prevents.
      conv({ conversationId: 'theirs', agentId: 'a2' }),
    ];
    turnsByConversation.set('theirs', [
      {
        turnId: 'x1',
        turnIndex: 0,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'other agent secrets' }],
        createdAt: '2026-08-01T10:00:00.000Z',
      },
    ]);

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    const req = mkReq({ agentId: 'a1' });
    // LOWERCASED on purpose: http-server projects every query key through
    // `k.toLowerCase()`, so a camelCase key never reaches a handler. Writing
    // the camelCase key here would make this test agree with a handler that
    // is broken in production.
    (req.query as Record<string, string>)[CONVERSATION_ID_QUERY_KEY] = 'theirs';
    await h.agentDetail(req, res);

    expect(captured.statusCode).toBe(404);
    expect(JSON.stringify(captured.body)).not.toContain('other agent secrets');
  });

  it('404s a ?conversationId= nobody can read, rather than rendering it empty', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    conversations = [conv({ conversationId: 'mine', agentId: 'a1' })];

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    const req = mkReq({ agentId: 'a1' });
    // LOWERCASED on purpose: http-server projects every query key through
    // `k.toLowerCase()`, so a camelCase key never reaches a handler. Writing
    // the camelCase key here would make this test agree with a handler that
    // is broken in production.
    (req.query as Record<string, string>)[CONVERSATION_ID_QUERY_KEY] = 'never-existed';
    await h.agentDetail(req, res);

    expect(captured.statusCode).toBe(404);
  });

  it('degrades to no-current-conversation when it is deleted mid-read', async () => {
    // The benign race: conversations:list saw the row, conversations:get no
    // longer does. That is a 200 with nothing to show, never a 500.
    bus = new HookBus();
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('agents:list-for-user', 'agents', async () => ({ agents: [] }));
    bus.registerService('agents:resolve', 'agents', async () => ({
      agent: { id: 'a1', displayName: 'Inbox', visibility: 'personal' },
    }));
    bus.registerService('conversations:list', 'conversations', async () => [
      conv({ conversationId: 'vanishing', agentId: 'a1' }),
    ]);
    // The list saw it; by the time we read it, it is gone.
    bus.registerService('conversations:get', 'conversations', async () => {
      throw notFound();
    });

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), res);

    expect(captured.statusCode).toBe(200);
    const body = captured.body as { conversationId: string | null; thread: unknown[] };
    expect(body.conversationId).toBeNull();
    expect(body.thread).toEqual([]);
  });

  it('does NOT swallow a real conversations:get fault into an empty thread', async () => {
    // The benign race above is a PluginError. A DB outage is not, and
    // rendering it as "this agent has no history" would be a claim we cannot
    // back on top of a failure nobody was told about. It must propagate.
    bus = new HookBus();
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('agents:list-for-user', 'agents', async () => ({ agents: [] }));
    bus.registerService('agents:resolve', 'agents', async () => ({
      agent: { id: 'a1', displayName: 'Inbox', visibility: 'personal' },
    }));
    bus.registerService('conversations:list', 'conversations', async () => [
      conv({ conversationId: 'live', agentId: 'a1' }),
    ]);
    bus.registerService('conversations:get', 'conversations', async () => {
      throw new Error('connection terminated unexpectedly');
    });

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res } = mkRes();
    await expect(h.agentDetail(mkReq({ agentId: 'a1' }), res)).rejects.toThrow(
      /connection terminated/,
    );
  });

  it('does NOT swallow a real conversations:list fault into "no history"', async () => {
    // On the detail panel the conversation list IS the content, so an
    // unreadable list must not render as an agent that has never been used.
    bus = new HookBus();
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('agents:list-for-user', 'agents', async () => ({ agents: [] }));
    bus.registerService('agents:resolve', 'agents', async () => ({
      agent: { id: 'a1', displayName: 'Inbox', visibility: 'personal' },
    }));
    bus.registerService('conversations:list', 'conversations', async () => {
      throw new Error('connection terminated unexpectedly');
    });

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res } = mkRes();
    await expect(h.agentDetail(mkReq({ agentId: 'a1' }), res)).rejects.toThrow(
      /connection terminated/,
    );
  });

  it('404s when the current conversation belongs to a different agent', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    // conversations:list is filtered by agent, but conversations:get is the
    // authority. A mismatch means something drifted — refuse rather than
    // render another agent's transcript under this agent's name.
    conversations = [conv({ conversationId: 'c1', agentId: 'a1' })];
    bus = new HookBus();
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('agents:list-for-user', 'agents', async () => ({ agents: [] }));
    bus.registerService('agents:resolve', 'agents', async () => ({
      agent: { id: 'a1', displayName: 'Inbox', visibility: 'personal' },
    }));
    bus.registerService('conversations:list', 'conversations', async () => [
      conv({ conversationId: 'c1', agentId: 'a1' }),
    ]);
    bus.registerService('conversations:get', 'conversations', async () => ({
      conversation: conv({ conversationId: 'c1', agentId: 'SOMEONE-ELSE' }),
      turns: [],
    }));

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), res);
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
  });

  // -------------------------------------------------------------------------
  // POST /api/workspace/route
  // -------------------------------------------------------------------------

  it('routes confidently when the caller has exactly one agent', async () => {
    bus = new HookBus();
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('agents:list-for-user', 'agents', async () => ({
      agents: [{ id: 'a1', displayName: 'Inbox', visibility: 'personal' }],
    }));
    bus.registerService('conversations:list', 'conversations', async () => []);

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.route(mkReq({}, { text: 'ignored entirely' }), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      agentId: 'a1',
      agentName: 'Inbox',
      why: "it's your only agent",
      confident: true,
    });
  });

  it('picks the most recently active agent, unconfidently, when there are several', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    conversations = [
      conv({
        conversationId: 'c1',
        agentId: 'a1',
        createdAt: '2026-07-01T10:00:00.000Z',
      }),
      conv({
        conversationId: 'c2',
        agentId: 'a2',
        createdAt: '2026-07-01T09:00:00.000Z',
        lastActivityAt: '2026-08-10T09:00:00.000Z',
      }),
    ];
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.route(mkReq({}, {}), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      agentId: 'a2',
      agentName: 'Research',
      why: 'it is the agent you used most recently',
      confident: false,
    });
  });

  it('sorts an agent with no conversations last, breaking ties by name', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    // Neither agent has a conversation → both sort last → the tie-break by
    // displayName decides, so the answer is stable across calls.
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.route(mkReq({}, {}), res);
    expect(captured.body).toMatchObject({ agentId: 'a1', confident: false });
  });

  it('does not claim recency when the conversation read failed', async () => {
    // The swallow-then-claim shape: the list read degrades to empty (one
    // agent's hiccup must not 404 the whole picker), the pick collapses to
    // alphabetical, and saying "you used it most recently" would be a claim
    // built on a failure nobody was told about.
    bus = new HookBus();
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('agents:list-for-user', 'agents', async () => ({
      agents: [
        { id: 'a1', displayName: 'Inbox', visibility: 'personal' },
        { id: 'a2', displayName: 'Research', visibility: 'personal' },
      ],
    }));
    bus.registerService('conversations:list', 'conversations', async () => {
      throw new Error('connection terminated unexpectedly');
    });

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.route(mkReq({}, {}), res);

    expect(captured.statusCode).toBe(200);
    const body = captured.body as { why: string; confident: boolean };
    expect(body.why).not.toMatch(/most recently/);
    expect(body.why).toMatch(/couldn't tell/);
    expect(body.confident).toBe(false);
  });

  it('does not claim recency when nobody has a conversation yet', async () => {
    // Same sentence, different cause: every agent is genuinely brand new, so
    // the pick is alphabetical and there is no "most recently" to report.
    registerAuth({ id: 'u1', isAdmin: false });
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.route(mkReq({}, {}), res);
    expect((captured.body as { why: string }).why).not.toMatch(/most recently/);
  });

  it('404s when the caller has no agents at all', async () => {
    bus = new HookBus();
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('agents:list-for-user', 'agents', async () => ({ agents: [] }));
    bus.registerService('conversations:list', 'conversations', async () => []);

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.route(mkReq({}, {}), res);
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'no-agents' });
  });

  it('never reads userId from the request body', async () => {
    const seen: Array<{ userId: string }> = [];
    bus = new HookBus();
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('agents:list-for-user', 'agents', async (_c, i: unknown) => {
      seen.push(i as { userId: string });
      return { agents: [{ id: 'a1', displayName: 'Inbox', visibility: 'personal' }] };
    });
    bus.registerService('conversations:list', 'conversations', async () => []);

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res } = mkRes();
    await h.route(mkReq({}, { userId: 'someone-else' }), res);
    const s = mkRes();
    await h.state(mkReq(), s.res);
    expect(seen.every((c) => c.userId === 'u1')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // GET /api/workspace/activity — the ONE collection behind the feed.
  // -------------------------------------------------------------------------

  function activityReq(query: Record<string, string> = {}): RouteRequest {
    const req = mkReq();
    // LOWERCASED on purpose: http-server projects every query key through
    // `k.toLowerCase()`, so a camelCase key never reaches a handler. Writing
    // camelCase here would make this test agree with a handler that is broken
    // in production. Proving the SPELLING is right needs a real URL, which is
    // what `routes-workspace-query.test.ts` boots a server to do.
    Object.assign(req.query as Record<string, string>, query);
    return req;
  }

  interface ActivityBody {
    events: Array<Record<string, unknown>>;
    nextBefore: string | null;
  }

  it('401s an unauthenticated caller on /activity', async () => {
    registerAuth(null);
    registerRoutines();
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq(), res);
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
  });

  it('404s (not 403) an agentid the caller cannot reach', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    fires = [
      fire({ id: 1, agentId: 'someone-elses', firedAt: '2026-08-20T10:00:00.000Z' }),
    ];
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(
      activityReq({ [ACTIVITY_AGENT_ID_QUERY_KEY]: 'someone-elses' }),
      res,
    );
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
  });

  it('renders a silenced fire as nothing at all', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    routinesByAgent.set('a1', [
      { path: 'daily.md', name: 'Morning digest' },
      { path: 'watch.md', name: 'Inbox watch' },
    ]);
    fires = [
      fire({ id: 1, firedAt: '2026-08-20T12:00:00.000Z', status: 'ok' }),
      // A silenced fire produced NOTHING. A row claiming otherwise would be a
      // receipt for an event that never happened (design H1).
      fire({
        id: 2,
        firedAt: '2026-08-20T11:00:00.000Z',
        status: 'silenced',
        path: 'watch.md',
      }),
      fire({
        id: 3,
        firedAt: '2026-08-20T10:00:00.000Z',
        status: 'error',
        error: 'imap said no',
      }),
    ];

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq(), res);
    expect(captured.statusCode).toBe(200);
    const body = captured.body as ActivityBody;
    expect(body.events.map((e) => e.kind)).toEqual(['done', 'stopped']);
    expect(JSON.stringify(body)).not.toContain('Inbox watch');
  });

  it('renders an errored fire as a stopped row carrying the real error', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    routinesByAgent.set('a1', [{ path: 'daily.md', name: 'Morning digest' }]);
    fires = [
      fire({
        id: 1,
        firedAt: '2026-08-20T10:00:00.000Z',
        status: 'error',
        error: 'gmail refused the connection',
      }),
      // No error text was recorded. We say so in plain words rather than
      // inventing a reason or shipping an empty string that renders as a
      // blank line under a row that says something went wrong.
      fire({
        id: 2,
        firedAt: '2026-08-20T09:00:00.000Z',
        path: 'sweep.md',
        status: 'error',
        error: null,
      }),
      // A recorded-but-blank error is the SAME absence as a null one. Passing
      // it through renders a failure row with nothing underneath it.
      fire({
        id: 3,
        firedAt: '2026-08-20T08:00:00.000Z',
        path: 'sweep.md',
        status: 'error',
        error: '   ',
      }),
    ];

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq(), res);
    const body = captured.body as ActivityBody;
    expect(body.events[0]).toMatchObject({
      kind: 'stopped',
      text: 'Morning digest',
      detail: 'gmail refused the connection',
    });
    // The routine is gone but its fires survive — the path is a real
    // identifier, so it stands in for the name rather than a guessed label.
    expect(body.events[1]).toMatchObject({ kind: 'stopped', text: 'sweep.md' });
    expect(body.events[1]!.detail).toBe('It failed, and no reason was recorded.');
    expect(body.events[2]!.detail).toBe('It failed, and no reason was recorded.');
  });

  it('carries an ISO instant and no server-computed day/time', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    routinesByAgent.set('a1', [{ path: 'daily.md', name: 'Morning digest' }]);
    fires = [fire({ id: 1, firedAt: '2026-08-20T16:12:00.000Z' })];

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq(), res);
    const body = captured.body as ActivityBody;
    const row = body.events[0]!;
    expect(row.at).toBe('2026-08-20T16:12:00.000Z');
    // "Today" and "4:12 PM" are rendering decisions, and a server that makes
    // them files every reader outside its own timezone under the wrong day.
    expect(Object.keys(row)).not.toContain('day');
    expect(Object.keys(row)).not.toContain('time');
    expect(row.tag).toBe('Scheduled');
    expect(row.decisionId).toBeNull();
  });

  it('never puts the fire row id on the wire', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    routinesByAgent.set('a1', [{ path: 'daily.md', name: 'Morning digest' }]);
    // A distinctive id: if it leaks anywhere in the body, this finds it.
    fires = [fire({ id: 987654321, firedAt: '2026-08-20T10:00:00.000Z' })];

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq(), res);
    // FireRow.id is a BIGSERIAL — storage vocabulary. Shipping it would invite
    // a client to paginate on it, which no other fire-history backend could
    // reproduce. The cursor is the instant instead.
    expect(JSON.stringify(captured.body)).not.toContain('987654321');
    expect((captured.body as ActivityBody).events[0]!.id).toBe(
      'a1|daily.md|2026-08-20T10:00:00.000Z',
    );
  });

  it('merges both agents\' fires into one time-ordered collection', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    routinesByAgent.set('a1', [{ path: 'daily.md', name: 'Morning digest' }]);
    routinesByAgent.set('a2', [{ path: 'scan.md', name: 'Paper scan' }]);
    fires = [
      fire({ id: 1, agentId: 'a1', firedAt: '2026-08-20T09:00:00.000Z' }),
      fire({
        id: 2,
        agentId: 'a2',
        path: 'scan.md',
        firedAt: '2026-08-20T11:00:00.000Z',
      }),
      fire({ id: 3, agentId: 'a1', firedAt: '2026-08-20T13:00:00.000Z' }),
    ];

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq(), res);
    const body = captured.body as ActivityBody;
    expect(body.events.map((e) => e.agentId)).toEqual(['a1', 'a2', 'a1']);
    // Each row is named by ITS OWN agent's routines. `routines:list` with no
    // agentId returns every agent's rows, so a mixed-up name here would mean
    // the fan-out forgot to scope the call.
    expect(body.events.map((e) => e.text)).toEqual([
      'Morning digest',
      'Paper scan',
      'Morning digest',
    ]);
  });

  it('scopes the feed to one agent when agentid names one', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    routinesByAgent.set('a1', [{ path: 'daily.md', name: 'Morning digest' }]);
    routinesByAgent.set('a2', [{ path: 'scan.md', name: 'Paper scan' }]);
    fires = [
      fire({ id: 1, agentId: 'a1', firedAt: '2026-08-20T09:00:00.000Z' }),
      fire({
        id: 2,
        agentId: 'a2',
        path: 'scan.md',
        firedAt: '2026-08-20T11:00:00.000Z',
      }),
    ];

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq({ [ACTIVITY_AGENT_ID_QUERY_KEY]: 'a2' }), res);
    expect((captured.body as ActivityBody).events.map((e) => e.agentId)).toEqual([
      'a2',
    ]);
  });

  it('returns a nextBefore even when every fire on the page was silenced', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    routinesByAgent.set('a1', [{ path: 'daily.md', name: 'Morning digest' }]);
    fires = [
      fire({ id: 1, firedAt: '2026-08-20T12:00:00.000Z', status: 'silenced' }),
      fire({ id: 2, firedAt: '2026-08-20T11:00:00.000Z', status: 'silenced' }),
    ];

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq({ [ACTIVITY_LIMIT_QUERY_KEY]: '2' }), res);
    const body = captured.body as ActivityBody;
    // Zero rows rendered, but there may well be history behind them. A client
    // paginating on the last RENDERED row would have nothing to page from and
    // would dead-end on a page that is empty by construction.
    expect(body.events).toEqual([]);
    expect(body.nextBefore).toBe('2026-08-20T11:00:00.000Z');
  });

  it('pages back through the cursor it handed out', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    routinesByAgent.set('a1', [{ path: 'daily.md', name: 'Morning digest' }]);
    fires = [
      fire({ id: 1, firedAt: '2026-08-20T12:00:00.000Z' }),
      fire({ id: 2, firedAt: '2026-08-20T11:00:00.000Z' }),
      fire({ id: 3, firedAt: '2026-08-20T10:00:00.000Z' }),
    ];

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const first = mkRes();
    await h.activity(activityReq({ [ACTIVITY_LIMIT_QUERY_KEY]: '2' }), first.res);
    const page1 = first.captured.body as ActivityBody;
    expect(page1.events.map((e) => e.at)).toEqual([
      '2026-08-20T12:00:00.000Z',
      '2026-08-20T11:00:00.000Z',
    ]);
    expect(page1.nextBefore).toBe('2026-08-20T11:00:00.000Z');

    const second = mkRes();
    await h.activity(
      activityReq({
        [ACTIVITY_LIMIT_QUERY_KEY]: '2',
        [ACTIVITY_BEFORE_QUERY_KEY]: page1.nextBefore!,
      }),
      second.res,
    );
    const page2 = second.captured.body as ActivityBody;
    expect(page2.events.map((e) => e.at)).toEqual(['2026-08-20T10:00:00.000Z']);
    // The roster came back short of the page size, so every agent handed over
    // everything it had — there is genuinely nothing older to ask for.
    expect(page2.nextBefore).toBeNull();
  });

  it('400s an unparseable before cursor rather than serving page one again', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    fires = [fire({ id: 1, firedAt: '2026-08-20T12:00:00.000Z' })];
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(
      activityReq({ [ACTIVITY_BEFORE_QUERY_KEY]: 'last tuesday' }),
      res,
    );
    // Silently ignoring the cursor would restart the feed at the top, which
    // reads as an infinite scroll that loops forever and never says why.
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-before' });
  });

  it('clamps limit to 1..ACTIVITY_MAX_LIMIT', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const asked: number[] = [];
    bus.registerService(
      'routines:recent-fires-for-agent',
      'routines',
      async (_c, i: unknown) => {
        asked.push((i as { limit: number }).limit);
        return { fires: [] };
      },
    );
    const h = makeWorkspaceHandlers({ bus, initCtx });
    for (const raw of ['0', '-5', '99999', 'not a number']) {
      const { res } = mkRes();
      await h.activity(activityReq({ [ACTIVITY_LIMIT_QUERY_KEY]: raw }), res);
    }
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((n) => n >= 1 && n <= ACTIVITY_MAX_LIMIT)).toBe(true);
  });

  it('degrades one unreadable agent to nothing instead of 500ing the page', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    routinesByAgent.set('a1', [{ path: 'daily.md', name: 'Morning digest' }]);
    fires = [fire({ id: 1, agentId: 'a1', firedAt: '2026-08-20T12:00:00.000Z' })];
    firesReadFailure.set('a2', new Error('connection terminated unexpectedly'));

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq(), res);
    // One agent's hiccup must not take out a roster-wide page. It is logged,
    // and that agent contributes nothing — the same degradation the roster's
    // conversation listing already makes.
    expect(captured.statusCode).toBe(200);
    expect((captured.body as ActivityBody).events.map((e) => e.agentId)).toEqual([
      'a1',
    ]);
  });

  it('does NOT swallow the fault when the feed is scoped to that one agent', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerRoutines();
    firesReadFailure.set('a1', new Error('connection terminated unexpectedly'));

    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res } = mkRes();
    // Scoped, that agent's history IS the content. Rendering the failure as an
    // empty feed would claim the agent has done nothing, on top of a fault
    // nobody was told about (design H7).
    await expect(
      h.activity(activityReq({ [ACTIVITY_AGENT_ID_QUERY_KEY]: 'a1' }), res),
    ).rejects.toThrow(/connection terminated/);
  });

  it('returns an honest empty feed when nothing records routine history', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    // No routines plugin in this deployment. There genuinely is no history, so
    // empty is the true answer — not a 503 and not a fabricated row.
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq(), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ events: [], nextBefore: null });
  });

  it('still shows the fires when routines:list is unavailable', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    bus.registerService('routines:recent-fires-for-agent', 'routines', async () => ({
      fires: [fire({ id: 1, firedAt: '2026-08-20T12:00:00.000Z' })],
    }));
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.activity(activityReq(), res);
    // No authored name to be had — the path is the honest stand-in. Dropping
    // the row would claim the agent did nothing, which is the bigger lie.
    expect((captured.body as ActivityBody).events[0]!.text).toBe('daily.md');
  });

  // --- the pure mapping ----------------------------------------------------

  it('labels the trigger in plain words, and says nothing for one it cannot name', () => {
    const names = new Map([['daily.md', 'Morning digest']]);
    const at = '2026-08-20T12:00:00.000Z';
    expect(
      fireToActivityEvent(fire({ id: 1, firedAt: at, triggerSource: 'tick' }), names)
        ?.tag,
    ).toBe('Scheduled');
    expect(
      fireToActivityEvent(fire({ id: 2, firedAt: at, triggerSource: 'webhook' }), names)
        ?.tag,
    ).toBe('Webhook');
    expect(
      fireToActivityEvent(fire({ id: 3, firedAt: at, triggerSource: 'manual' }), names)
        ?.tag,
    ).toBe('Run by hand');
    // A source we have no sentence for renders as no tag at all. Printing the
    // raw token would put backend vocabulary in front of a human.
    const alien = { ...fire({ id: 4, firedAt: at }), triggerSource: 'quantum' as never };
    expect(fireToActivityEvent(alien, names)?.tag).toBeNull();
  });

  it('drops a fire whose instant cannot be read', () => {
    const broken = fire({ id: 1, firedAt: '2026-08-20T12:00:00.000Z' });
    (broken as { firedAt: unknown }).firedAt = 'the other day';
    // A row we cannot place in time would be bucketed under an arbitrary date,
    // which is itself a claim about WHEN something happened. There is no
    // honest rendering of it, so there is no row.
    expect(fireToActivityEvent(broken, new Map())).toBeNull();
  });

  // --- the fence on agent-authored text ------------------------------------
  //
  // A routine's `name` is authored in a file in the agent's own workspace and
  // validated for non-emptiness and nothing else, and a fire's `error` is
  // whatever the failure happened to say. Both land on a feed row that speaks
  // in OUR voice. React escapes markup, so this was never XSS — the failure is
  // a label that reorders or hides what the reader sees, and an unbounded
  // string on the wire. The fence lives here, at the trust boundary, not in
  // the renderer.

  /** Everything the fence exists to keep off a row. */
  const REWRITES_THE_SURFACE =
    /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

  const at = '2026-08-20T12:00:00.000Z';
  const rowFor = (name: string) =>
    fireToActivityEvent(fire({ id: 1, firedAt: at }), new Map([['daily.md', name]]))!;

  it.each([
    ['a right-to-left override', '\u202EMorning digest'],
    ['an unterminated isolate', '\u2066Morning digest'],
    ['a zero-width space', 'Morning\u200Bdigest'],
    ['a zero-width joiner', 'Morning\u200Ddigest'],
    ['a byte-order mark', '\uFEFFMorning digest'],
    ['a C0 control character', 'Morning\u0007digest'],
  ])(
    'neutralises %s in an authored routine name — a label must not rewrite what a reader sees',
    (_what, name) => {
      const { text } = rowFor(name);
      expect(text).not.toMatch(REWRITES_THE_SURFACE);
      expect(text).toBe('Morning digest');
    },
  );

  it('caps an over-long name on CODE POINTS, never splitting a surrogate pair', () => {
    // 58 plain characters then astral ones, so a UTF-16 slice at 59 would cut
    // a pair in half and put a lone high surrogate on the wire.
    const { text } = rowFor(`${'M'.repeat(58)}\u{1F600}\u{1F600}\u{1F600}`);
    expect([...text]).toHaveLength(ACTIVITY_LABEL_MAX_CHARS);
    expect(text.endsWith('…')).toBe(true);
    // Iterating a string yields whole code points, so a surviving LONE
    // surrogate shows up as a single unit in the surrogate range. `String`'s
    // own `isWellFormed` says this in one call but needs an ES2024 lib.
    const lone = [...text].filter((c) => {
      const cp = c.codePointAt(0)!;
      return cp >= 0xd800 && cp <= 0xdfff;
    });
    expect(lone).toEqual([]);
  });

  it('marks the truncation rather than silently shortening the name', () => {
    const { text } = rowFor('M'.repeat(500));
    expect(text).toHaveLength(ACTIVITY_LABEL_MAX_CHARS);
    expect(text.endsWith('…')).toBe(true);
  });

  it('leaves a name that already fits completely alone', () => {
    const exact = 'M'.repeat(ACTIVITY_LABEL_MAX_CHARS);
    expect(rowFor(exact).text).toBe(exact);
  });

  it('fences the recorded error on a stopped row too, and bounds it', () => {
    const ev = fireToActivityEvent(
      fire({
        id: 1,
        firedAt: at,
        status: 'error',
        error: `\u202Ednuof ton\u0000 ${'e'.repeat(500)}`,
      }),
      new Map(),
    )!;
    expect(ev.detail).not.toMatch(REWRITES_THE_SURFACE);
    expect([...ev.detail!]).toHaveLength(ACTIVITY_DETAIL_MAX_CHARS);
  });

  it('lands an error made only of invisible characters on the "no reason" sentence', () => {
    // Whitespace already fell through to that sentence. A string of nothing
    // but control and bidi characters is the SAME absence wearing a costume —
    // fencing it must not produce an empty second line under "it stopped".
    const ev = fireToActivityEvent(
      fire({ id: 1, firedAt: at, status: 'error', error: '\u200B\u202E\u0007\u2066' }),
      new Map(),
    )!;
    expect(ev.detail).toBe('It failed, and no reason was recorded.');
  });

  it('falls through to the path when a name fences down to nothing', () => {
    // Same fall-through an absent name gets: the path is the truest thing still
    // known about the row, and the row is never dropped.
    expect(rowFor('\u200B\u202E').text).toBe('daily.md');
  });
});
