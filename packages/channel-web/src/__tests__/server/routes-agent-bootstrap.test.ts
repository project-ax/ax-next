import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeAgentBootstrapHandler } from '../../server/routes-agent-bootstrap.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

function fakeReq(opts: { body?: unknown } = {}): RouteRequest {
  const buf =
    opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body), 'utf8');
  return { headers: {}, body: buf, cookies: {}, query: {}, params: {}, signedCookie: () => null };
}
function fakeRes(): { res: RouteResponse; captured: { statusCode: number; body: unknown } } {
  const captured = { statusCode: 0, body: undefined as unknown };
  const res: RouteResponse = {
    status(n) { captured.statusCode = n; return res; },
    json(v) { captured.body = v; },
    text() {}, end() {},
  };
  return { res, captured };
}
const initCtx: AgentContext = makeAgentContext({ sessionId: 'init', agentId: 'test', userId: 'system' });

function busWith(opts: {
  user?: { id: string; isAdmin: boolean } | 'reject';
  onCreate?: (input: unknown) => unknown;
}): { bus: HookBus; created: Array<{ ctx: AgentContext; input: unknown }> } {
  const created: Array<{ ctx: AgentContext; input: unknown }> = [];
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'auth', async () => {
    if (opts.user === 'reject')
      throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no session' });
    return { user: opts.user ?? { id: 'u1', isAdmin: false } };
  });
  bus.registerService('agents:create', 'agents', async (ctx, input) => {
    created.push({ ctx, input });
    if (opts.onCreate) return opts.onCreate(input);
    return { agent: { id: 'new-agent-1', displayName: (input as { input: { displayName: string } }).input.displayName, visibility: 'personal' } };
  });
  return { bus, created };
}

describe('POST /api/agents/bootstrap', () => {
  it('creates a personal wildcard agent owned by the caller and returns 201', async () => {
    const { bus, created } = busWith({ user: { id: 'u1', isAdmin: false } });
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: 'Ada', systemPrompt: 'You are Ada.' } }), res);
    expect(captured.statusCode).toBe(201);
    expect(captured.body).toEqual({ agent: { agentId: 'new-agent-1', displayName: 'Ada', visibility: 'personal' } });
    expect(created).toHaveLength(1);
    const input = created[0]!.input as { actor: { userId: string }; input: Record<string, unknown> };
    expect(input.actor.userId).toBe('u1');
    expect(input.input.visibility).toBe('personal');
    expect(input.input.allowedTools).toEqual([]);
    expect(input.input.mcpConfigIds).toEqual([]);
    expect(input.input.model).toBe('claude-sonnet-4-6');
  });

  it('ignores client-supplied tools/model/visibility (cannot over-grant)', async () => {
    const { bus, created } = busWith({});
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res } = fakeRes();
    await h.bootstrap(
      fakeReq({ body: { displayName: 'X', systemPrompt: '', allowedTools: ['Bash'], visibility: 'team', model: 'evil' } }),
      res,
    );
    const input = created[0]!.input as { input: Record<string, unknown> };
    expect(input.input.allowedTools).toEqual([]);
    expect(input.input.visibility).toBe('personal');
    expect(input.input.model).toBe('claude-sonnet-4-6');
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const { bus } = busWith({ user: 'reject' });
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: 'Ada', systemPrompt: '' } }), res);
    expect(captured.statusCode).toBe(401);
  });

  it('rejects a missing/blank displayName with 400', async () => {
    const { bus } = busWith({});
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: '   ', systemPrompt: '' } }), res);
    expect(captured.statusCode).toBe(400);
  });

  it('rejects a displayName longer than 128 chars with 400', async () => {
    const { bus } = busWith({});
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: 'a'.repeat(129), systemPrompt: '' } }), res);
    expect(captured.statusCode).toBe(400);
  });
});
