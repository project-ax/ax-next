import { describe, expect, it } from 'vitest';
import {
  HookBus,
  PluginError,
  SafeToolError,
  type AgentContext,
} from '@ax/core';
import {
  RoutineDefinitionSchema,
  RoutineFireViewSchema,
  RoutineUpdateInputSchema,
  RoutineViewSchema,
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
const { schedule, webhook: _webhook, ...defaultFields } = definition;
const defaultDefinition = { ...defaultFields, trigger: schedule! };
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
  finishBy: null, finishByTimeZone: null, done: null,
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
  opts: {
    failure?: Error;
    admin?: boolean;
    resolveFailure?: boolean;
    /** What the routines services answer instead: one routine view (list, get, create, update) and the runs. */
    answers?: { view?: unknown; fires?: unknown[] };
  } = {},
) {
  const view = opts.answers?.view ?? routine;
  const fires = opts.answers?.fires ?? [];
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
    'routines:list': { routines: [view] },
    'routines:get': view,
    'routines:create': view,
    'routines:update': view,
    'routines:delete': { deleted: true, cleanupPending: false },
    'routines:fire-now': { status: 'ok' },
    'routines:recent-fires': { fires },
    'tool-policy:get-routine-consent': { enabled: false, revision: 'c1' },
    'tool-policy:revoke-routine-consent': { enabled: false, revision: 'c2' },
    'agents:ensure-webhook-token': { token: 'authorized-token' },
    'agents:can-manage-connectors': { allowed: true },
    'routines:list-defaults': { defaults: [] },
    'routines:get-default': {
      ...defaultDefinition,
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
    const { enabled: _enabled, ...input } = defaultDefinition;
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
      req({ ...defaultDefinition, name: 'Other' }, { id: 'd' } as never),
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
      req(defaultDefinition, { id: 'gone' } as never),
      r.res,
    );
    expect(r.status).toBe(404);
    expect(calls.some((c) => c.hook === 'routines:upsert-default')).toBe(false);
  });
});
describe('the Settings routes answer no task state (TASK-957)', () => {
  // A task's state as text: what its agent writes (the report, notes and reading label, the steps, each
  // run's report), and a step a person added, which sits in the same checklist.
  const AGENT_TEXT = {
    update: 'Agent update 5d1c', ask: 'Agent ask 5d1c', notes: 'Agent notes 5d1c', label: 'Agent label 5d1c',
    agentStep: 'Agent step 5d1c', personStep: 'Person step 5d1c',
    runUpdate: 'Run update 5d1c', runAsk: 'Run ask 5d1c', runLabel: 'Run label 5d1c',
  };
  /** A Done get-done task as the services answer its owner: every field set. */
  const taskView = {
    ...RoutineDefinitionSchema.parse({
      name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', enabled: false,
      trigger: { kind: 'interval', every: '1h' }, kind: 'get-done', goodWhen: 'Every article is on the new site.',
    }),
    agentId: 'a', routineId: 'rtn_a', revision: 'rev1', origin: 'authored', defaultRoutineId: null,
    nextRunAt: null, lastRunAt: '2026-10-25T09:00:00.000Z', lastStatus: 'ok', lastError: null, lastWarning: null,
    permissions: { edit: true, stop: true, fire: true, manageSecret: true },
    task: {
      status: 'needs-you', update: AGENT_TEXT.update, ask: AGENT_TEXT.ask, reading: { value: 3, label: AGENT_TEXT.label },
      doneClaimed: false, reportedAt: '2026-10-25T09:05:00.000Z', agentNotes: AGENT_TEXT.notes,
    },
    noRecentUpdate: { inARow: 2, reason: 'no-report', at: '2026-10-25T09:30:00.000Z', autoPaused: false },
    steps: [
      { id: 's000001', text: AGENT_TEXT.agentStep, done: true, addedBy: 'agent' },
      { id: 's000002', text: AGENT_TEXT.personStep, done: false, addedBy: 'person' },
    ],
    finishBy: '2026-11-01', finishByTimeZone: 'America/Los_Angeles', done: { at: '2026-10-25T09:40:00.000Z' },
  };
  const runView = {
    agentId: 'a', routineId: 'rtn_a', firedAt: '2026-10-25T09:00:00.000Z', triggerSource: 'tick', conversationId: 'conv_1',
    status: 'ok', error: null, renderedPrompt: null, warning: null,
    report: { status: 'on-track', update: AGENT_TEXT.runUpdate, ask: AGENT_TEXT.runAsk, reading: { value: 2, label: AGENT_TEXT.runLabel } },
  };
  /**
   * Every field a Settings routine view carries, reviewed. A new field fails here on purpose: if an agent
   * writes any of it, settingsView leaves it out; if only the host or a person writes it, add it here.
   */
  const VIEW_KEYS = ['activeHours', 'agentId', 'conversation', 'defaultRoutineId', 'description', 'done', 'enabled',
    'finishBy', 'finishByTimeZone', 'goodWhen', 'kind', 'lastError', 'lastRunAt', 'lastStatus', 'lastWarning',
    'name', 'nextRunAt', 'noRecentUpdate', 'origin', 'permissions', 'promptBody', 'revision', 'routineId',
    'silenceMaxChars', 'silenceToken', 'steps', 'task', 'schedule', 'webhook'];
  /** Every field a Settings run carries, reviewed the same way. */
  const RUN_KEYS = ['agentId', 'conversationId', 'error', 'firedAt', 'renderedPrompt', 'report', 'routineId',
    'status', 'triggerSource', 'warning'];
  /** One request per Settings route, each one its handler accepts. */
  const requests = {
    list: req(),
    get: req(),
    create: req({ requestId: 'create', definition }),
    update: req({ requestId: 'edit', expectedRevision: 'rev1', patch: { name: 'Renamed' } }),
    destroy: req({ requestId: 'delete', expectedRevision: 'rev1' }),
    fire: req({ requestId: 'fire', expectedRevision: 'rev1' }),
    fires: req(),
    consent: req(),
    revokeConsent: req({}),
    receiver: req(),
    receiverAccess: req(),
  };
  /** The routines services answer as they do the task's owner: the task's state and the runs' reports. */
  const asOwner = () => setup({ answers: { view: taskView, fires: [runView] } });
  async function serve(
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>,
    request: RouteRequest,
  ) {
    const r = response();
    await handler(request, r.res);
    return r;
  }
  it('no route answers any text an agent wrote, to the task’s owner included', async () => {
    const { h } = asOwner();
    // Every handler, so a new route can't skip this test.
    expect(Object.keys(requests).sort()).toEqual(Object.keys(h).sort());
    for (const [name, request] of Object.entries(requests)) {
      const r = await serve(h[name as keyof typeof h], request);
      expect(r.status, name).toBeGreaterThanOrEqual(200);
      expect(r.status, name).toBeLessThan(300);
      const served = JSON.stringify(r.body);
      for (const text of Object.values(AGENT_TEXT))
        expect(served, `${name} answers ${text}`).not.toContain(text);
    }
  });
  it('a routine view keeps the routine and what the host wrote, with task null and steps empty', async () => {
    const { h } = asOwner();
    const views = {
      list: ((await serve(h.list, requests.list)).body as { routines: unknown[] }).routines[0],
      get: ((await serve(h.get, requests.get)).body as { routine: unknown }).routine,
      create: ((await serve(h.create, requests.create)).body as { routine: unknown }).routine,
      update: ((await serve(h.update, requests.update)).body as { routine: unknown }).routine,
    };
    for (const [name, view] of Object.entries(views)) {
      expect(view, name).toStrictEqual({ ...taskView, task: null, steps: [] });
      expect(Object.keys(view as object).sort(), name).toEqual([...VIEW_KEYS].sort());
      // The SPA types this answer as a RoutineView.
      expect(RoutineViewSchema.safeParse(view).success, name).toBe(true);
    }
  });
  it('the reviewed key lists are every field the contract\u2019s views have, optional ones included', () => {
    // The fixtures above can leave out an optional field, which settingsView would then pass on unreviewed.
    // Checked against the schemas themselves, a new field of either kind fails here until someone decides.
    expect(Object.keys(RoutineViewSchema.innerType().shape).sort()).toEqual([...VIEW_KEYS].sort());
    expect(Object.keys(RoutineFireViewSchema.shape).sort()).toEqual([...RUN_KEYS].sort());
  });
  it('a run keeps everything but its report', async () => {
    const { h } = asOwner();
    const { body } = await serve(h.fires, requests.fires);
    expect(body).toStrictEqual({ fires: [{ ...runView, report: null }] });
    const [run] = (body as { fires: object[] }).fires;
    expect(Object.keys(run ?? {}).sort()).toEqual([...RUN_KEYS].sort());
  });
});
