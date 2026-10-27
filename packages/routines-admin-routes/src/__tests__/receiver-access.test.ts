import { describe, expect, it } from 'vitest';
import { HookBus, PluginError } from '@ax/core';
import { createRoutinesAdminHandlers, registerRoutinesAdminRoutes } from '../routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

function fixture(allowed = true, isAdmin = false, fault?: string, authenticated = true) {
  const bus = new HookBus();
  const calls: Array<{ hook: string; input: unknown; userId: string }> = [];
  bus.registerService('auth:require-user', 'test', async () => {
    if (!authenticated) throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'No session' });
    return { user: { id: 'viewer', isAdmin } };
  });
  for (const hook of ['agents:resolve', 'agents:can-manage-connectors', 'agents:ensure-webhook-token']) {
    bus.registerService(hook, 'test', async (ctx, input) => {
      calls.push({ hook, input, userId: ctx.userId });
      if (fault === hook) throw new PluginError({ code: 'unavailable', plugin: 'test', message: 'PRIVATE TOKEN' });
      if (hook === 'agents:can-manage-connectors') return { allowed };
      if (hook === 'agents:ensure-webhook-token') return { token: 'PRIVATE TOKEN' };
      return { agent: { id: 'agent' } };
    });
  }
  const handler = Reflect.get(createRoutinesAdminHandlers({ bus }), 'receiverAccess');
  const req = { headers: {}, cookies: {}, signedCookie: () => null, params: { agentId: 'agent' }, query: {}, body: Buffer.alloc(0) } as RouteRequest;
  let status = 200; let body: unknown;
  const res: RouteResponse = { status(n) { status = n; return res; }, json(v) { body = v; }, text(v) { body = v; }, end() {} };
  return { bus, calls, handler, req, res, read: () => ({ status, body }) };
}

describe('read-only routine receiver access', () => {
  it.each([
    ['personal owner', false], ['team administrator', false], ['workspace administrator', true],
  ])('uses the existing authority result for an authenticated %s without obtaining a bearer', async (_role, isAdmin) => {
    const f = fixture(true, isAdmin);
    expect(f.handler).toBeTypeOf('function');
    if (typeof f.handler !== 'function') return;
    await f.handler(f.req, f.res);
    expect(f.read()).toEqual({ status: 200, body: { allowed: true } });
    expect(f.calls).toEqual([
      { hook: 'agents:resolve', userId: 'viewer', input: { agentId: 'agent', userId: 'viewer' } },
      { hook: 'agents:can-manage-connectors', userId: 'viewer', input: { agentId: 'agent', actor: { userId: 'viewer', isAdmin } } },
    ]);
    expect(JSON.stringify(f.read().body)).not.toContain('TOKEN');
  });

  it('returns a denial without trying to ensure or read a token', async () => {
    const f = fixture(false);
    expect(f.handler).toBeTypeOf('function');
    if (typeof f.handler !== 'function') return;
    await f.handler(f.req, f.res);
    expect(f.read()).toEqual({ status: 200, body: { allowed: false } });
    expect(f.calls.map(c => c.hook)).toEqual(['agents:resolve', 'agents:can-manage-connectors']);
  });

  it('does not inspect an agent or its capability before authentication', async () => {
    const f = fixture(true, false, undefined, false);
    expect(f.handler).toBeTypeOf('function');
    if (typeof f.handler !== 'function') return;
    await f.handler(f.req, f.res);
    expect(f.read().status).toBe(401);
    expect(f.calls).toEqual([]);
  });

  it.each(['agents:resolve', 'agents:can-manage-connectors'])('keeps a %s fault distinct from a denial and hides its details', async fault => {
    const f = fixture(false, false, fault);
    expect(f.handler).toBeTypeOf('function');
    if (typeof f.handler !== 'function') return;
    await f.handler(f.req, f.res);
    expect(f.read().status).toBeGreaterThanOrEqual(500);
    expect(f.read().body).not.toEqual({ allowed: false });
    expect(JSON.stringify(f.read().body)).not.toContain('PRIVATE');
    expect(f.calls.some(c => c.hook === 'agents:ensure-webhook-token')).toBe(false);
  });

  it('registers the specific access route before the routine-id route', async () => {
    const f = fixture();
    const routes: Array<{ method: string; path: string }> = [];
    f.bus.registerService('http:register-route', 'test', async (_ctx, input) => {
      routes.push(input as { method: string; path: string });
      return { unregister() {} };
    });
    await registerRoutinesAdminRoutes(f.bus, { userId: 'viewer' } as never);
    const access = routes.findIndex(r => r.method === 'GET' && r.path.endsWith('/receiver-access'));
    expect(access).toBeGreaterThanOrEqual(0);
    expect(access).toBeLessThan(routes.findIndex(r => r.method === 'GET' && r.path.endsWith('/:routineId')));
  });
});
