// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import {
  createChatRouteHandlers,
  registerChatRoutes,
  type RouteRequest,
  type RouteResponse,
} from '../../server/routes-chat';

function harness(failure?: 'auth' | 'forbidden' | 'not-found') {
  const bus = new HookBus();
  const calls: unknown[] = [];
  bus.registerService('auth:require-user', 'test', async () => {
    if (failure === 'auth')
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'test',
        message: 'No session',
      });
    return { user: { id: 'session-user' } };
  });
  for (const hook of ['conversations:create', 'conversations:set-title']) {
    bus.registerService(hook, 'test', async (_ctx, input) => {
      calls.push({ hook, input });
      if (failure === 'forbidden' || failure === 'not-found')
        throw new PluginError({
          code: failure,
          plugin: 'test',
          message: 'Unavailable',
        });
      return { conversationId: 'new-conversation', updated: true };
    });
  }
  const ctx = makeAgentContext({
    agentId: 'host',
    userId: 'host',
    sessionId: 'host',
  });
  const result = { status: 0, body: undefined as unknown };
  const res = {
    status(n: number) {
      result.status = n;
      return this;
    },
    json(body: unknown) {
      result.body = body;
    },
    end() {},
  } as unknown as RouteResponse;
  const req = (body: unknown): RouteRequest =>
    ({
      params: { id: 'conversation' },
      query: {},
      body: Buffer.from(JSON.stringify(body)),
      headers: {},
      cookies: {},
      signedCookie: () => null,
    }) as RouteRequest;
  return {
    bus,
    ctx,
    handlers: createChatRouteHandlers({ bus, initCtx: ctx }),
    calls,
    result,
    req,
    res,
  };
}

describe('conversation controls', () => {
  it('creates an attended web conversation using the session owner', async () => {
    const h = harness();
    await h.handlers.createConversation(
      h.req({ agentId: 'inbox', userId: 'foreign' }),
      h.res,
    );
    expect(h.result).toEqual({
      status: 201,
      body: { conversationId: 'new-conversation' },
    });
    expect(h.calls).toEqual([
      {
        hook: 'conversations:create',
        input: { agentId: 'inbox', userId: 'session-user', origin: 'web' },
      },
    ]);
  });
  it('renames through the existing title hook, trimming the input', async () => {
    const h = harness();
    await h.handlers.renameConversation(
      h.req({ title: '  A useful name  ', userId: 'foreign' }),
      h.res,
    );
    expect(h.result.status).toBe(204);
    expect(h.calls).toEqual([
      {
        hook: 'conversations:set-title',
        input: {
          conversationId: 'conversation',
          userId: 'session-user',
          title: 'A useful name',
        },
      },
    ]);
  });
  it.each(['createConversation', 'renameConversation'] as const)(
    '%s refuses an unsigned caller',
    async (method) => {
      const h = harness('auth');
      await h.handlers[method](
        h.req({ agentId: 'inbox', title: 'Name' }),
        h.res,
      );
      expect(h.result.status).toBe(401);
      expect(h.calls).toEqual([]);
    },
  );
  it.each(['forbidden', 'not-found'] as const)(
    'hides %s conversation existence',
    async (failure) => {
      const h = harness(failure);
      await h.handlers.renameConversation(h.req({ title: 'Name' }), h.res);
      expect(h.result).toEqual({
        status: 404,
        body: { error: 'conversation-not-found' },
      });
    },
  );
  it.each(['forbidden', 'not-found'] as const)(
    'does not create a conversation for an unreachable agent: %s',
    async (failure) => {
      const h = harness(failure);
      await h.handlers.createConversation(
        h.req({ agentId: 'foreign-agent' }),
        h.res,
      );
      expect(h.result).toEqual({
        status: 404,
        body: { error: 'agent-not-found' },
      });
    },
  );
  it.each(['', 'a'.repeat(257), null, 42])(
    'rejects invalid agent id %j before calling the hook',
    async (agentId) => {
      const h = harness();
      await h.handlers.createConversation(h.req({ agentId }), h.res);
      expect(h.result.status).toBe(400);
      expect(h.calls).toEqual([]);
    },
  );
  it.each(['', ' ', 'a'.repeat(257), 42])(
    'rejects invalid rename title %j before calling the hook',
    async (title) => {
      const h = harness();
      await h.handlers.renameConversation(h.req({ title }), h.res);
      expect(h.result.status).toBe(400);
      expect(h.calls).toEqual([]);
    },
  );
  it('registers both handlers on the authenticated, CSRF-gated HTTP server', async () => {
    const h = harness();
    const routes: unknown[] = [];
    h.bus.registerService(
      'http:register-route',
      'http',
      async (_ctx, input) => {
        routes.push(input);
        return { unregister() {} };
      },
    );
    await registerChatRoutes(h.bus, h.ctx);
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'POST',
          path: '/api/chat/conversations',
        }),
        expect.objectContaining({
          method: 'PATCH',
          path: '/api/chat/conversations/:id',
        }),
      ]),
    );
  });
});
