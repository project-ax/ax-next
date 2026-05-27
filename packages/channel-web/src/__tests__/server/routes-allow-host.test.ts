import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeAllowHostHandler } from '../../server/routes-allow-host.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

// --- minimal fakes -------------------------------------------------------

function fakeReq(opts: { body?: Buffer } = {}): RouteRequest {
  return {
    headers: {},
    body: opts.body ?? Buffer.alloc(0),
    cookies: {},
    query: {},
    params: {},
    signedCookie: () => null,
  };
}

interface CapturedRes {
  statusCode: number;
  body: unknown;
}

function fakeRes(): { res: RouteResponse; captured: CapturedRes } {
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

const initCtx = makeAgentContext({ sessionId: 'init', agentId: 'test', userId: 'system' });

describe('POST /api/chat/allow-host', () => {
  it('calls proxy:add-host with the AUTHENTICATED user ctx (never the browser-supplied id)', async () => {
    const calls: Array<{ ctx: AgentContext; input: unknown }> = [];
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    bus.registerService('proxy:add-host', 'proxy', async (ctx, input) => {
      calls.push({ ctx, input });
      return { added: true };
    });
    const handler = makeAllowHostHandler({ bus, initCtx });

    const { res, captured } = fakeRes();
    await handler(
      fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'status.example.com' })) }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ added: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ctx.userId).toBe('u1'); // host-side identity, not browser-supplied
    expect(calls[0]?.input).toEqual({ sessionId: 's1', host: 'status.example.com' });
  });

  it('returns 401 when unauthenticated', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => {
      throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no' });
    });
    const handler = makeAllowHostHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handler(
      fakeReq({ body: Buffer.from('{"sessionId":"s1","host":"h"}') }),
      res,
    );
    expect(captured.statusCode).toBe(401);
  });

  it('returns 400 on a malformed body', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    const handler = makeAllowHostHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handler(fakeReq({ body: Buffer.from('not json') }), res);
    expect(captured.statusCode).toBe(400);
  });

  it('maps proxy forbidden → 403 and invalid-host → 400', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    let mode: 'forbidden' | 'invalid-host' = 'forbidden';
    bus.registerService('proxy:add-host', 'proxy', async () => {
      throw new PluginError({ code: mode, plugin: 'proxy', message: mode });
    });
    const handler = makeAllowHostHandler({ bus, initCtx });

    const r1 = fakeRes();
    await handler(
      fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'h.example.com' })) }),
      r1.res,
    );
    expect(r1.captured.statusCode).toBe(403);

    mode = 'invalid-host';
    const r2 = fakeRes();
    await handler(
      fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'h.example.com' })) }),
      r2.res,
    );
    expect(r2.captured.statusCode).toBe(400);
  });

  it('TASK-44: persist:true → calls host-grants:grant with the authed userId + proxy-returned agentId', async () => {
    const grants: unknown[] = [];
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    bus.registerService('proxy:add-host', 'proxy', async () => ({ added: true, agentId: 'agent-7' }));
    bus.registerService('host-grants:grant', 'hg', async (_ctx, input) => {
      grants.push(input);
      return { created: true };
    });
    const handler = makeAllowHostHandler({ bus, initCtx });

    const { res, captured } = fakeRes();
    await handler(
      fakeReq({
        body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'x.example.com', persist: true })),
      }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    // The live-grant response shape is unchanged (agentId never reaches the browser).
    expect(captured.body).toEqual({ added: true });
    // The grant key is server-authoritative: userId from auth, agentId from the proxy.
    expect(grants).toEqual([{ ownerUserId: 'u1', agentId: 'agent-7', host: 'x.example.com' }]);
  });

  it('TASK-44: persist omitted/false → does NOT persist (live grant only, TASK-37 behavior preserved)', async () => {
    const grants: unknown[] = [];
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    bus.registerService('proxy:add-host', 'proxy', async () => ({ added: true, agentId: 'agent-7' }));
    bus.registerService('host-grants:grant', 'hg', async (_ctx, input) => {
      grants.push(input);
      return { created: true };
    });
    const handler = makeAllowHostHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handler(
      fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'x.example.com' })) }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect(grants).toEqual([]);
  });

  it('TASK-44: a host-grants:grant failure does NOT fail the request (live grant already succeeded → 200)', async () => {
    // The live proxy:add-host widen already applied, so the host works for THIS
    // session; a persist failure (e.g. grant-limit at the 256-host cap, or a
    // transient DB blip) is logged + swallowed, never a 500.
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    bus.registerService('proxy:add-host', 'proxy', async () => ({ added: true, agentId: 'agent-7' }));
    bus.registerService('host-grants:grant', 'hg', async () => {
      throw new PluginError({ code: 'grant-limit', plugin: 'hg', message: 'at most 256' });
    });
    const handler = makeAllowHostHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handler(
      fakeReq({
        body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'x.example.com', persist: true })),
      }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ added: true });
  });

  it('TASK-44: persist:true still returns 200 when @ax/host-grants is absent (degrades — no persistence)', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    bus.registerService('proxy:add-host', 'proxy', async () => ({ added: true, agentId: 'agent-7' }));
    // no host-grants:grant registered
    const handler = makeAllowHostHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handler(
      fakeReq({
        body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'x.example.com', persist: true })),
      }),
      res,
    );
    expect(captured.statusCode).toBe(200);
  });
});
