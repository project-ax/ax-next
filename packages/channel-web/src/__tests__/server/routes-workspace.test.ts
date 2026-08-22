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
import { makeWorkspaceHandlers } from '../../server/routes-workspace.js';
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

describe('channel-web agent-workspace BFF', () => {
  let bus: HookBus;
  let conversations: ConvRow[];
  let aliveSessions: Set<string>;
  let turnsByConversation: Map<string, unknown[]>;

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

  beforeEach(() => {
    bus = new HookBus();
    conversations = [];
    aliveSessions = new Set<string>();
    turnsByConversation = new Map<string, unknown[]>();

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

  it('returns honest empty decisions + activity (AW-10 / AW-11 own those)', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.state(mkReq(), res);
    const body = captured.body as { decisions: unknown[]; activity: unknown[] };
    expect(body.decisions).toEqual([]);
    expect(body.activity).toEqual([]);
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

  it('returns empty permissions/files/memory and NO stats key', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), res);
    expect(captured.statusCode).toBe(200);
    const body = captured.body as Record<string, unknown>;
    expect(body.permissions).toEqual([]);
    expect(body.files).toEqual([]);
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
    (req.query as Record<string, string>).conversationId = 'back-then';
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
    (req.query as Record<string, string>).conversationId = 'theirs';
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
    (req.query as Record<string, string>).conversationId = 'never-existed';
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
});
