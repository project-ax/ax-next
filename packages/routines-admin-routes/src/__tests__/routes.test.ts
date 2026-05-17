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

interface MockServices {
  authedUser?: { id: string; isAdmin: boolean };
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
}

async function makeHarnessWith(opts: MockServices) {
  const handlers = new Map<string, Handler>();
  const authedUser = opts.authedUser ?? { id: 'u1', isAdmin: false };
  const harness = await createTestHarness({
    services: {
      'http:register-route': async (_ctx, input: unknown) => {
        const i = input as { path: string; handler: Handler };
        handlers.set(i.path, i.handler);
        return { unregister: () => {} };
      },
      'auth:require-user': async () => ({ user: authedUser }),
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
    },
    plugins: [createRoutinesAdminRoutesPlugin()],
  });
  return { harness, handlers };
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
