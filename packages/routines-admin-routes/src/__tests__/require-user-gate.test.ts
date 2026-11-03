import { describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type Logger } from '@ax/core';
import { requireAdmin, requireAuthenticated, type RouteRequest, type RouteResponse } from '../shared.js';

// TASK-1030: only 'unauthenticated' is a 401. A session-store fault is a
// logged 500, never "signed out".

function fixture(authService: () => Promise<unknown>) {
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'test-auth', authService);
  const logged: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error: (msg, fields) => logged.push({ msg, fields }),
    child: () => logger,
  };
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'system', logger });
  const req = { headers: {}, cookies: {}, signedCookie: () => null, params: {}, query: {}, body: Buffer.alloc(0) } as RouteRequest;
  let status = 200;
  let body: unknown;
  const res: RouteResponse = {
    status(n) { status = n; return res; },
    json(v) { body = v; },
    text(v) { body = v; },
    end() {},
  };
  return { bus, ctx, req, res, logged, read: () => ({ status, body }) };
}

describe('routines-admin-routes auth gate (TASK-1030)', () => {
  it('maps the hook refusal (unauthenticated) to 401', async () => {
    const f = fixture(async () => {
      throw new PluginError({ code: 'unauthenticated', plugin: 'test-auth', message: 'no session' });
    });
    expect(await requireAuthenticated(f.bus, f.ctx, f.req, f.res)).toBeNull();
    expect(f.read()).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(f.logged).toEqual([]);
  });

  it('maps a session-store fault to a logged 500, not a 401', async () => {
    // Raw Error through the REAL bus: the bus wraps it as PluginError{code:'unknown'}.
    const f = fixture(async () => {
      throw new Error('pg down at 10.0.0.7');
    });
    expect(await requireAuthenticated(f.bus, f.ctx, f.req, f.res)).toBeNull();
    expect(f.read()).toEqual({ status: 500, body: { error: 'internal' } });
    expect(JSON.stringify(f.read().body)).not.toContain('10.0.0.7');
    expect(f.logged).toHaveLength(1);
    expect(f.logged[0]?.msg).toBe('routines_admin_require_user_failed');
    expect(f.logged[0]?.fields?.hook).toBe('auth:require-user');
    const err = f.logged[0]?.fields?.err as PluginError;
    expect(err.code).toBe('unknown');
    expect((err.cause as Error).message).toBe('pg down at 10.0.0.7');
  });

  it('requireAdmin passes the same answer through (no 403, no 401, for a fault)', async () => {
    const f = fixture(async () => {
      throw new Error('pg down at 10.0.0.7');
    });
    expect(await requireAdmin(f.bus, f.ctx, f.req, f.res)).toBeNull();
    expect(f.read().status).toBe(500);
  });
});
