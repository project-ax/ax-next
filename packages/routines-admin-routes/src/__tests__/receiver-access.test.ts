import { describe, expect, it } from 'vitest';
import { HookBus, PluginError } from '@ax/core';
import { createRoutinesAdminHandlers, registerRoutinesAdminRoutes } from '../routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

// `allowed` is what agents:can-manage-webhook-token answers (and whether
// agents:ensure-webhook-token succeeds); `connectors` is what
// agents:can-manage-connectors answers. They differ for a co-owner of a
// personal agent (TASK-1246): an owner manages its connectors, but only its
// creator holds the webhook token. The route must ask the token's own question.
function fixture(allowed = true, isAdmin = false, fault?: string, authenticated = true, connectors = allowed) {
  const bus = new HookBus();
  const calls: Array<{ hook: string; input: unknown; userId: string }> = [];
  bus.registerService('auth:require-user', 'test', async () => {
    if (!authenticated) throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'No session' });
    return { user: { id: 'viewer', isAdmin } };
  });
  const hooks = [
    'agents:resolve',
    'agents:can-manage-webhook-token',
    'agents:can-manage-connectors',
    'agents:ensure-webhook-token',
  ];
  for (const hook of hooks) {
    bus.registerService(hook, 'test', async (ctx, input) => {
      calls.push({ hook, input, userId: ctx.userId });
      if (fault === hook) throw new PluginError({ code: 'unavailable', plugin: 'test', message: 'PRIVATE TOKEN' });
      if (hook === 'agents:can-manage-webhook-token') return { allowed };
      if (hook === 'agents:can-manage-connectors') return { allowed: connectors };
      if (hook === 'agents:ensure-webhook-token') {
        if (!allowed) throw new PluginError({ code: 'forbidden', plugin: 'test', message: 'not the creator' });
        return { token: 'PRIVATE TOKEN' };
      }
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
    ['personal agent creator', false], ['team administrator', false], ['workspace administrator', true],
  ])('uses the token authority result for an authenticated %s without obtaining a bearer', async (_role, isAdmin) => {
    const f = fixture(true, isAdmin);
    expect(f.handler).toBeTypeOf('function');
    if (typeof f.handler !== 'function') return;
    await f.handler(f.req, f.res);
    expect(f.read()).toEqual({ status: 200, body: { allowed: true } });
    expect(f.calls).toEqual([
      { hook: 'agents:resolve', userId: 'viewer', input: { agentId: 'agent', userId: 'viewer' } },
      { hook: 'agents:can-manage-webhook-token', userId: 'viewer', input: { agentId: 'agent', actor: { userId: 'viewer', isAdmin } } },
    ]);
    expect(JSON.stringify(f.read().body)).not.toContain('TOKEN');
  });

  it('returns a denial without trying to ensure or read a token', async () => {
    const f = fixture(false);
    expect(f.handler).toBeTypeOf('function');
    if (typeof f.handler !== 'function') return;
    await f.handler(f.req, f.res);
    expect(f.read()).toEqual({ status: 200, body: { allowed: false } });
    expect(f.calls.map(c => c.hook)).toEqual(['agents:resolve', 'agents:can-manage-webhook-token']);
  });

  // TASK-1246: a co-owner of a personal agent manages its connectors, so
  // agents:can-manage-connectors says yes to them, but the token stays the
  // creator's. The read must never say yes to someone the write (receiver ->
  // agents:ensure-webhook-token) refuses.
  it.each([
    ['the creator', true],
    ['a co-owner', false],
  ])('%s gets the answer the receiver write gives, though can-manage-connectors says yes to both', async (_who, allowed) => {
    const read = fixture(allowed, false, undefined, true, true);
    expect(read.handler).toBeTypeOf('function');
    if (typeof read.handler !== 'function') return;
    await read.handler(read.req, read.res);
    expect(read.read()).toEqual({ status: 200, body: { allowed } });

    const write = fixture(allowed, false, undefined, true, true);
    const receiver = Reflect.get(createRoutinesAdminHandlers({ bus: write.bus }), 'receiver');
    expect(receiver).toBeTypeOf('function');
    if (typeof receiver !== 'function') return;
    await receiver(write.req, write.res);
    expect(write.read().status === 200).toBe(allowed);
  });

  it('does not inspect an agent or its capability before authentication', async () => {
    const f = fixture(true, false, undefined, false);
    expect(f.handler).toBeTypeOf('function');
    if (typeof f.handler !== 'function') return;
    await f.handler(f.req, f.res);
    expect(f.read().status).toBe(401);
    expect(f.calls).toEqual([]);
  });

  it.each(['agents:resolve', 'agents:can-manage-webhook-token'])('keeps a %s fault distinct from a denial and hides its details', async fault => {
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
