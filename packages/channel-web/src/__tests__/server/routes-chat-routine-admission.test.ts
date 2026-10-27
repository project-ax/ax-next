// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import {
  createChatRouteHandlers,
  type RouteRequest,
  type RouteResponse,
} from '../../server/routes-chat';

const initCtx = makeAgentContext({
  sessionId: 'init', agentId: '@ax/channel-web', userId: 'system',
});

function fixture(options: {
  origin?: unknown;
  missingOrigin?: boolean;
  active?: boolean;
  getError?: PluginError;
} = {}) {
  const calls = { attachments: [] as unknown[], binds: [] as unknown[], invokes: [] as unknown[] };
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'test-auth', async () => ({
    user: { id: 'owner', isAdmin: false },
  }));
  bus.registerService('agents:resolve', 'test-agents', async (_ctx, input) => ({
    agent: { id: (input as { agentId: string }).agentId },
  }));
  bus.registerService('conversations:get', 'test-conversations', async (_ctx, input) => {
    expect(input).toEqual({ conversationId: 'conversation', userId: 'owner' });
    if (options.getError) throw options.getError;
    return {
      conversation: {
        conversationId: 'conversation', userId: 'owner', agentId: 'agent',
        ...(options.missingOrigin ? {} : {
          origin: Object.hasOwn(options, 'origin') ? options.origin : 'web',
        }),
        title: null,
        activeSessionId: options.active ? 'live-session' : null,
        activeReqId: options.active ? 'live-request' : null,
        createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z',
      },
      turns: [],
    };
  });
  bus.registerService('conversations:bind-session', 'test-conversations', async (_ctx, input) => {
    calls.binds.push(input);
  });
  bus.registerService('attachments:commit', 'test-attachments', async (_ctx, input) => {
    calls.attachments.push(input);
    return {
      path: '.ax/uploads/conversation/turn/safe.txt', displayName: 'safe.txt',
      sizeBytes: 12, mediaType: 'text/plain', sha256: 'test-sha',
    };
  });
  bus.registerService('agent:invoke', 'test-orchestrator', async (ctx: AgentContext, input) => {
    calls.invokes.push({ ctx, input });
  });
  return { calls, handlers: createChatRouteHandlers({ bus, initCtx }) };
}

function request(extra: Record<string, unknown> = {}, query: Record<string, string> = {}): RouteRequest {
  return {
    headers: {}, cookies: {}, query, params: {}, signedCookie() { return null; },
    body: Buffer.from(JSON.stringify({
      conversationId: 'conversation', agentId: 'agent',
      contentBlocks: [{ type: 'text', text: 'Continue with these new instructions.' }],
      ...extra,
    })),
  };
}

function response() {
  const value: { status?: number; json?: unknown } = {};
  const res: RouteResponse = {
    status(status) { value.status = status; return res; },
    json(json) { value.json = json; },
    text() {}, end() {},
  };
  return { value, res };
}

describe('interactive chat admission uses stored conversation origin', () => {
  it.each([false, true])('keeps an ordinary existing web conversation writable (active=%s)', async (active) => {
    const { handlers, calls } = fixture({ origin: 'web', active });
    const { res, value } = response();
    await handlers.postMessage(request({ origin: 'routine', source: 'routine' }), res);

    expect(value.status).toBe(202);
    expect(value.json).toMatchObject({ conversationId: 'conversation', reqId: expect.any(String) });
    expect(calls.binds).toHaveLength(1);
    expect(calls.invokes).toHaveLength(1);
  });

  it.each([false, true])('refuses user content in a routine conversation (active=%s) without writes', async (active) => {
    const { handlers, calls } = fixture({ origin: 'routine', active });
    const { res, value } = response();
    await handlers.postMessage(request(), res);

    expect(value).toEqual({ status: 404, json: { error: 'conversation-not-found' } });
    expect(calls).toEqual({ attachments: [], binds: [], invokes: [] });
  });

  it('retains attachment commit and dispatch for an ordinary web conversation', async () => {
    const { handlers, calls } = fixture({ origin: 'web' });
    const { res, value } = response();
    await handlers.postMessage(request({
      contentBlocks: [{ type: 'attachment_ref', attachmentId: 'attachment' }],
    }), res);

    expect(value.status).toBe(202);
    expect(calls.attachments).toHaveLength(1);
    expect(calls.binds).toHaveLength(1);
    expect(calls.invokes).toHaveLength(1);
  });

  it('ignores forged origin/source/user fields instead of turning a routine run into an attended chat', async () => {
    const { handlers, calls } = fixture({ origin: 'routine', active: true });
    const { res, value } = response();
    await handlers.postMessage(request({
      origin: 'web', source: 'web', userId: 'owner', allowRoutine: true,
    }, { origin: 'web', source: 'web' }), res);

    expect(value).toEqual({ status: 404, json: { error: 'conversation-not-found' } });
    expect(calls).toEqual({ attachments: [], binds: [], invokes: [] });
  });

  it('refuses before committing an attachment into the routine context', async () => {
    const { handlers, calls } = fixture({ origin: 'routine' });
    const { res, value } = response();
    await handlers.postMessage(request({
      contentBlocks: [{ type: 'attachment_ref', attachmentId: 'attachment' }],
    }), res);

    expect(value).toEqual({ status: 404, json: { error: 'conversation-not-found' } });
    expect(calls).toEqual({ attachments: [], binds: [], invokes: [] });
  });

  it('keeps routine refusal unchanged for another reachable requested agent', async () => {
    const { handlers, calls } = fixture({ origin: 'routine' });
    const { res, value } = response();
    await handlers.postMessage(request({ agentId: 'other-reachable-agent' }), res);

    expect(value).toEqual({ status: 404, json: { error: 'conversation-not-found' } });
    expect(calls).toEqual({ attachments: [], binds: [], invokes: [] });
  });

  it('retains the ordinary web agent mismatch response', async () => {
    const { handlers, calls } = fixture({ origin: 'web' });
    const { res, value } = response();
    await handlers.postMessage(request({ agentId: 'other-reachable-agent' }), res);

    expect(value).toEqual({ status: 400, json: { error: 'agent-mismatch' } });
    expect(calls).toEqual({ attachments: [], binds: [], invokes: [] });
  });

  it.each([undefined, null, 'unknown', {}, ['web']])('fails closed for malformed stored origin %j', async (origin) => {
    const { handlers, calls } = fixture({ origin });
    const { res, value } = response();
    await handlers.postMessage(request(), res);

    expect(value).toEqual({ status: 404, json: { error: 'conversation-not-found' } });
    expect(calls).toEqual({ attachments: [], binds: [], invokes: [] });
  });

  it('fails closed when a peer omits the required stored origin', async () => {
    const { handlers, calls } = fixture({ missingOrigin: true });
    const { res, value } = response();
    await handlers.postMessage(request(), res);

    expect(value).toEqual({ status: 404, json: { error: 'conversation-not-found' } });
    expect(calls).toEqual({ attachments: [], binds: [], invokes: [] });
  });

  it.each(['forbidden', 'not-found'])('keeps the existing nonrevealing %s projection', async (code) => {
    const { handlers, calls } = fixture({
      getError: new PluginError({ code, plugin: 'test-conversations', message: code }),
    });
    const { res, value } = response();
    await handlers.postMessage(request(), res);

    expect(value).toEqual({ status: 404, json: { error: 'conversation-not-found' } });
    expect(calls).toEqual({ attachments: [], binds: [], invokes: [] });
  });

  it('does not turn a conversation read failure into a hidden denial', async () => {
    const { handlers, calls } = fixture({
      getError: new PluginError({ code: 'unavailable', plugin: 'test-conversations', message: 'store down' }),
    });
    const { res } = response();
    await expect(handlers.postMessage(request(), res)).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toEqual({ attachments: [], binds: [], invokes: [] });
  });
});
