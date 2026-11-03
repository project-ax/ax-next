import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type Logger } from '@ax/core';
import { requireAuthenticated } from '../shared.js';

// ---------------------------------------------------------------------------
// The `auth:require-user` gate in @ax/branding (TASK-1030). Only the hook's own
// 'unauthenticated' refusal is a 401. HookBus.call wraps whatever else a
// service throws as PluginError{ code: 'unknown', cause }, so a session-store
// crash must come out as a logged 500, not a "sign in again" 401.
// ---------------------------------------------------------------------------

function mkRes() {
  let status = 200;
  let body: unknown;
  const res = {
    status(n: number) {
      status = n;
      return res;
    },
    header() {
      return res;
    },
    json(v: unknown) {
      body = v;
    },
    text(s: string) {
      body = s;
    },
    body() {},
    end() {},
  };
  return { res, statusOf: () => status, bodyOf: () => body };
}

const req = {
  headers: {},
  body: Buffer.alloc(0),
  cookies: {},
  query: {},
  params: {},
  signedCookie: () => null,
};

function mkCtx() {
  const errors: Array<{ msg: string; bindings: Record<string, unknown> | undefined }> = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error(msg, bindings) {
      errors.push({ msg, bindings });
    },
    child: () => logger,
  };
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'test', userId: 'system', logger });
  return { ctx, errors };
}

describe('@ax/branding auth:require-user gate (requireAuthenticated)', () => {
  it('unauthenticated refusal -> 401', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'test', async () => {
      throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'no cookie' });
    });
    const { ctx, errors } = mkCtx();
    const { res, statusOf, bodyOf } = mkRes();
    const out = await requireAuthenticated(bus, ctx, req as never, res as never);
    expect(out).toBeNull();
    expect(statusOf()).toBe(401);
    expect(bodyOf()).toEqual({ error: 'unauthenticated' });
    expect(errors).toEqual([]);
  });

  it('a session-store fault -> logged 500 that does not echo the message', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'test', async () => {
      throw new Error('pg down at 10.0.0.7');
    });
    const { ctx, errors } = mkCtx();
    const { res, statusOf, bodyOf } = mkRes();
    const out = await requireAuthenticated(bus, ctx, req as never, res as never);
    expect(out).toBeNull();
    expect(statusOf()).toBe(500);
    expect(bodyOf()).toEqual({ error: 'internal' });
    expect(JSON.stringify(bodyOf())).not.toContain('pg down');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe('branding_require_user_failed');
    expect(errors[0]!.bindings!.hook).toBe('auth:require-user');
    const err = errors[0]!.bindings!.err as PluginError;
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('unknown');
    expect((err.cause as Error).message).toBe('pg down at 10.0.0.7');
  });
});
