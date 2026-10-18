// @vitest-environment node
/**
 * W3a — a chat may be STARTED in a project (W3 §4.4, §4.8): POST
 * /api/chat/messages and POST /api/chat/conversations carry an optional
 * `projectId` to `conversations:create`, which checks it with
 * `projects:resolve` as the person. These tests pin the route's half: the id
 * is passed through, refused 404 without a leak, and refused 400 beside an
 * existing conversation (a send only sets the project of a chat it creates;
 * moving one is PUT ./project, routes-chat-move.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createChatRouteHandlers, type RouteRequest, type RouteResponse } from '../../server/routes-chat';

function harness(refuse?: 'forbidden' | 'not-found') {
  const bus = new HookBus();
  const calls: Array<{ hook: string; input: unknown }> = [];
  bus.registerService('auth:require-user', 'test', async () => ({ user: { id: 'session-user', isAdmin: false } }));
  bus.registerService('agents:resolve', 'test', async (_c, input) => {
    calls.push({ hook: 'agents:resolve', input });
    return { agent: { id: 'inbox' } };
  });
  bus.registerService('conversations:create', 'test', async (_c, input) => {
    calls.push({ hook: 'conversations:create', input });
    if (refuse !== undefined && (input as { projectId?: string }).projectId !== undefined) {
      throw new PluginError({ code: refuse, plugin: 'test', message: 'conversations:create: not found' });
    }
    return { conversationId: 'cnv-new', agentId: 'inbox' };
  });
  bus.registerService('conversations:get', 'test', async (_c, input) => {
    calls.push({ hook: 'conversations:get', input });
    return { conversation: { conversationId: 'cnv-old', agentId: 'inbox', activeSessionId: null }, turns: [] };
  });
  bus.registerService('conversations:bind-session', 'test', async () => ({}));
  bus.registerService('agent:invoke', 'test', async () => ({}));
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
  const req = (body: unknown): RouteRequest =>
    ({
      params: {},
      query: {},
      body: Buffer.from(JSON.stringify(body)),
      headers: {},
      cookies: {},
      signedCookie: () => null,
    }) as RouteRequest;
  return { handlers: createChatRouteHandlers({ bus, initCtx: ctx }), calls, result, req, res };
}

const text = [{ type: 'text', text: 'hello' }];

describe('POST /api/chat/messages — projectId (W3a)', () => {
  it('passes projectId to conversations:create for a new chat', async () => {
    const h = harness();
    await h.handlers.postMessage(h.req({ conversationId: null, agentId: 'inbox', contentBlocks: text, projectId: 'prj_1' }), h.res);
    expect(h.result.status).toBe(202);
    expect(h.calls.find((c) => c.hook === 'conversations:create')?.input).toEqual({
      userId: 'session-user',
      agentId: 'inbox',
      origin: 'web',
      projectId: 'prj_1',
    });
  });

  it('without projectId the create payload is unchanged (no projectId key)', async () => {
    const h = harness();
    await h.handlers.postMessage(h.req({ conversationId: null, agentId: 'inbox', contentBlocks: text }), h.res);
    expect(h.calls.find((c) => c.hook === 'conversations:create')?.input).toEqual({
      userId: 'session-user',
      agentId: 'inbox',
      origin: 'web',
    });
  });

  it('projectId beside an existing conversation is a 400, before any hook', async () => {
    const h = harness();
    await h.handlers.postMessage(
      h.req({ conversationId: 'cnv-old', agentId: 'inbox', contentBlocks: text, projectId: 'prj_1' }),
      h.res,
    );
    expect(h.result).toEqual({ status: 400, body: { error: 'project-on-existing-conversation' } });
    expect(h.calls).toEqual([]);
  });

  it.each(['forbidden', 'not-found'] as const)('a %s project refusal is one 404, nothing dispatched', async (code) => {
    const h = harness(code);
    await h.handlers.postMessage(h.req({ conversationId: null, agentId: 'inbox', contentBlocks: text, projectId: 'prj_x' }), h.res);
    expect(h.result).toEqual({ status: 404, body: { error: 'project-not-found' } });
  });

  it.each([[''], ['p'.repeat(129)], [42]])('a malformed projectId (%j) is a 400', async (projectId) => {
    const h = harness();
    await h.handlers.postMessage(h.req({ conversationId: null, agentId: 'inbox', contentBlocks: text, projectId }), h.res);
    expect(h.result.status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});

describe('POST /api/chat/conversations — projectId (W3a)', () => {
  it('passes projectId through and answers 201', async () => {
    const h = harness();
    await h.handlers.createConversation(h.req({ agentId: 'inbox', projectId: 'prj_1' }), h.res);
    expect(h.result).toEqual({ status: 201, body: { conversationId: 'cnv-new' } });
    expect(h.calls).toEqual([
      { hook: 'conversations:create', input: { userId: 'session-user', agentId: 'inbox', origin: 'web', projectId: 'prj_1' } },
    ]);
  });

  it.each(['forbidden', 'not-found'] as const)('a %s project refusal is a 404', async (code) => {
    const h = harness(code);
    await h.handlers.createConversation(h.req({ agentId: 'inbox', projectId: 'prj_x' }), h.res);
    expect(h.result).toEqual({ status: 404, body: { error: 'project-not-found' } });
  });
});
