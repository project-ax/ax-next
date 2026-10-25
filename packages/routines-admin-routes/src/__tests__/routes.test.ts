import { describe, expect, it } from 'vitest';
import {
  HookBus,
  PluginError,
  SafeToolError,
  type AgentContext,
} from '@ax/core';
import {
  RoutineDefinitionSchema,
  RoutineUpdateInputSchema,
} from '@ax/routines-contract';
import {
  createRoutinesAdminHandlers,
  createAdminDefaultRoutinesHandlers,
  registerRoutinesAdminRoutes,
} from '../routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';
const definition = RoutineDefinitionSchema.parse({
  name: 'Daily',
  promptBody: 'Run',
  trigger: { kind: 'interval', every: '1h' },
});
const routine = {
  ...definition,
  agentId: 'a',
  routineId: 'rtn_a',
  revision: 'rev1',
  origin: 'authored',
  defaultRoutineId: null,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastWarning: null,
  permissions: { edit: true, stop: true, fire: true, manageSecret: true },
  task: null,
  noRecentUpdate: null,
  steps: [],
  finishBy: null, done: null,
};
function req(
  body?: unknown,
  params = { agentId: 'a', routineId: 'rtn_a' },
  query: Record<string, string> = {},
): RouteRequest {
  return {
    headers: {},
    cookies: {},
    signedCookie: () => null,
    params,
    query,
    body:
      body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
  };
}
function response() {
  let status = 200;
  let body: unknown;
  const res: RouteResponse = {
    status(n) {
      status = n;
      return res;
    },
    json(v) {
      body = v;
    },
    text(v) {
      body = v;
    },
    end() {},
  };
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
  };
}
function setup(
  opts: { failure?: Error; admin?: boolean; resolveFailure?: boolean } = {},
) {
  const bus = new HookBus();
  const calls: Array<{ hook: string; ctx: AgentContext; input: unknown }> = [];
  bus.registerService('auth:require-user', 'test', async () => ({
    user: { id: 'human', isAdmin: opts.admin ?? true },
  }));
  bus.registerService('agents:resolve', 'test', async (ctx, input) => {
    calls.push({ hook: 'agents:resolve', ctx, input });
    if (opts.resolveFailure)
      throw new PluginError({
        code: 'forbidden',
        plugin: 'test',
        message: 'PRIVATE',
      });
    return { agent: { ownerId: 'team' } };
  });
  for (const [hook, result] of Object.entries({
    'routines:list': { routines: [routine] },
    'routines:get': routine,
    'routines:create': routine,
    'routines:update': routine,
    'routines:delete': { deleted: true, cleanupPending: false },
    'routines:fire-now': { status: 'ok' },
    'routines:recent-fires': { fires: [] },
    'tool-policy:get-routine-consent': { enabled: false, revision: 'c1' },
    'tool-policy:revoke-routine-consent': { enabled: false, revision: 'c2' },
    'agents:ensure-webhook-token': { token: 'authorized-token' },
    'routines:list-defaults': { defaults: [] },
    'routines:get-default': {
      ...definition,
      defaultRoutineId: 'd',
      updatedAt: '2026-10-09T00:00:00.000Z',
    },
    'routines:upsert-default': { defaultRoutineId: 'd', created: false },
    'routines:delete-default': {},
  })) {
    bus.registerService(hook, 'test', async (ctx, input) => {
      calls.push({ hook, ctx, input });
      if (opts.failure) throw opts.failure;
      return result;
    });
  }
  bus.registerService('workspace:apply', 'test', async () => {
    throw new Error('storage-full MUST NEVER BE CALLED');
  });
  return { bus, calls, h: createRoutinesAdminHandlers({ bus }) };
}
describe('structured human routine REST adapters', () => {
  it('accepts structured edits and rejects the old write format', () => {
    expect(
      RoutineUpdateInputSchema.safeParse({
        agentId: 'a',
        routineId: 'rtn_a',
        requestId: 'edit1',
        expectedRevision: 'rev1',
        patch: { name: 'Renamed' },
      }).success,
    ).toBe(true);
    expect(
      RoutineUpdateInputSchema.safeParse({
        agentId: 'a',
        path: '.ax/routines/a.md',
        sourceMd: '---\nname: a\n---\nRun',
      }).success,
    ).toBe(false);
  });
  it('creates, patches and deletes despite workspace storage-full, using the real human and scoped agent', async () => {
    const { h, calls } = setup();
    for (const [handler, body] of [
      [h.create, { requestId: 'create', definition }],
      [
        h.update,
        {
          requestId: 'edit',
          expectedRevision: 'rev1',
          patch: { name: 'Renamed' },
        },
      ],
      [h.destroy, { requestId: 'delete', expectedRevision: 'rev1' }],
    ] as const) {
      const r = response();
      await handler(req(body), r.res);
      expect(r.status).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(300);
    }
    expect(
      calls
        .filter((c) => c.hook.startsWith('routines:'))
        .map((c) => ({ agentId: c.ctx.agentId, userId: c.ctx.userId })),
    ).toEqual(Array(3).fill({ agentId: 'a', userId: 'human' }));
    expect(calls[0]?.input).not.toHaveProperty('ownerId');
  });
  it('rejects unknown fields, legacy path/sourceMd and forged agent input before mutation', async () => {
    const { h, calls } = setup();
    for (const body of [
      { requestId: 'x', definition, scope: 'global' },
      { path: '.ax/routines/a.md', sourceMd: 'Run' },
      { requestId: 'x', definition, agentId: 'other' },
    ]) {
      const r = response();
      await h.create(req(body), r.res);
      expect(r.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it('wraps raw views and scopes collection and history to one agent with strict limit', async () => {
    const { h, calls } = setup();
    for (const handler of [h.list, h.get]) {
      const r = response();
      await handler(req(), r.res);
      expect(r.status).toBe(200);
    }
    const r = response();
    await h.fires(req(undefined, undefined, { limit: '20' }), r.res);
    expect(r.body).toEqual({ fires: [] });
    expect(calls.find((c) => c.hook === 'routines:list')?.input).toEqual({
      agentId: 'a',
    });
    expect(
      calls.find((c) => c.hook === 'routines:recent-fires')?.input,
    ).toEqual({ agentId: 'a', routineId: 'rtn_a', limit: 20 });
    for (const limit of ['2.2', '0', '201', 'abc']) {
      const bad = response();
      await h.fires(req(undefined, undefined, { limit }), bad.res);
      expect(bad.status).toBe(400);
    }
  });
  it('maps unauthorized reads to 404, revision and cleanup conflicts to 409, and recomputes safe text', async () => {
    for (const [code, status] of [
      ['not-found', 404],
      ['forbidden', 404],
      ['revision-conflict', 409],
      ['cleanup-pending', 409],
    ] as const) {
      const failure = new SafeToolError(code, 'routineId');
      failure.message = 'PRIVATE SECRET';
      const { h } = setup({ failure });
      const r = response();
      await h.get(req(), r.res);
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ code, field: 'routineId' });
      expect(JSON.stringify(r.body)).not.toContain('PRIVATE');
    }
  });
  it('checks mutated closed code and field before rendering a plugin error', async () => {
    const error = new SafeToolError('validation', 'input');
    Object.assign(error, { toolCode: 'SECRET', field: 'SECRET' });
    const { h } = setup({ failure: error });
    const r = response();
    await h.get(req(), r.res);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'unavailable', field: 'input' });
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
  });

  it('returns a generic failure for infrastructure text', async () => {
    const { h } = setup({ failure: new Error('PRIVATE SECRET') });
    const r = response();
    await h.get(req(), r.res);
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain('PRIVATE');
  });
  it('registers static consent/receiver ahead of item routes', async () => {
    const { bus } = setup();
    const paths: string[] = [];
    bus.registerService('http:register-route', 'test', async (_ctx, input) => {
      paths.push((input as { path: string }).path);
      return { unregister: () => {} };
    });
    await registerRoutinesAdminRoutes(bus, {
      agentId: 'init',
      userId: 'system',
    } as AgentContext);
    expect(paths.indexOf('/settings/routines/:agentId/consent')).toBeLessThan(
      paths.indexOf('/settings/routines/:agentId/:routineId'),
    );
    expect(paths.indexOf('/settings/routines/:agentId/receiver')).toBeLessThan(
      paths.indexOf('/settings/routines/:agentId/:routineId'),
    );
  });
  it('returns only an authorized receiver prefix and current-person consent', async () => {
    const { h, calls } = setup();
    const r = response();
    await h.receiver(req(), r.res);
    expect(r.body).toEqual({ url: '/webhooks/authorized-token' });
    expect(
      calls.find((c) => c.hook === 'agents:ensure-webhook-token')?.input,
    ).toEqual({ agentId: 'a', actor: { userId: 'human', isAdmin: true } });
    const c = response();
    await h.consent(req(), c.res);
    expect(c.body).toEqual({ enabled: false, revision: 'c1' });
    const denied = setup({ resolveFailure: true });
    const d = response();
    await denied.h.receiver(req(), d.res);
    expect(d.status).toBe(404);
    expect(
      denied.calls.some((c) => c.hook === 'agents:ensure-webhook-token'),
    ).toBe(false);
  });
  it('keeps catalog admin-only and accepts flat canonical interval fields with omitted enabled', async () => {
    const { bus, calls } = setup();
    const h = createAdminDefaultRoutinesHandlers({ bus });
    const { enabled: _enabled, ...input } = definition;
    const r = response();
    await h.create(req(input), r.res);
    expect(r.status).toBe(201);
    expect(
      calls.find((c) => c.hook === 'routines:upsert-default')?.input,
    ).not.toHaveProperty('enabled');
    const bad = response();
    await h.create(req({ sourceMd: '---\nRun' }), bad.res);
    expect(bad.status).toBe(400);
    const nonAdmin = setup({ admin: false });
    const denied = response();
    await createAdminDefaultRoutinesHandlers({ bus: nonAdmin.bus }).list(
      req(),
      denied.res,
    );
    expect(denied.status).toBe(403);
  });
  it('checks default name identity before upsert and rejects unknown catalog IDs without writing', async () => {
    const { bus, calls } = setup();
    const h = createAdminDefaultRoutinesHandlers({ bus });
    const r = response();
    await h.update(
      req({ ...definition, name: 'Other' }, { id: 'd' } as never),
      r.res,
    );
    expect(r.status).toBe(400);
    expect(calls.some((c) => c.hook === 'routines:upsert-default')).toBe(false);
  });
  it('rejects a missing default before any upsert', async () => {
    const { bus, calls } = setup({
      failure: new SafeToolError('not-found', 'routineId'),
    });
    const r = response();
    await createAdminDefaultRoutinesHandlers({ bus }).update(
      req(definition, { id: 'gone' } as never),
      r.res,
    );
    expect(r.status).toBe(404);
    expect(calls.some((c) => c.hook === 'routines:upsert-default')).toBe(false);
  });
});
