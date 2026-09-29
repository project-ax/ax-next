// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import {
  createChatRouteHandlers,
  registerChatRoutes,
  type RouteRequest,
  type RouteResponse,
} from '../../server/routes-chat';
import { InterruptTurnResponse } from '../../wire/chat';

// ---------------------------------------------------------------------------
// TASK-688 — POST /api/chat/conversations/:id/interrupt (the Stop button's
// route). We drive the handler factory directly with a fake bus + fake req/res
// (same style as routes-chat-card-eviction.test.ts). The security-critical
// claims pinned here:
//   - the userId that reaches `agent:interrupt` is ALWAYS the authenticated one
//     (the route ignores the body and query entirely);
//   - a conversation that isn't yours is a 404 exactly like one that doesn't
//     exist, and `agent:interrupt` is never called for it;
//   - a missing hook is a loud 503, not a silent 200.
// ---------------------------------------------------------------------------

const initCtx = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

function fakeReq(o: {
  params?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
} = {}): RouteRequest {
  const body = o.body ?? '';
  return {
    headers: {},
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'),
    cookies: {},
    query: o.query ?? {},
    params: o.params ?? { id: 'cnv1' },
    signedCookie() {
      return null;
    },
  };
}

function fakeRes(): { res: RouteResponse; captured: { status?: number; json?: unknown } } {
  const captured: { status?: number; json?: unknown } = {};
  const res: RouteResponse = {
    status(n) {
      captured.status = n;
      return res;
    },
    json(v) {
      captured.json = v;
    },
    text() {},
    end() {},
  };
  return { res, captured };
}

interface Calls {
  interrupt: Array<{ ctx: AgentContext; input: Record<string, unknown> }>;
  conversationsGet: Array<Record<string, unknown>>;
  agentsResolve: Array<Record<string, unknown>>;
}

function makeBus(opts: {
  authFails?: boolean;
  conversationsGetThrows?: unknown;
  agentsResolveThrows?: unknown;
  /** Omit the hook entirely (a preset that doesn't load the orchestrator). */
  noInterruptHook?: boolean;
  interruptResult?: { interrupted: boolean };
  interruptThrows?: unknown;
} = {}): { bus: HookBus; calls: Calls } {
  const calls: Calls = { interrupt: [], conversationsGet: [], agentsResolve: [] };
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'mock-auth', async () => {
    if (opts.authFails) {
      throw new PluginError({ code: 'unauthenticated', plugin: 'mock', message: 'no session' });
    }
    return { user: { id: 'userA', isAdmin: false } };
  });
  bus.registerService('conversations:get', 'mock-conv', async (_ctx, input) => {
    calls.conversationsGet.push(input as Record<string, unknown>);
    if (opts.conversationsGetThrows !== undefined) throw opts.conversationsGetThrows;
    return {
      conversation: {
        conversationId: 'cnv1',
        userId: 'userA',
        agentId: 'agt_test',
        title: null,
        activeSessionId: 'sess-1',
        activeReqId: 'req-1',
        createdAt: 't',
        updatedAt: 't',
      },
      turns: [],
    };
  });
  bus.registerService('agents:resolve', 'mock-agents', async (_ctx, input) => {
    calls.agentsResolve.push(input as Record<string, unknown>);
    if (opts.agentsResolveThrows !== undefined) throw opts.agentsResolveThrows;
    return { agent: { id: 'agt_test' } };
  });
  if (!opts.noInterruptHook) {
    bus.registerService('agent:interrupt', 'mock-orchestrator', async (ctx, input) => {
      calls.interrupt.push({ ctx, input: input as Record<string, unknown> });
      if (opts.interruptThrows !== undefined) throw opts.interruptThrows;
      return opts.interruptResult ?? { interrupted: true };
    });
  }
  return { bus, calls };
}

const pluginError = (code: string) =>
  new PluginError({ code, plugin: 'mock', message: code });

describe('POST /api/chat/conversations/:id/interrupt', () => {
  it('401 when unauthenticated, and nothing downstream runs', async () => {
    const { bus, calls } = makeBus({ authFails: true });
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handlers.postInterrupt(fakeReq(), res);
    expect(captured.status).toBe(401);
    expect(captured.json).toEqual({ error: 'unauthenticated' });
    expect(calls.conversationsGet).toEqual([]);
    expect(calls.interrupt).toEqual([]);
  });

  it('400 when the conversation id is missing', async () => {
    const { bus, calls } = makeBus();
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handlers.postInterrupt(fakeReq({ params: {} }), res);
    expect(captured.status).toBe(400);
    expect(captured.json).toEqual({ error: 'missing-conversation-id' });
    expect(calls.interrupt).toEqual([]);
  });

  it('a conversation that is not yours (forbidden) is a 404 and agent:interrupt is NEVER called', async () => {
    const { bus, calls } = makeBus({ conversationsGetThrows: pluginError('forbidden') });
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handlers.postInterrupt(fakeReq(), res);
    expect(captured.status).toBe(404);
    expect(captured.json).toEqual({ error: 'conversation-not-found' });
    expect(calls.interrupt).toEqual([]);
  });

  it('an unknown conversation (not-found) is the same 404 body — no existence leak', async () => {
    const { bus, calls } = makeBus({ conversationsGetThrows: pluginError('not-found') });
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handlers.postInterrupt(fakeReq({ params: { id: 'cnv-nope' } }), res);
    expect(captured.status).toBe(404);
    expect(captured.json).toEqual({ error: 'conversation-not-found' });
    expect(calls.interrupt).toEqual([]);
  });

  it('any other conversations:get failure is not swallowed', async () => {
    const { bus, calls } = makeBus({ conversationsGetThrows: pluginError('internal') });
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res } = fakeRes();
    await expect(handlers.postInterrupt(fakeReq(), res)).rejects.toMatchObject({ code: 'internal' });
    expect(calls.interrupt).toEqual([]);
  });

  it.each(['forbidden', 'not-found'])(
    'agents:resolve %s (the agent is no longer reachable) is a 404 and agent:interrupt is NEVER called',
    async (code) => {
      const { bus, calls } = makeBus({ agentsResolveThrows: pluginError(code) });
      const handlers = createChatRouteHandlers({ bus, initCtx });
      const { res, captured } = fakeRes();
      await handlers.postInterrupt(fakeReq(), res);
      expect(captured.status).toBe(404);
      expect(captured.json).toEqual({ error: 'conversation-not-found' });
      expect(calls.interrupt).toEqual([]);
    },
  );

  it('happy path: 200 { interrupted: true }, ACL ran with the authenticated user, and the hook got a real per-request ctx', async () => {
    const { bus, calls } = makeBus({ interruptResult: { interrupted: true } });
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handlers.postInterrupt(fakeReq(), res);
    expect(captured.status).toBe(200);
    expect(captured.json).toEqual({ interrupted: true });
    expect(InterruptTurnResponse.safeParse(captured.json).success).toBe(true);

    expect(calls.conversationsGet).toEqual([{ conversationId: 'cnv1', userId: 'userA' }]);
    expect(calls.agentsResolve).toEqual([{ agentId: 'agt_test', userId: 'userA' }]);
    expect(calls.interrupt).toHaveLength(1);
    expect(calls.interrupt[0]!.input).toEqual({ conversationId: 'cnv1', userId: 'userA' });
    const ctx = calls.interrupt[0]!.ctx;
    expect(ctx.userId).toBe('userA');
    expect(ctx.agentId).toBe('agt_test');
    expect(ctx.conversationId).toBe('cnv1');
  });

  it('the userId is ALWAYS the authenticated one — a body or query that smuggles another is ignored', async () => {
    const { bus, calls } = makeBus();
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handlers.postInterrupt(
      fakeReq({
        body: { userId: 'userB', conversationId: 'cnv-other', agentId: 'agt_other' },
        query: { userId: 'userB', conversationId: 'cnv-other' },
      }),
      res,
    );
    expect(captured.status).toBe(200);
    // The conversation is the PATH param; the user is the session's user.
    expect(calls.conversationsGet).toEqual([{ conversationId: 'cnv1', userId: 'userA' }]);
    expect(calls.interrupt).toHaveLength(1);
    expect(calls.interrupt[0]!.input).toEqual({ conversationId: 'cnv1', userId: 'userA' });
    expect(calls.interrupt[0]!.ctx.userId).toBe('userA');
    expect(calls.agentsResolve).toEqual([{ agentId: 'agt_test', userId: 'userA' }]);
  });

  it('the body is never parsed: a malformed one does not change the answer', async () => {
    const { bus } = makeBus();
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handlers.postInterrupt(fakeReq({ body: '{not json' }), res);
    expect(captured.status).toBe(200);
    expect(captured.json).toEqual({ interrupted: true });
  });

  it('nothing to stop: 200 { interrupted: false } is passed through', async () => {
    const { bus } = makeBus({ interruptResult: { interrupted: false } });
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handlers.postInterrupt(fakeReq(), res);
    expect(captured.status).toBe(200);
    expect(captured.json).toEqual({ interrupted: false });
  });

  it('503 { error: "interrupt-unavailable" } when no orchestrator registers agent:interrupt', async () => {
    const { bus } = makeBus({ noInterruptHook: true });
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handlers.postInterrupt(fakeReq(), res);
    expect(captured.status).toBe(503);
    expect(captured.json).toEqual({ error: 'interrupt-unavailable' });
  });

  it.each(['forbidden', 'not-found'])(
    'the hook re-checking and throwing %s is the same 404',
    async (code) => {
      const { bus } = makeBus({ interruptThrows: pluginError(code) });
      const handlers = createChatRouteHandlers({ bus, initCtx });
      const { res, captured } = fakeRes();
      await handlers.postInterrupt(fakeReq(), res);
      expect(captured.status).toBe(404);
      expect(captured.json).toEqual({ error: 'conversation-not-found' });
    },
  );

  it('any other hook failure is not swallowed as a 200', async () => {
    const { bus } = makeBus({ interruptThrows: pluginError('storage-down') });
    const handlers = createChatRouteHandlers({ bus, initCtx });
    const { res } = fakeRes();
    await expect(handlers.postInterrupt(fakeReq(), res)).rejects.toMatchObject({
      code: 'storage-down',
    });
  });
});

describe('POST /api/chat/conversations/:id/interrupt — registration', () => {
  it('is registered as POST /api/chat/conversations/:id/interrupt', async () => {
    const { bus } = makeBus();
    const registered: Array<{ method: string; path: string; handler: unknown }> = [];
    bus.registerService('http:register-route', 'mock-http', async (_ctx, route) => {
      registered.push(route as { method: string; path: string; handler: unknown });
      return { unregister: () => undefined };
    });
    await registerChatRoutes(bus, initCtx);
    const r = registered.find((x) => x.path === '/api/chat/conversations/:id/interrupt');
    expect(r).toBeDefined();
    expect(r!.method).toBe('POST');
    expect(typeof r!.handler).toBe('function');
  });
});
