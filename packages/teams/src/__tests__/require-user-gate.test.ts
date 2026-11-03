import { describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError } from '@ax/core';
import {
  createAdminTeamRouteHandlers,
  type RouteRequest,
  type RouteResponse,
} from '../admin-routes.js';

// TASK-1030: only 'unauthenticated' is a 401. A session-store fault is a
// logged 500, never "signed out". No database needed: the gate runs before
// any teams service is called.

function run(authService: () => Promise<unknown>) {
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'test-auth', authService);
  const handlers = createAdminTeamRouteHandlers({ bus });
  const req = {
    headers: {},
    cookies: {},
    signedCookie: () => null,
    params: {},
    query: {},
    body: Buffer.alloc(0),
  } as RouteRequest;
  let status = 200;
  let body: unknown;
  const res: RouteResponse = {
    status(n) { status = n; return res; },
    json(v) { body = v; },
    text(v) { body = v; },
    end() {},
  };
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stdout.write);
  const done = handlers.list(req, res).finally(() => spy.mockRestore());
  const logs = () =>
    chunks
      .flatMap((c) => c.split('\n'))
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { done, logs, read: () => ({ status, body }) };
}

describe('teams admin auth gate (TASK-1030)', () => {
  it('maps the hook refusal (unauthenticated) to 401', async () => {
    const f = run(async () => {
      throw new PluginError({ code: 'unauthenticated', plugin: 'test-auth', message: 'no session' });
    });
    await f.done;
    expect(f.read()).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(f.logs().filter((l) => l.msg === 'teams_require_user_failed')).toEqual([]);
  });

  it('maps a session-store fault to a logged 500, not a 401', async () => {
    // Raw Error through the REAL bus: the bus wraps it as PluginError{code:'unknown'}.
    const f = run(async () => {
      throw new Error('pg down at 10.0.0.7');
    });
    await f.done;
    expect(f.read()).toEqual({ status: 500, body: { error: 'internal' } });
    expect(JSON.stringify(f.read().body)).not.toContain('10.0.0.7');
    const logged = f.logs().filter((l) => l.msg === 'teams_require_user_failed');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.hook).toBe('auth:require-user');
    expect((logged[0]?.err as { code?: string }).code).toBe('unknown');
  });
});
