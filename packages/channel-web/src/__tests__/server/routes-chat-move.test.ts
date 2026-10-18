// @vitest-environment node
/**
 * W3e (W3 spec §8) — PUT /api/chat/conversations/:id/project moves a chat
 * into a project, to another one, or out. The hook (`conversations:set-project`)
 * owns every rule; these tests pin the route's half: the session user is the
 * actor, the body is strict, and each refusal lands on its own status without
 * leaking whether someone else's chat exists.
 *
 * The stub hook throws exactly what `@ax/conversations` throws: its own
 * PluginError, with the projects:resolve / agents:resolve refusal as `cause`
 * when one of those gates said no.
 */
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import {
  createChatRouteHandlers,
  registerChatRoutes,
  type RouteRequest,
  type RouteResponse,
} from '../../server/routes-chat';

type Refusal =
  | 'chat-not-found'
  | 'routine'
  | 'agent-forbidden'
  | 'agent-not-found'
  | 'project-forbidden'
  | 'project-not-found'
  | 'projects-unavailable'
  | 'invalid-payload'
  | 'fault';

const conversationsError = (code: string, message: string, cause?: unknown) =>
  new PluginError({ code, plugin: '@ax/conversations', hookName: 'conversations:set-project', message, ...(cause !== undefined ? { cause } : {}) });

function refusalFor(refusal: Refusal): Error {
  switch (refusal) {
    case 'chat-not-found':
      return conversationsError('not-found', "conversation 'c' not found");
    case 'routine':
      return conversationsError('forbidden', "a routine's chat can't be moved");
    case 'agent-forbidden':
    case 'agent-not-found': {
      const code = refusal === 'agent-forbidden' ? 'forbidden' : 'not-found';
      return conversationsError(code, 'agent', new PluginError({ code, plugin: '@ax/agents', hookName: 'agents:resolve', message: 'agent' }));
    }
    case 'project-forbidden':
    case 'project-not-found': {
      const code = refusal === 'project-forbidden' ? 'forbidden' : 'not-found';
      return conversationsError(code, 'project', new PluginError({ code, plugin: '@ax/projects', hookName: 'projects:resolve', message: 'projects:resolve: not found' }));
    }
    case 'projects-unavailable':
      return conversationsError('forbidden', 'projects are not available');
    case 'invalid-payload':
      return conversationsError('invalid-payload', 'projectId must be a project id or null');
    case 'fault':
      return new Error('db down');
  }
}

function harness(opts: { refusal?: Refusal; auth?: false; projectsLoaded?: boolean } = {}) {
  const bus = new HookBus();
  const calls: Array<{ hook: string; input: unknown }> = [];
  bus.registerService('auth:require-user', 'test', async () => {
    if (opts.auth === false) throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'No session' });
    return { user: { id: 'session-user', isAdmin: false } };
  });
  if (opts.projectsLoaded !== false) {
    bus.registerService('projects:resolve', 'projects', async () => ({ folderId: 'never-read' }));
  }
  bus.registerService('conversations:set-project', 'test', async (_c, input) => {
    calls.push({ hook: 'conversations:set-project', input });
    if (opts.refusal !== undefined) throw refusalFor(opts.refusal);
    return { projectId: (input as { projectId: string | null }).projectId };
  });
  const ctx = makeAgentContext({ agentId: 'host', userId: 'host', sessionId: 'host' });
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
  const req = (body: unknown, id = 'cnv-1', raw?: string): RouteRequest =>
    ({
      params: { id },
      query: {},
      body: Buffer.from(raw ?? JSON.stringify(body)),
      headers: {},
      cookies: {},
      signedCookie: () => null,
    }) as RouteRequest;
  return { bus, ctx, handlers: createChatRouteHandlers({ bus, initCtx: ctx }), calls, result, req, res };
}

describe('PUT /api/chat/conversations/:id/project (W3e)', () => {
  it('moves a chat into a project as the session user and answers { projectId }', async () => {
    const h = harness();
    await h.handlers.setConversationProject(h.req({ projectId: 'prj_1' }), h.res);
    expect(h.result).toEqual({ status: 200, body: { projectId: 'prj_1' } });
    expect(h.calls).toEqual([
      { hook: 'conversations:set-project', input: { conversationId: 'cnv-1', userId: 'session-user', projectId: 'prj_1' } },
    ]);
  });

  it('moves a chat out with projectId null', async () => {
    const h = harness();
    await h.handlers.setConversationProject(h.req({ projectId: null }), h.res);
    expect(h.result).toEqual({ status: 200, body: { projectId: null } });
    expect(h.calls[0]!.input).toEqual({ conversationId: 'cnv-1', userId: 'session-user', projectId: null });
  });

  it('401 for an unsigned caller, before the hook', async () => {
    const h = harness({ auth: false });
    await h.handlers.setConversationProject(h.req({ projectId: 'prj_1' }), h.res);
    expect(h.result.status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['missing projectId', {}],
    ['a userId beside it (strict)', { projectId: 'prj_1', userId: 'someone-else' }],
    ['an empty id', { projectId: '' }],
    ['an over-long id', { projectId: 'p'.repeat(129) }],
    ['a number', { projectId: 42 }],
  ])('400 for %s, before the hook', async (_name, body) => {
    const h = harness();
    await h.handlers.setConversationProject(h.req(body), h.res);
    expect(h.result).toEqual({ status: 400, body: { error: 'invalid-payload' } });
    expect(h.calls).toEqual([]);
  });

  it('400 for malformed JSON, before the hook', async () => {
    const h = harness();
    await h.handlers.setConversationProject(h.req(undefined, 'cnv-1', '{nope'), h.res);
    expect(h.result).toEqual({ status: 400, body: { error: 'invalid-payload' } });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['a foreign, missing or deleted chat', 'chat-not-found'],
    ['an agent the person can no longer use (forbidden)', 'agent-forbidden'],
    ['an agent that is gone (not-found)', 'agent-not-found'],
  ] as const)('%s is one 404 conversation-not-found', async (_name, refusal) => {
    const h = harness({ refusal });
    await h.handlers.setConversationProject(h.req({ projectId: 'prj_1' }), h.res);
    expect(h.result).toEqual({ status: 404, body: { error: 'conversation-not-found' } });
  });

  it.each(['project-forbidden', 'project-not-found'] as const)(
    'a %s refusal from projects:resolve is one 404 project-not-found',
    async (refusal) => {
      const h = harness({ refusal });
      await h.handlers.setConversationProject(h.req({ projectId: 'prj_x' }), h.res);
      expect(h.result).toEqual({ status: 404, body: { error: 'project-not-found' } });
    },
  );

  it("a routine's chat is a 409 cannot-move-routine-chat", async () => {
    const h = harness({ refusal: 'routine' });
    await h.handlers.setConversationProject(h.req({ projectId: 'prj_1' }), h.res);
    expect(h.result).toEqual({ status: 409, body: { error: 'cannot-move-routine-chat' } });
  });

  it('moving out of a routine chat is still the routine 409 (projects not needed to move out)', async () => {
    const h = harness({ refusal: 'routine', projectsLoaded: false });
    await h.handlers.setConversationProject(h.req({ projectId: null }), h.res);
    expect(h.result).toEqual({ status: 409, body: { error: 'cannot-move-routine-chat' } });
  });

  it('into a project without @ax/projects is a 503 projects-unavailable', async () => {
    const h = harness({ refusal: 'projects-unavailable', projectsLoaded: false });
    await h.handlers.setConversationProject(h.req({ projectId: 'prj_1' }), h.res);
    expect(h.result).toEqual({ status: 503, body: { error: 'projects-unavailable' } });
  });

  it("the hook's invalid-payload is a 400", async () => {
    const h = harness({ refusal: 'invalid-payload' });
    await h.handlers.setConversationProject(h.req({ projectId: 'prj_1' }), h.res);
    expect(h.result).toEqual({ status: 400, body: { error: 'invalid-payload' } });
  });

  it('a real fault is not dressed up as a refusal', async () => {
    const h = harness({ refusal: 'fault' });
    await expect(h.handlers.setConversationProject(h.req({ projectId: 'prj_1' }), h.res)).rejects.toThrow();
  });

  it('registers PUT /api/chat/conversations/:id/project on the CSRF-gated server (no skipCsrf)', async () => {
    const h = harness();
    const routes: Array<Record<string, unknown>> = [];
    h.bus.registerService('http:register-route', 'http', async (_ctx, input) => {
      routes.push(input as Record<string, unknown>);
      return { unregister() {} };
    });
    await registerChatRoutes(h.bus, h.ctx);
    const route = routes.find((r) => r.method === 'PUT' && r.path === '/api/chat/conversations/:id/project');
    expect(route).toBeDefined();
    expect(route!.skipCsrf).toBeUndefined();
  });
});
