import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createRoutinesAdminRoutesPlugin } from '../plugin.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

// ---------------------------------------------------------------------------
// /settings/routines* handler tests.
//
// We can't import @ax/routines or @ax/agents (Invariant L2 — no cross-plugin
// imports), so the test mocks the service hooks directly via the test
// harness. The harness pre-registers our mock services BEFORE bootstrap, so
// verifyCalls sees them when our plugin's manifest declares
// `calls:['routines:list', ...]`.
//
// The handlers we exercise come back through the http:register-route mock,
// which captures them by path so the test can call them with synthetic
// req/res objects.
// ---------------------------------------------------------------------------

type Handler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

interface DefaultRoutineSummaryMock {
  defaultRoutineId: string;
  name: string;
  description: string;
  trigger: unknown;
  enabled: boolean;
  updatedAt: string;
}

interface DefaultRoutineDetailMock extends DefaultRoutineSummaryMock {
  sourceMd: string;
  silenceToken: string | null;
  silenceMax: number;
  conversation: 'per-fire' | 'shared';
  activeHours: unknown | null;
  promptBody: string;
}

/** When set, auth:require-user throws this — drives the 401-path test
 *  through requireAuthenticated / requireAdmin. */
type AuthMode =
  | { kind: 'unauthenticated' }
  | { kind: 'authed'; user: { id: string; isAdmin: boolean } };

interface MockServices {
  authedUser?: { id: string; isAdmin: boolean };
  /** Forces auth:require-user to throw — overrides authedUser. */
  authMode?: AuthMode;
  /** When set, agents:resolve throws this for ANY agentId+userId pair —
   *  used by the 403-path test. */
  resolveFailure?: PluginError;
  /** If set, agents:resolve succeeds only for agentIds in this allow-set
   *  (and throws PluginError 'forbidden' otherwise). Overrides default
   *  "always-succeeds" behaviour. */
  ownedAgentIds?: ReadonlySet<string>;
  routinesList?: () => Promise<{ routines: Array<{ agentId: string }> }>;
  recentFires?: (
    input: { agentId: string; path: string; limit?: number },
  ) => Promise<{ fires: unknown[] }>;
  fireNow?: (
    input: { agentId: string; path: string; payload?: unknown; source: string },
  ) => Promise<{ fireId: number; status: string; conversationId: string | null }>;
  /** In-memory store of default routines for the admin-routes tests. Keyed
   *  by defaultRoutineId. Initialized with a heartbeat seed so the list/get
   *  tests have something to find without going through upsert first. */
  defaults?: Map<string, DefaultRoutineDetailMock>;
  /** When set, routines:upsert-default throws this instead of writing. */
  upsertDefaultThrow?: PluginError;
}

async function makeHarnessWith(opts: MockServices) {
  // Path-keyed map for backwards compat with the pre-existing /settings/*
  // tests (each settings route has a unique path, so collisions aren't a
  // concern there). The admin /defaults* surface shares paths across
  // methods, so we ALSO populate a method+path map and prefer it.
  const handlers = new Map<string, Handler>();
  const handlersByMethod = new Map<string, Handler>();
  const authedUser = opts.authedUser ?? { id: 'u1', isAdmin: false };
  const authMode: AuthMode =
    opts.authMode ?? { kind: 'authed', user: authedUser };
  const defaults =
    opts.defaults ?? new Map<string, DefaultRoutineDetailMock>();
  const harness = await createTestHarness({
    services: {
      'http:register-route': async (_ctx, input: unknown) => {
        const i = input as { method: string; path: string; handler: Handler };
        handlers.set(i.path, i.handler);
        handlersByMethod.set(`${i.method} ${i.path}`, i.handler);
        return { unregister: () => {} };
      },
      'auth:require-user': async () => {
        if (authMode.kind === 'unauthenticated') {
          throw new PluginError({
            code: 'unauthenticated',
            plugin: 'test',
            message: 'no session',
          });
        }
        return { user: authMode.user };
      },
      'routines:list': async () =>
        opts.routinesList !== undefined
          ? opts.routinesList()
          : { routines: [] },
      'routines:recent-fires': async (_ctx, input: unknown) => {
        if (opts.recentFires !== undefined) {
          return opts.recentFires(
            input as { agentId: string; path: string; limit?: number },
          );
        }
        return { fires: [] };
      },
      'routines:fire-now': async (_ctx, input: unknown) => {
        if (opts.fireNow !== undefined) {
          return opts.fireNow(
            input as {
              agentId: string;
              path: string;
              payload?: unknown;
              source: string;
            },
          );
        }
        return { fireId: 1, status: 'ok', conversationId: 'cnv_x' };
      },
      'agents:resolve': async (_ctx, input: unknown) => {
        if (opts.resolveFailure !== undefined) throw opts.resolveFailure;
        const i = input as { agentId: string; userId: string };
        if (
          opts.ownedAgentIds !== undefined &&
          !opts.ownedAgentIds.has(i.agentId)
        ) {
          throw new PluginError({
            code: 'forbidden',
            plugin: 'test',
            message: `forbidden: ${i.userId} cannot resolve ${i.agentId}`,
          });
        }
        // Default mock: every agent resolves successfully and is "owned"
        // by the user that asked. Tests pass `resolveFailure` (blanket
        // deny) or `ownedAgentIds` (allowlist) to override.
        return {
          agent: { id: i.agentId, ownerId: i.userId, workspaceRef: null },
        };
      },
      'routines:list-defaults': async () => ({
        defaults: Array.from(defaults.values()).map((d) => ({
          defaultRoutineId: d.defaultRoutineId,
          name: d.name,
          description: d.description,
          trigger: d.trigger,
          enabled: d.enabled,
          updatedAt: d.updatedAt,
        })),
      }),
      'routines:get-default': async (_ctx, input: unknown) => {
        const i = input as { defaultRoutineId: string };
        const row = defaults.get(i.defaultRoutineId);
        if (row === undefined) {
          throw new PluginError({
            code: 'not-found',
            plugin: 'test',
            message: `default routine '${i.defaultRoutineId}' not found`,
          });
        }
        return row;
      },
      'routines:upsert-default': async (_ctx, input: unknown) => {
        if (opts.upsertDefaultThrow !== undefined) {
          throw opts.upsertDefaultThrow;
        }
        const i = input as { sourceMd: string };
        // Pretend-parse: pull `name:` out of the frontmatter. If we can't
        // find one we throw invalid-routine-md to mirror the real plugin's
        // behaviour on malformed sourceMd. The router-level test exercises
        // the writeServiceError mapping, so we just need the throw shape.
        const nameMatch = /^name:\s*([\w-]+)\s*$/m.exec(i.sourceMd);
        if (nameMatch === null) {
          throw new PluginError({
            code: 'invalid-routine-md',
            plugin: 'test',
            message: 'missing name in frontmatter',
          });
        }
        // Reject webhook trigger to drive the 400 code-mapping test.
        if (/kind:\s*webhook/.test(i.sourceMd)) {
          throw new PluginError({
            code: 'default-trigger-webhook-not-supported',
            plugin: 'test',
            message: 'default routines do not support webhook triggers in v1',
          });
        }
        const name = nameMatch[1] ?? 'unknown';
        const id = `default-${name}-test`;
        const existed = defaults.has(id);
        defaults.set(id, {
          defaultRoutineId: id,
          name,
          description: 'mock',
          trigger: { kind: 'interval', every: '5m' },
          enabled: true,
          updatedAt: new Date('2026-05-19T00:00:00Z').toISOString(),
          sourceMd: i.sourceMd,
          silenceToken: null,
          silenceMax: 300,
          conversation: 'per-fire',
          activeHours: null,
          promptBody: 'mock body',
        });
        return { defaultRoutineId: id, created: !existed };
      },
      'routines:delete-default': async (_ctx, input: unknown) => {
        const i = input as { defaultRoutineId: string };
        defaults.delete(i.defaultRoutineId);
        return {};
      },
    },
    plugins: [createRoutinesAdminRoutesPlugin()],
  });
  return { harness, handlers, handlersByMethod, defaults };
}

function makeReq(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    headers: over.headers ?? {},
    body: over.body ?? Buffer.alloc(0),
    cookies: over.cookies ?? {},
    query: over.query ?? {},
    params: over.params ?? {},
    signedCookie: () => null,
  };
}

interface CapturedRes {
  status?: number;
  body?: unknown;
}
function makeRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = {};
  const res: RouteResponse = {
    status(n: number) {
      captured.status = n;
      return res;
    },
    json(b: unknown) {
      captured.body = b;
    },
    text() {},
    end() {},
  };
  return { res, captured };
}

describe('routines-admin-routes', () => {
  it('GET /settings/routines returns routines visible to the actor', async () => {
    const { harness, handlers } = await makeHarnessWith({
      routinesList: async () => ({
        routines: [
          { agentId: 'agt_a' },
          { agentId: 'agt_b' },
        ],
      }),
    });
    const handler = handlers.get('/settings/routines');
    expect(handler).toBeDefined();
    const { res, captured } = makeRes();
    await handler!(makeReq(), res);
    expect(captured.status).toBe(200);
    const body = captured.body as { routines: Array<{ agentId: string }> };
    expect(body.routines.map((r) => r.agentId)).toEqual(['agt_a', 'agt_b']);
    await harness.close({ onError: () => {} });
  });

  it('GET /settings/routines filters out agents the actor does not own', async () => {
    const { harness, handlers } = await makeHarnessWith({
      authedUser: { id: 'u1', isAdmin: false },
      routinesList: async () => ({
        routines: [
          { agentId: 'agt_visible' },
          { agentId: 'agt_hidden' },
        ],
      }),
      // Only agt_visible passes agents:resolve; agt_hidden gets 'forbidden'.
      ownedAgentIds: new Set(['agt_visible']),
    });
    const handler = handlers.get('/settings/routines')!;
    const { res, captured } = makeRes();
    await handler(makeReq(), res);
    expect(captured.status).toBe(200);
    const body = captured.body as { routines: Array<{ agentId: string }> };
    expect(body.routines.map((r) => r.agentId)).toEqual(['agt_visible']);
    await harness.close({ onError: () => {} });
  });

  it('GET /settings/routines/:agentId/fires returns recent fires', async () => {
    let observedInput: { agentId: string; path: string; limit?: number } | undefined;
    const { harness, handlers } = await makeHarnessWith({
      recentFires: async (input) => {
        observedInput = input;
        return {
          fires: [
            {
              id: 1,
              agentId: input.agentId,
              path: input.path,
              firedAt: new Date('2026-05-17T00:00:00Z'),
              triggerSource: 'manual',
              conversationId: 'cnv_1',
              status: 'ok',
              error: null,
              renderedPrompt: 'hi',
            },
          ],
        };
      },
    });
    const handler = handlers.get('/settings/routines/:agentId/fires')!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({
        params: { agentId: 'agt_a' },
        query: { path: '.ax/routines/r.md', limit: '20' },
      }),
      res,
    );
    expect(captured.status).toBe(200);
    expect((captured.body as { fires: unknown[] }).fires).toHaveLength(1);
    expect(observedInput).toEqual({
      agentId: 'agt_a',
      path: '.ax/routines/r.md',
      limit: 20,
    });
    await harness.close({ onError: () => {} });
  });

  it('GET /settings/routines/:agentId/fires rejects non-numeric ?limit with 400', async () => {
    let recentFiresCalled = false;
    const { harness, handlers } = await makeHarnessWith({
      recentFires: async () => {
        recentFiresCalled = true;
        return { fires: [] };
      },
    });
    const handler = handlers.get('/settings/routines/:agentId/fires')!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({
        params: { agentId: 'agt_a' },
        query: { path: '.ax/routines/r.md', limit: 'abc' },
      }),
      res,
    );
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toMatch(/limit/i);
    // The bus call must NOT happen — bad input fails before the store
    // ever sees a NaN that would become SQL `LIMIT NaN`.
    expect(recentFiresCalled).toBe(false);
    await harness.close({ onError: () => {} });
  });

  it('POST /settings/routines/:agentId/fire calls routines:fire-now with payload', async () => {
    let fired:
      | { agentId: string; path: string; payload?: unknown; source: string }
      | undefined;
    const { harness, handlers } = await makeHarnessWith({
      fireNow: async (input) => {
        fired = input;
        return { fireId: 7, status: 'ok', conversationId: 'cnv_x' };
      },
    });
    const handler = handlers.get('/settings/routines/:agentId/fire')!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({
        params: { agentId: 'agt_a' },
        body: Buffer.from(
          JSON.stringify({ path: '.ax/routines/r.md', payload: { x: 1 } }),
        ),
      }),
      res,
    );
    expect(captured.status).toBe(200);
    expect(fired).toEqual({
      agentId: 'agt_a',
      path: '.ax/routines/r.md',
      payload: { x: 1 },
      source: 'manual',
    });
    expect(captured.body).toEqual({
      fireId: 7,
      status: 'ok',
      conversationId: 'cnv_x',
    });
    await harness.close({ onError: () => {} });
  });

  it('GET /settings/routines/:agentId/fires returns 403 when actor does not own the agent', async () => {
    const { harness, handlers } = await makeHarnessWith({
      resolveFailure: new PluginError({
        code: 'forbidden',
        plugin: 'test',
        message: 'no',
      }),
    });
    const handler = handlers.get('/settings/routines/:agentId/fires')!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({
        params: { agentId: 'agt_a' },
        query: { path: '.ax/routines/r.md' },
      }),
      res,
    );
    expect(captured.status).toBe(403);
    await harness.close({ onError: () => {} });
  });

  it('POST /settings/routines/:agentId/fire returns 403 when actor does not own the agent', async () => {
    let fired = false;
    const { harness, handlers } = await makeHarnessWith({
      resolveFailure: new PluginError({
        code: 'forbidden',
        plugin: 'test',
        message: 'no',
      }),
      fireNow: async () => {
        fired = true;
        return { fireId: 1, status: 'ok', conversationId: null };
      },
    });
    const handler = handlers.get('/settings/routines/:agentId/fire')!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({
        params: { agentId: 'agt_a' },
        body: Buffer.from(JSON.stringify({ path: '.ax/routines/r.md' })),
      }),
      res,
    );
    expect(captured.status).toBe(403);
    expect(fired).toBe(false); // ACL gate runs BEFORE routines:fire-now.
    await harness.close({ onError: () => {} });
  });

  it('GET /settings/routines/:agentId/fires rethrows when agents:resolve fails with a non-ACL error', async () => {
    // 'init-failed' is an infra failure, NOT an ACL denial. The route must
    // surface it (rethrow past writeServiceError, which only maps
    // forbidden / not-found / invalid-payload) rather than mask it as 403.
    const { harness, handlers } = await makeHarnessWith({
      resolveFailure: new PluginError({
        code: 'init-failed',
        plugin: 'test',
        message: 'bus broken',
      }),
    });
    const handler = handlers.get('/settings/routines/:agentId/fires')!;
    const { res, captured } = makeRes();
    await expect(
      handler(
        makeReq({
          params: { agentId: 'agt_a' },
          query: { path: '.ax/routines/r.md' },
        }),
        res,
      ),
    ).rejects.toThrow('bus broken');
    // No HTTP response written by writeServiceError — 'init-failed' isn't in
    // its mapped set, so it returns false and the handler rethrows. The
    // http-server's 500 handler picks it up at the top level.
    expect(captured.status).toBeUndefined();
    await harness.close({ onError: () => {} });
  });

  it('POST /settings/routines/:agentId/fire rethrows when agents:resolve fails with a non-ACL error', async () => {
    let fired = false;
    const { harness, handlers } = await makeHarnessWith({
      resolveFailure: new PluginError({
        code: 'init-failed',
        plugin: 'test',
        message: 'bus broken',
      }),
      fireNow: async () => {
        fired = true;
        return { fireId: 1, status: 'ok', conversationId: null };
      },
    });
    const handler = handlers.get('/settings/routines/:agentId/fire')!;
    const { res, captured } = makeRes();
    await expect(
      handler(
        makeReq({
          params: { agentId: 'agt_a' },
          body: Buffer.from(JSON.stringify({ path: '.ax/routines/r.md' })),
        }),
        res,
      ),
    ).rejects.toThrow('bus broken');
    expect(captured.status).toBeUndefined();
    expect(fired).toBe(false); // ACL gate ran first and faulted.
    await harness.close({ onError: () => {} });
  });

  it('GET /settings/routines rethrows when agents:resolve fails with a non-ACL error during list filtering', async () => {
    // The list handler runs isOwnedBy per routine. An infra failure on
    // agents:resolve while filtering must bubble out, not silently drop the
    // routine and return 200 with a partial list.
    const { harness, handlers } = await makeHarnessWith({
      routinesList: async () => ({
        routines: [{ agentId: 'agt_a' }, { agentId: 'agt_b' }],
      }),
      resolveFailure: new PluginError({
        code: 'no-service',
        plugin: 'test',
        message: 'agents plugin not loaded',
      }),
    });
    const handler = handlers.get('/settings/routines')!;
    const { res, captured } = makeRes();
    await expect(handler(makeReq(), res)).rejects.toThrow(
      'agents plugin not loaded',
    );
    expect(captured.status).toBeUndefined();
    await harness.close({ onError: () => {} });
  });

  it('POST /settings/routines/:agentId/fire rejects malformed body with 400', async () => {
    const { harness, handlers } = await makeHarnessWith({});
    const handler = handlers.get('/settings/routines/:agentId/fire')!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({
        params: { agentId: 'agt_a' },
        // strict schema: extra 'source' field rejects.
        body: Buffer.from(
          JSON.stringify({ path: '.ax/routines/r.md', source: 'tick' }),
        ),
      }),
      res,
    );
    expect(captured.status).toBe(400);
    await harness.close({ onError: () => {} });
  });
});

// ---------------------------------------------------------------------------
// /admin/routines/defaults* — admin-only CRUD over the default routines table.
//
// Auth model differs from /settings/routines*: requireAdmin (isAdmin=true) is
// gated BEFORE any service call. 401 if unauthenticated, 403 if authed-but-
// not-admin. There's no per-row owner ACL — default routines are fleet-wide.
// ---------------------------------------------------------------------------

/** Helper: build a seeded defaults map with one "heartbeat" entry, mirroring
 *  what the migration's seed does in prod. */
function seedDefaults(): Map<string, DefaultRoutineDetailMock> {
  const m = new Map<string, DefaultRoutineDetailMock>();
  m.set('default-heartbeat-2026-05-19', {
    defaultRoutineId: 'default-heartbeat-2026-05-19',
    name: 'heartbeat',
    description: 'daily check-in',
    trigger: { kind: 'interval', every: '24h' },
    enabled: true,
    updatedAt: '2026-05-19T00:00:00.000Z',
    sourceMd: '---\nname: heartbeat\n---\nbody',
    silenceToken: 'HEARTBEAT_OK',
    silenceMax: 300,
    conversation: 'shared',
    activeHours: null,
    promptBody: 'body',
  });
  return m;
}

const VALID_INTERVAL_MD = [
  '---',
  'name: demo',
  'description: a demo default routine',
  'trigger:',
  '  kind: interval',
  '  every: "5m"',
  '---',
  'do the thing',
  '',
].join('\n');

const WEBHOOK_TRIGGER_MD = [
  '---',
  'name: webhooky',
  'description: a webhook routine that should reject',
  'trigger:',
  '  kind: webhook',
  '---',
  'do the thing',
  '',
].join('\n');

describe('admin /admin/routines/defaults*', () => {
  it('GET /admin/routines/defaults returns the seeded heartbeat in defaults[]', async () => {
    const { harness, handlersByMethod } = await makeHarnessWith({
      authedUser: { id: 'admin1', isAdmin: true },
      defaults: seedDefaults(),
    });
    const handler = handlersByMethod.get('GET /admin/routines/defaults');
    expect(handler).toBeDefined();
    const { res, captured } = makeRes();
    await handler!(makeReq(), res);
    expect(captured.status).toBe(200);
    const body = captured.body as { defaults: Array<{ name: string }> };
    expect(body.defaults.map((d) => d.name)).toContain('heartbeat');
    await harness.close({ onError: () => {} });
  });

  it('GET /admin/routines/defaults/:id returns full detail', async () => {
    const { harness, handlersByMethod } = await makeHarnessWith({
      authedUser: { id: 'admin1', isAdmin: true },
      defaults: seedDefaults(),
    });
    const handler = handlersByMethod.get('GET /admin/routines/defaults/:id')!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({ params: { id: 'default-heartbeat-2026-05-19' } }),
      res,
    );
    expect(captured.status).toBe(200);
    const detail = captured.body as { name: string; sourceMd: string };
    expect(detail.name).toBe('heartbeat');
    expect(detail.sourceMd.length).toBeGreaterThan(0);
    await harness.close({ onError: () => {} });
  });

  it('GET /admin/routines/defaults/:id returns 404 on miss', async () => {
    const { harness, handlersByMethod } = await makeHarnessWith({
      authedUser: { id: 'admin1', isAdmin: true },
      defaults: new Map(),
    });
    const handler = handlersByMethod.get('GET /admin/routines/defaults/:id')!;
    const { res, captured } = makeRes();
    await handler(makeReq({ params: { id: 'does-not-exist' } }), res);
    expect(captured.status).toBe(404);
    await harness.close({ onError: () => {} });
  });

  it('POST /admin/routines/defaults with valid interval sourceMd returns 201 and persists', async () => {
    const { harness, handlersByMethod, defaults } = await makeHarnessWith({
      authedUser: { id: 'admin1', isAdmin: true },
      defaults: new Map(),
    });
    const handler = handlersByMethod.get('POST /admin/routines/defaults')!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({
        body: Buffer.from(JSON.stringify({ sourceMd: VALID_INTERVAL_MD })),
      }),
      res,
    );
    expect(captured.status).toBe(201);
    const body = captured.body as {
      defaultRoutineId: string;
      created: boolean;
    };
    expect(body.created).toBe(true);
    expect(body.defaultRoutineId).toBe('default-demo-test');
    // Side-effect: the mock store now holds the new row.
    expect(defaults.has('default-demo-test')).toBe(true);
    await harness.close({ onError: () => {} });
  });

  it('POST /admin/routines/defaults with webhook trigger surfaces 400 with code', async () => {
    const { harness, handlersByMethod } = await makeHarnessWith({
      authedUser: { id: 'admin1', isAdmin: true },
      defaults: new Map(),
    });
    const handler = handlersByMethod.get('POST /admin/routines/defaults')!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({
        body: Buffer.from(JSON.stringify({ sourceMd: WEBHOOK_TRIGGER_MD })),
      }),
      res,
    );
    expect(captured.status).toBe(400);
    const body = captured.body as { error: string; code?: string };
    expect(body.code).toBe('default-trigger-webhook-not-supported');
    expect(body.error).toMatch(/webhook/i);
    await harness.close({ onError: () => {} });
  });

  it('POST /admin/routines/defaults with malformed sourceMd returns 400', async () => {
    const { harness, handlersByMethod } = await makeHarnessWith({
      authedUser: { id: 'admin1', isAdmin: true },
      defaults: new Map(),
    });
    const handler = handlersByMethod.get('POST /admin/routines/defaults')!;
    const { res, captured } = makeRes();
    // No frontmatter `name:` → our mock throws invalid-routine-md.
    await handler(
      makeReq({
        body: Buffer.from(
          JSON.stringify({ sourceMd: '# just a heading\n' }),
        ),
      }),
      res,
    );
    expect(captured.status).toBe(400);
    const body = captured.body as { error: string; code?: string };
    expect(body.code).toBe('invalid-routine-md');
    await harness.close({ onError: () => {} });
  });

  it('POST /admin/routines/defaults rejects empty sourceMd via zod (400)', async () => {
    // The strict body schema requires sourceMd to be a non-empty string;
    // a body of `{}` fails zod BEFORE reaching the upsert hook, so this
    // test verifies the route's own validation rather than the service.
    const { harness, handlersByMethod } = await makeHarnessWith({
      authedUser: { id: 'admin1', isAdmin: true },
      defaults: new Map(),
    });
    const handler = handlersByMethod.get('POST /admin/routines/defaults')!;
    const { res, captured } = makeRes();
    await handler(makeReq({ body: Buffer.from(JSON.stringify({})) }), res);
    expect(captured.status).toBe(400);
    await harness.close({ onError: () => {} });
  });

  it('PUT /admin/routines/defaults/:id with valid sourceMd returns 200 and updates', async () => {
    const seeded = new Map<string, DefaultRoutineDetailMock>();
    seeded.set('default-demo-test', {
      defaultRoutineId: 'default-demo-test',
      name: 'demo',
      description: 'old',
      trigger: { kind: 'interval', every: '5m' },
      enabled: true,
      updatedAt: '2026-05-19T00:00:00.000Z',
      sourceMd: '---\nname: demo\n---\nold',
      silenceToken: null,
      silenceMax: 300,
      conversation: 'per-fire',
      activeHours: null,
      promptBody: 'old',
    });
    const { harness, handlersByMethod, defaults } = await makeHarnessWith({
      authedUser: { id: 'admin1', isAdmin: true },
      defaults: seeded,
    });
    const handler = handlersByMethod.get('PUT /admin/routines/defaults/:id')!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({
        params: { id: 'default-demo-test' },
        body: Buffer.from(JSON.stringify({ sourceMd: VALID_INTERVAL_MD })),
      }),
      res,
    );
    expect(captured.status).toBe(200);
    const body = captured.body as {
      defaultRoutineId: string;
      created: boolean;
    };
    expect(body.defaultRoutineId).toBe('default-demo-test');
    expect(body.created).toBe(false);
    // Side-effect: the row was updated (sourceMd swapped in).
    expect(defaults.get('default-demo-test')?.sourceMd).toContain(
      'a demo default routine',
    );
    await harness.close({ onError: () => {} });
  });

  it('PUT /admin/routines/defaults/:id rejects id mismatch with 400', async () => {
    const { harness, handlersByMethod } = await makeHarnessWith({
      authedUser: { id: 'admin1', isAdmin: true },
      defaults: new Map(),
    });
    const handler = handlersByMethod.get('PUT /admin/routines/defaults/:id')!;
    const { res, captured } = makeRes();
    // PUT-path id is 'wrong-id', body sourceMd computes id 'default-demo-test'.
    await handler(
      makeReq({
        params: { id: 'wrong-id' },
        body: Buffer.from(JSON.stringify({ sourceMd: VALID_INTERVAL_MD })),
      }),
      res,
    );
    expect(captured.status).toBe(400);
    await harness.close({ onError: () => {} });
  });

  it('DELETE /admin/routines/defaults/:id returns 204 and drops the row', async () => {
    const seeded = seedDefaults();
    const { harness, handlersByMethod, defaults } = await makeHarnessWith({
      authedUser: { id: 'admin1', isAdmin: true },
      defaults: seeded,
    });
    const handler = handlersByMethod.get(
      'DELETE /admin/routines/defaults/:id',
    )!;
    const { res, captured } = makeRes();
    await handler(
      makeReq({ params: { id: 'default-heartbeat-2026-05-19' } }),
      res,
    );
    expect(captured.status).toBe(204);
    expect(defaults.has('default-heartbeat-2026-05-19')).toBe(false);
    await harness.close({ onError: () => {} });
  });

  it('Unauthenticated GET /admin/routines/defaults returns 401', async () => {
    const { harness, handlersByMethod } = await makeHarnessWith({
      authMode: { kind: 'unauthenticated' },
      defaults: seedDefaults(),
    });
    const handler = handlersByMethod.get('GET /admin/routines/defaults')!;
    const { res, captured } = makeRes();
    await handler(makeReq(), res);
    expect(captured.status).toBe(401);
    await harness.close({ onError: () => {} });
  });

  it('Non-admin authenticated GET /admin/routines/defaults returns 403', async () => {
    const { harness, handlersByMethod } = await makeHarnessWith({
      authedUser: { id: 'u1', isAdmin: false },
      defaults: seedDefaults(),
    });
    const handler = handlersByMethod.get('GET /admin/routines/defaults')!;
    const { res, captured } = makeRes();
    await handler(makeReq(), res);
    expect(captured.status).toBe(403);
    await harness.close({ onError: () => {} });
  });
});
