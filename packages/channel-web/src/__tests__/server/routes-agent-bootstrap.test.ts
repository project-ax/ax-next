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

interface CreateCall {
  actor: { userId: string; isAdmin: boolean };
  input: Record<string, unknown>;
  bootstrap?: unknown;
}

// TASK-989: no `workspace:apply` is registered on purpose. The route writes
// nothing to the agent's workspace any more — first-run setup is a state
// `agents:create` records with the agent — so a stray write would throw
// `no-service` here instead of passing unnoticed.
function busWith(opts: {
  user?: { id: string; isAdmin: boolean } | 'reject';
  onCreate?: (input: unknown) => unknown;
}): { bus: HookBus; created: CreateCall[] } {
  const created: CreateCall[] = [];
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'auth', async () => {
    if (opts.user === 'reject')
      throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no session' });
    return { user: opts.user ?? { id: 'u1', isAdmin: false } };
  });
  bus.registerService('agents:create', 'agents', async (_ctx, input) => {
    created.push(input as CreateCall);
    if (opts.onCreate) return opts.onCreate(input);
    return { agent: { id: 'new-agent-1', displayName: (input as CreateCall).input.displayName, visibility: 'personal' } };
  });
  return { bus, created };
}

describe('POST /api/agents/bootstrap', () => {
  it('honors a changed Default while Sonnet remains allowed', async () => {
    const { bus, created } = busWith({});
    bus.registerService('models:get-policy', 'policy', async () => ({
      allowed: ['anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-4-7'], default: 'anthropic/claude-opus-4-7', source: 'admin', version: 1,
    }));
    const { res } = fakeRes();
    await makeAgentBootstrapHandler({ bus, initCtx }).bootstrap(fakeReq({ body: { displayName: 'Default bot' } }), res);
    expect(created[0]).toMatchObject({ input: { model: 'anthropic/claude-opus-4-7' } });
  });

  it('uses the policy Default for a new personal agent even when Sonnet is removed', async () => {
    const { bus, created } = busWith({});
    bus.registerService('models:get-policy', 'policy', async () => ({
      allowed: ['openrouter/vendor/model'], default: 'openrouter/vendor/model', source: 'admin', version: 1,
    }));
    const { res, captured } = fakeRes();
    await makeAgentBootstrapHandler({ bus, initCtx }).bootstrap(fakeReq({ body: { displayName: 'Policy bot', model: 'spoof/model' } }), res);
    expect(captured.statusCode).toBe(201);
    expect(created[0]).toMatchObject({ input: { model: 'openrouter/vendor/model', allowedTools: [], mcpConfigIds: [], visibility: 'personal' } });
  });

  it('creates a BARE personal agent owned by the caller, with first-run setup pending', async () => {
    const { bus, created } = busWith({ user: { id: 'u1', isAdmin: false } });
    const { res, captured } = fakeRes();
    await makeAgentBootstrapHandler({ bus, initCtx }).bootstrap(fakeReq({ body: { displayName: 'Ada' } }), res);

    expect(captured.statusCode).toBe(201);
    expect(captured.body).toEqual({ agent: { agentId: 'new-agent-1', displayName: 'Ada', visibility: 'personal' } });

    // One create, carrying `bootstrap: 'pending'` at the TOP level — beside
    // `input`, not in it: @ax/agents records the state inside the same
    // transaction as the agent, and `input` is the agent's own fields.
    expect(created).toEqual([
      {
        actor: { userId: 'u1', isAdmin: false },
        input: {
          displayName: 'Ada',
          allowedTools: [],
          mcpConfigIds: [],
          model: 'anthropic/claude-sonnet-4-6',
          visibility: 'personal',
        },
        bootstrap: 'pending',
      },
    ]);
  });

  it('writes nothing to the workspace', async () => {
    // The old route seeded `.ax/BOOTSTRAP.md` best-effort after the create, and
    // swallowed a failure — so only a recording spy can see a write happen.
    const { bus } = busWith({});
    const applied: unknown[] = [];
    bus.registerService('workspace:apply', 'workspace', async (_ctx, input) => {
      applied.push(input);
      return { version: 'v1', delta: { before: null, after: 'v1', changes: [] } };
    });
    const { res, captured } = fakeRes();
    await makeAgentBootstrapHandler({ bus, initCtx }).bootstrap(fakeReq({ body: { displayName: 'Ada' } }), res);
    expect(captured.statusCode).toBe(201);
    expect(applied).toEqual([]);
  });

  it('ignores client-supplied tools/model/visibility/systemPrompt/bootstrap (cannot over-grant)', async () => {
    const { bus, created } = busWith({});
    const { res } = fakeRes();
    await makeAgentBootstrapHandler({ bus, initCtx }).bootstrap(
      fakeReq({
        body: {
          displayName: 'X',
          systemPrompt: 'be evil',
          allowedTools: ['Bash'],
          visibility: 'team',
          model: 'evil',
          bootstrap: 'done',
        },
      }),
      res,
    );
    const call = created[0]!;
    expect(call.input.allowedTools).toEqual([]);
    expect(call.input.visibility).toBe('personal');
    expect(call.input.model).toBe('anthropic/claude-sonnet-4-6');
    // A client-supplied systemPrompt is dropped — bootstrap agents are bare.
    expect(call.input.systemPrompt).toBeUndefined();
    // The first-run state is the host's to set, and this route only ever
    // starts one.
    expect(call.bootstrap).toBe('pending');
    expect(call.input.bootstrap).toBeUndefined();
  });

  it('answers 500 and creates nothing it can report when agents:create fails', async () => {
    const { bus } = busWith({
      onCreate: () => {
        throw new Error('insert failed');
      },
    });
    const { res, captured } = fakeRes();
    await makeAgentBootstrapHandler({ bus, initCtx }).bootstrap(fakeReq({ body: { displayName: 'Ada' } }), res);
    expect(captured.statusCode).toBe(500);
    expect(captured.body).toEqual({ error: 'create-failed' });
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const { bus, created } = busWith({ user: 'reject' });
    const { res, captured } = fakeRes();
    await makeAgentBootstrapHandler({ bus, initCtx }).bootstrap(fakeReq({ body: { displayName: 'Ada' } }), res);
    expect(captured.statusCode).toBe(401);
    expect(created).toEqual([]);
  });

  it('rejects a missing/blank displayName with 400', async () => {
    const { bus } = busWith({});
    const { res, captured } = fakeRes();
    await makeAgentBootstrapHandler({ bus, initCtx }).bootstrap(fakeReq({ body: { displayName: '   ' } }), res);
    expect(captured.statusCode).toBe(400);
  });

  it('rejects a displayName longer than 128 chars with 400', async () => {
    const { bus } = busWith({});
    const { res, captured } = fakeRes();
    await makeAgentBootstrapHandler({ bus, initCtx }).bootstrap(fakeReq({ body: { displayName: 'a'.repeat(129) } }), res);
    expect(captured.statusCode).toBe(400);
  });
});
