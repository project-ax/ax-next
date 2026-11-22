import { describe, it, expect, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { proxyDrainAllowedHostsHandler } from '../proxy-drain-allowed-hosts.js';
import type { HandlerResult } from '../types.js';

// ---------------------------------------------------------------------------
// proxy.drain-allowed-hosts handler (TASK-1199) — the runner→host IPC adapter
// for the `proxy:drain-session-allowed-hosts` service hook. The runner calls
// it at the start of each person's turn to learn which hosts a person allowed
// since the last turn. Thin glue: validate the EMPTY request, guard hasService
// (the single-session CLI has no proxy), call the hook with ctx (sessionId is
// bearer-bound on ctx, never a body field), validate the response, return.
// ---------------------------------------------------------------------------

const HOOK = 'proxy:drain-session-allowed-hosts';

/** The JSON body of a non-binary result (this action never answers binary). */
function bodyOf(result: HandlerResult): unknown {
  return 'body' in result ? result.body : undefined;
}

function fakeBus(opts: {
  hasService?: boolean;
  drainImpl?: (ctx: unknown) => Promise<unknown>;
}) {
  const drainImpl = opts.drainImpl ?? (async () => ({ hosts: ['example.com'] }));
  return {
    call: vi.fn(async (hook: string, ctx: unknown, _payload: unknown) => {
      if (hook === HOOK) return drainImpl(ctx);
      throw new Error(`unexpected hook ${hook}`);
    }),
    hasService: vi.fn((hook: string) => (hook === HOOK ? opts.hasService ?? true : false)),
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

describe('proxy.drain-allowed-hosts handler', () => {
  it('returns the hosts the hook drained, passing ctx (NOT a body field) to the hook', async () => {
    const bus = fakeBus({
      drainImpl: async () => ({ hosts: ['b.example.com', 'a.example.com'] }),
    });
    const ctx = fakeCtx('s1');
    const result = await proxyDrainAllowedHostsHandler({}, ctx, bus as never);
    expect(result.status).toBe(200);
    expect(bodyOf(result)).toEqual({ hosts: ['b.example.com', 'a.example.com'] });
    // The hook gets the bearer-bound ctx (which carries sessionId) and an
    // empty payload: the session can only come from ctx.
    expect(bus.call).toHaveBeenCalledWith(HOOK, ctx, {});
  });

  it('degrades to { hosts: [] } WITHOUT calling the hook when no egress proxy is loaded (CLI)', async () => {
    const bus = fakeBus({ hasService: false });
    const result = await proxyDrainAllowedHostsHandler({}, fakeCtx(), bus as never);
    expect(result.status).toBe(200);
    expect(bodyOf(result)).toEqual({ hosts: [] });
    expect(bus.call).not.toHaveBeenCalled();
  });

  it('rejects a NON-empty body with 400 before dispatch (no sessionId smuggling)', async () => {
    const bus = fakeBus({});
    // An agent naming another session in the body must be refused at the
    // schema layer — ctx.sessionId is the only session source.
    const result = await proxyDrainAllowedHostsHandler(
      { sessionId: 'other' },
      fakeCtx(),
      bus as never,
    );
    expect(result.status).toBe(400);
    expect(bodyOf(result)).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(bus.call).not.toHaveBeenCalled();
  });

  it('maps a hook throw to an error envelope (never leaks the message or a stack)', async () => {
    const bus = fakeBus({
      drainImpl: async () => {
        throw new PluginError({ code: 'boom', plugin: '@ax/credential-proxy', message: 'kaboom' });
      },
    });
    const ctx = fakeCtx();
    const result = await proxyDrainAllowedHostsHandler({}, ctx, bus as never);
    expect(result.status).toBe(500);
    expect(bodyOf(result)).toEqual({
      error: { code: 'INTERNAL', message: 'internal server error' },
    });
    expect(JSON.stringify(bodyOf(result))).not.toContain('kaboom');
    // The real cause goes to the operator log, not the wire.
    expect((ctx as unknown as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error)
      .toHaveBeenCalled();
  });

  it('refuses a malformed hook answer rather than passing it to the runner', async () => {
    const bus = fakeBus({ drainImpl: async () => ({ hosts: [42] }) });
    const result = await proxyDrainAllowedHostsHandler({}, fakeCtx(), bus as never);
    expect(result.status).toBe(500);
    expect(bodyOf(result)).toEqual({
      error: { code: 'INTERNAL', message: 'internal server error' },
    });
  });
});
