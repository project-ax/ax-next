import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import {
  createConnectorRouteHandlers,
  registerAdminConnectorRoutes,
  registerUserConnectorRoutes,
  type RouteRequest,
  type RouteResponse,
} from '../admin-routes.js';
import { DIRECTORY_OFF_BODY, DIRECTORY_SEARCH_HOOK } from '../directory-route.js';

// ---------------------------------------------------------------------------
// GET /admin/connectors/directory — the admin bridge to the
// `connectors:directory-search` hook. No Docker: a bare HookBus with stubs for
// `auth:require-user` and the directory hook.
// ---------------------------------------------------------------------------

type Actor = { id: string; isAdmin: boolean } | null;

function makeReq(query: Record<string, string> = {}): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query,
    params: {},
    signedCookie: () => null,
  };
}

function makeRes(): { res: RouteResponse; captured: { status: number; body: unknown } } {
  const captured = { status: 0, body: undefined as unknown };
  const res: RouteResponse = {
    status(n: number) {
      captured.status = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text(s: string) {
      captured.body = s;
    },
    end() {},
  };
  return { res, captured };
}

const ENTRY = {
  id: 'io.example/linear',
  title: 'Linear',
  description: 'Issues',
  publisher: 'example.io',
  publisherProof: 'domain' as const,
  url: 'https://mcp.example.io/mcp',
  auth: 'none' as const,
  version: '1.0.0',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function setup(opts: { actor: Actor; directory?: ((input: unknown) => unknown) | null }) {
  const bus = new HookBus();
  const calls: unknown[] = [];
  bus.registerService('auth:require-user', 'auth-stub', async () => {
    if (opts.actor === null) {
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'auth-stub',
        hookName: 'auth:require-user',
        message: 'no session',
      });
    }
    return { user: opts.actor };
  });
  if (opts.directory !== null) {
    const impl =
      opts.directory ??
      (() => ({ enabled: true, entries: [ENTRY], syncedAt: null, stale: false, verifiedOnly: true }));
    bus.registerService(
      DIRECTORY_SEARCH_HOOK,
      'directory-stub',
      async (_c: AgentContext, input: unknown) => {
        calls.push(input);
        return impl(input);
      },
    );
  }
  const handlers = createConnectorRouteHandlers({ bus, mode: 'admin' });
  return { bus, calls, handlers };
}

const admin: Actor = { id: 'root', isAdmin: true };

describe('GET /admin/connectors/directory', () => {
  it('401 when signed out', async () => {
    const { calls, handlers } = setup({ actor: null });
    const { res, captured } = makeRes();
    await handlers.directorySearch(makeReq({ q: 'x' }), res);
    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(calls).toHaveLength(0);
  });

  it('403 for a signed-in non-admin', async () => {
    const { calls, handlers } = setup({ actor: { id: 'u', isAdmin: false } });
    const { res, captured } = makeRes();
    await handlers.directorySearch(makeReq({ q: 'x' }), res);
    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({ error: 'forbidden' });
    expect(calls).toHaveLength(0);
  });

  it('admin: forwards q, cursor and a page size of 20 and returns the hook body', async () => {
    const { calls, handlers } = setup({ actor: admin });
    const { res, captured } = makeRes();
    await handlers.directorySearch(makeReq({ q: 'linear', cursor: 'eyJvIjoyMH0' }), res);
    expect(captured.status).toBe(200);
    expect(calls).toEqual([{ query: 'linear', limit: 20, cursor: 'eyJvIjoyMH0' }]);
    expect(captured.body).toEqual({
      enabled: true,
      entries: [ENTRY],
      syncedAt: null,
      stale: false,
      verifiedOnly: true,
    });
  });

  it('an empty or missing q still asks the hook', async () => {
    const { calls, handlers } = setup({ actor: admin });
    for (const query of [{}, { q: '' }, { q: '', cursor: '' }]) {
      const { res, captured } = makeRes();
      await handlers.directorySearch(makeReq(query), res);
      expect(captured.status).toBe(200);
    }
    expect(calls).toEqual([
      { query: '', limit: 20 },
      { query: '', limit: 20 },
      { query: '', limit: 20 },
    ]);
  });

  it('no directory plugin loaded: 200 with the off body', async () => {
    const { handlers } = setup({ actor: admin, directory: null });
    const { res, captured } = makeRes();
    await handlers.directorySearch(makeReq({ q: 'x' }), res);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual(DIRECTORY_OFF_BODY);
    expect(DIRECTORY_OFF_BODY).toEqual({
      enabled: false,
      entries: [],
      syncedAt: null,
      stale: false,
      verifiedOnly: false,
    });
  });

  it('q over 200 characters is 400 invalid-query and a malformed cursor is 400 invalid-cursor; the hook is not called', async () => {
    const { calls, handlers } = setup({ actor: admin });
    const long = makeRes();
    await handlers.directorySearch(makeReq({ q: 'a'.repeat(201) }), long.res);
    expect(long.captured.status).toBe(400);
    expect(long.captured.body).toEqual({ error: 'invalid-query' });
    // Exactly 200 is fine.
    const ok = makeRes();
    await handlers.directorySearch(makeReq({ q: 'a'.repeat(200) }), ok.res);
    expect(ok.captured.status).toBe(200);
    calls.length = 0;
    for (const cursor of ['a.b', 'a'.repeat(65), 'a b', '%']) {
      const { res, captured } = makeRes();
      await handlers.directorySearch(makeReq({ q: 'x', cursor }), res);
      expect(captured.status).toBe(400);
      expect(captured.body).toEqual({ error: 'invalid-cursor' });
    }
    expect(calls).toHaveLength(0);
  });

  it("a hook invalid-payload becomes 400 with the hook's fixed message", async () => {
    const { handlers } = setup({
      actor: admin,
      directory: () => {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: 'directory-stub',
          hookName: DIRECTORY_SEARCH_HOOK,
          message: 'cursor is not valid',
        });
      },
    });
    const { res, captured } = makeRes();
    await handlers.directorySearch(makeReq({ q: 'x' }), res);
    expect(captured.status).toBe(400);
    expect(captured.body).toEqual({ error: 'cursor is not valid' });
  });

  it('only contract fields reach the wire', async () => {
    const { handlers } = setup({
      actor: admin,
      directory: () => ({
        enabled: true,
        entries: [{ ...ENTRY, keyHeader: 'X-Api-Key', deprecated: true, remotes: [{ url: 'x' }] }],
        syncedAt: '2026-11-09T00:00:00.000Z',
        stale: true,
        verifiedOnly: false,
        nextCursor: 'abc',
        debug: { sql: 'select 1' },
      }),
    });
    const { res, captured } = makeRes();
    await handlers.directorySearch(makeReq({ q: 'x' }), res);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({
      enabled: true,
      entries: [{ ...ENTRY, keyHeader: 'X-Api-Key', deprecated: true }],
      syncedAt: '2026-11-09T00:00:00.000Z',
      stale: true,
      verifiedOnly: false,
      nextCursor: 'abc',
    });
    const body = captured.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('debug');
    expect((body.entries as Array<Record<string, unknown>>)[0]).not.toHaveProperty('remotes');
  });

  it('the admin bundle registers GET /admin/connectors/directory; the /settings bundle does not', async () => {
    const registered: string[] = [];
    const bus = new HookBus();
    bus.registerService(
      'http:register-route',
      'http-capture',
      async (_c: AgentContext, r: unknown) => {
        const route = r as { method: string; path: string };
        registered.push(`${route.method} ${route.path}`);
        return { unregister: () => {} };
      },
    );
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await registerAdminConnectorRoutes(bus, ctx);
    expect(registered).toContain('GET /admin/connectors/directory');
    registered.length = 0;
    await registerUserConnectorRoutes(bus, ctx);
    expect(registered.filter((r) => r.includes('directory'))).toEqual([]);
  });
});
