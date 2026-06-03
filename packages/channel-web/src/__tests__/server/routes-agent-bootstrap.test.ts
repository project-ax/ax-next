import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { BOOTSTRAP_TEMPLATE } from '@ax/agent-identity-templates';
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

interface Applied { ctx: AgentContext; input: { changes: Array<{ path: string; kind: string; content?: Uint8Array }>; parent: unknown } }

function busWith(opts: {
  user?: { id: string; isAdmin: boolean } | 'reject';
  onCreate?: (input: unknown) => unknown;
  seedThrows?: boolean;
}): {
  bus: HookBus;
  created: Array<{ ctx: AgentContext; input: unknown }>;
  applies: Applied[];
} {
  const created: Array<{ ctx: AgentContext; input: unknown }> = [];
  const applies: Applied[] = [];
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
  bus.registerService('workspace:apply', 'workspace', async (ctx, input) => {
    if (opts.seedThrows) throw new Error('seed boom');
    applies.push({ ctx, input: input as Applied['input'] });
    return { version: 'v1', delta: { before: null, after: 'v1', changes: [] } };
  });
  return { bus, created, applies };
}

describe('POST /api/agents/bootstrap', () => {
  it('creates a BARE personal agent owned by the caller and seeds .ax/BOOTSTRAP.md', async () => {
    const { bus, created, applies } = busWith({ user: { id: 'u1', isAdmin: false } });
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: 'Ada' } }), res);

    expect(captured.statusCode).toBe(201);
    expect(captured.body).toEqual({ agent: { agentId: 'new-agent-1', displayName: 'Ada', visibility: 'personal' } });

    // BARE create — no systemPrompt sent; capability profile fixed server-side.
    expect(created).toHaveLength(1);
    const input = created[0]!.input as { actor: { userId: string }; input: Record<string, unknown> };
    expect(input.actor.userId).toBe('u1');
    expect(input.input.systemPrompt).toBeUndefined();
    expect(input.input.visibility).toBe('personal');
    expect(input.input.allowedTools).toEqual([]);
    expect(input.input.mcpConfigIds).toEqual([]);
    expect(input.input.model).toBe('claude-sonnet-4-6');

    // Seed BOOTSTRAP.md routed to the NEW agent's workspace (parent: null —
    // first apply creates main).
    expect(applies).toHaveLength(1);
    expect(applies[0]!.ctx.agentId).toBe('new-agent-1');
    expect(applies[0]!.ctx.userId).toBe('u1');
    expect(applies[0]!.input.parent).toBeNull();
    const change = applies[0]!.input.changes[0]!;
    expect(change.path).toBe('.ax/BOOTSTRAP.md');
    expect(change.kind).toBe('put');
    expect(new TextDecoder().decode(change.content!)).toBe(BOOTSTRAP_TEMPLATE);
  });

  it('ignores client-supplied tools/model/visibility/systemPrompt (cannot over-grant)', async () => {
    const { bus, created } = busWith({});
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res } = fakeRes();
    await h.bootstrap(
      fakeReq({ body: { displayName: 'X', systemPrompt: 'be evil', allowedTools: ['Bash'], visibility: 'team', model: 'evil' } }),
      res,
    );
    const input = created[0]!.input as { input: Record<string, unknown> };
    expect(input.input.allowedTools).toEqual([]);
    expect(input.input.visibility).toBe('personal');
    expect(input.input.model).toBe('claude-sonnet-4-6');
    // A client-supplied systemPrompt is dropped — bootstrap agents are bare.
    expect(input.input.systemPrompt).toBeUndefined();
  });

  it('returns 201 even when seeding BOOTSTRAP.md fails (the agent already exists)', async () => {
    const { bus, created } = busWith({ user: { id: 'u1', isAdmin: false }, seedThrows: true });
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: 'Ada' } }), res);
    // The agent was created; a seed failure must not 500 after a successful
    // create (the runner string-fallback covers the gap until a later apply).
    expect(created).toHaveLength(1);
    expect(captured.statusCode).toBe(201);
    expect(captured.body).toEqual({ agent: { agentId: 'new-agent-1', displayName: 'Ada', visibility: 'personal' } });
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const { bus } = busWith({ user: 'reject' });
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: 'Ada' } }), res);
    expect(captured.statusCode).toBe(401);
  });

  it('rejects a missing/blank displayName with 400', async () => {
    const { bus } = busWith({});
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: '   ' } }), res);
    expect(captured.statusCode).toBe(400);
  });

  it('rejects a displayName longer than 128 chars with 400', async () => {
    const { bus } = busWith({});
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: 'a'.repeat(129) } }), res);
    expect(captured.statusCode).toBe(400);
  });
});
