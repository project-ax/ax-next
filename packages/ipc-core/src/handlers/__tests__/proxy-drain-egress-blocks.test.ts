import { describe, it, expect, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { proxyDrainEgressBlocksHandler } from '../proxy-drain-egress-blocks.js';

// ---------------------------------------------------------------------------
// proxy.drain-egress-blocks handler — the agent→host IPC adapter for the
// `proxy:drain-session-egress-blocks` service hook. Thin glue: validate the
// EMPTY request, guard hasService (the single-session CLI has no proxy), call
// the hook with ctx (sessionId is bearer-bound on ctx — never a body field),
// validate the response, return.
// ---------------------------------------------------------------------------

function fakeBus(opts: {
  hasService?: boolean;
  drainImpl?: (ctx: unknown) => Promise<unknown>;
}) {
  const drainImpl =
    opts.drainImpl ?? (async () => ({ hosts: ['github.com'] }));
  return {
    call: vi.fn(async (hook: string, ctx: unknown, _payload: unknown) => {
      if (hook === 'proxy:drain-session-egress-blocks') return drainImpl(ctx);
      throw new Error(`unexpected hook ${hook}`);
    }),
    hasService: vi.fn((hook: string) =>
      hook === 'proxy:drain-session-egress-blocks' ? opts.hasService ?? true : false,
    ),
    registerService: vi.fn(),
    subscribe: vi.fn(),
    fire: vi.fn(),
  };
}

function fakeCtx(sessionId = 's1') {
  return {
    sessionId,
    agentId: 'a1',
    userId: 'u1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

describe('proxy.drain-egress-blocks handler', () => {
  it('returns the hosts the hook drained, passing ctx (NOT a body field) to the hook', async () => {
    const bus = fakeBus({ drainImpl: async () => ({ hosts: ['github.com', 'release-assets.githubusercontent.com'] }) });
    const ctx = fakeCtx('s1');
    const result = await proxyDrainEgressBlocksHandler({}, ctx, bus as never);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      hosts: ['github.com', 'release-assets.githubusercontent.com'],
    });
    // The hook is called with the bearer-bound ctx (which carries sessionId).
    expect(bus.call).toHaveBeenCalledWith(
      'proxy:drain-session-egress-blocks',
      ctx,
      {},
    );
  });

  it('degrades to { hosts: [] } WITHOUT calling the hook when no egress proxy is loaded (CLI)', async () => {
    const bus = fakeBus({ hasService: false });
    const result = await proxyDrainEgressBlocksHandler({}, fakeCtx(), bus as never);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ hosts: [] });
    expect(bus.call).not.toHaveBeenCalled();
  });

  it('rejects a NON-empty body (no sessionId smuggling) before dispatch', async () => {
    const bus = fakeBus({});
    // An agent trying to drain another session by passing a sessionId must be
    // rejected at the schema layer — ctx.sessionId is the only session source.
    const result = await proxyDrainEgressBlocksHandler(
      { sessionId: 'someone-else' },
      fakeCtx(),
      bus as never,
    );
    expect(result.status).not.toBe(200);
    expect(bus.call).not.toHaveBeenCalled();
  });

  it('maps a hook throw to an error envelope (never leaks a stack)', async () => {
    const bus = fakeBus({
      drainImpl: async () => {
        throw new PluginError({ code: 'boom', plugin: '@ax/credential-proxy', message: 'kaboom' });
      },
    });
    const result = await proxyDrainEgressBlocksHandler({}, fakeCtx(), bus as never);
    expect(result.status).not.toBe(200);
  });
});
