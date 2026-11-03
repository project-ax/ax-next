import { describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type Logger } from '@ax/core';
import { createOnboardingRouteHandlers, type RouteRequest, type RouteResponse } from '../routes.js';

// TASK-1030: on POST /setup/model only 'unauthenticated' is a 401. A
// session-store fault is a logged 500, never "signed out". No database
// needed: the auth gate runs before anything else this test would touch.

function run(authService: () => Promise<unknown>) {
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
  const initCtx = makeAgentContext({ sessionId: 'init', agentId: '@ax/onboarding', userId: 'system', logger });
  const handlers = createOnboardingRouteHandlers({
    // Wizard is not complete yet, so the pre-auth gate passes.
    store: { read: async () => ({ status: 'pending' }) } as never,
    sessions: {} as never,
    rateLimit: {} as never,
    bus,
    initCtx,
  });
  const req = {
    method: 'POST',
    path: '/setup/model',
    headers: {},
    cookies: {},
    query: {},
    params: {},
    body: Buffer.from('{}'),
    signedCookie: () => null,
  } as RouteRequest;
  let status = 200;
  let body: unknown;
  const res = {
    status(n: number) { status = n; return res; },
    json(v: unknown) { body = v; },
  } as unknown as RouteResponse;
  return { done: handlers.model(req, res), logged, read: () => ({ status, body }) };
}

describe('onboarding /setup/model auth gate (TASK-1030)', () => {
  it('maps the hook refusal (unauthenticated) to 401', async () => {
    const f = run(async () => {
      throw new PluginError({ code: 'unauthenticated', plugin: 'test-auth', message: 'no session' });
    });
    await f.done;
    expect(f.read()).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(f.logged).toEqual([]);
  });

  it('maps a session-store fault to a logged 500, not a 401', async () => {
    // Raw Error through the REAL bus: the bus wraps it as PluginError{code:'unknown'}.
    const f = run(async () => {
      throw new Error('pg down at 10.0.0.7');
    });
    await f.done;
    expect(f.read()).toEqual({ status: 500, body: { error: 'internal' } });
    expect(JSON.stringify(f.read().body)).not.toContain('10.0.0.7');
    expect(f.logged).toHaveLength(1);
    expect(f.logged[0]?.msg).toBe('onboarding_require_user_failed');
    expect(f.logged[0]?.fields?.hook).toBe('auth:require-user');
    const err = f.logged[0]?.fields?.err as PluginError;
    expect(err.code).toBe('unknown');
    expect((err.cause as Error).message).toBe('pg down at 10.0.0.7');
  });
});
