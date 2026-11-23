import { describe, it, expect } from 'vitest';
import { HookBus, PluginError } from '@ax/core';
import {
  createConnectorRouteHandlers,
  registerAdminConnectorRoutes,
  registerUserConnectorRoutes,
  type RouteRequest,
  type RouteResponse,
} from '../admin-routes.js';
import { makeAgentContext } from '@ax/core';

// POST /admin/connectors/pin-images — bare HookBus (no Docker), stubbed auth.
const D = 'sha256:' + 'b'.repeat(64);

type Actor = { id: string; isAdmin: boolean } | null;

function req(body: unknown): RouteRequest {
  return {
    headers: {},
    body: typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body)),
    cookies: {},
    query: {},
    params: {},
    signedCookie: () => null,
  };
}

function res(): { r: RouteResponse; out: { status: number; body: unknown } } {
  const out = { status: 0, body: undefined as unknown };
  const r: RouteResponse = {
    status(n) {
      out.status = n;
      return r;
    },
    json(v) {
      out.body = v;
    },
    text(s) {
      out.body = s;
    },
    end() {},
  };
  return { r, out };
}

function setup(actor: Actor, fetchImpl?: typeof fetch) {
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'auth-stub', async () => {
    if (actor === null) {
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'auth-stub',
        hookName: 'auth:require-user',
        message: 'no session',
      });
    }
    return { user: actor };
  });
  return createConnectorRouteHandlers({ bus, mode: 'admin', ...(fetchImpl && { fetchImpl }) });
}

const okFetch = (async () =>
  new Response(null, { status: 200, headers: { 'docker-content-digest': D } })) as typeof fetch;

describe('POST /admin/connectors/pin-images', () => {
  it('a non-admin gets 403 and no registry call is made', async () => {
    let called = 0;
    const h = setup(
      { id: 'u', isAdmin: false },
      (async () => {
        called++;
        return new Response(null);
      }) as typeof fetch,
    );
    const { r, out } = res();
    await h.pinImages(req({ images: ['mongo:4.4'] }), r);
    expect(out).toEqual({ status: 403, body: { error: 'forbidden' } });
    expect(called).toBe(0);
  });

  it('signed-out gets 401', async () => {
    const h = setup(null);
    const { r, out } = res();
    await h.pinImages(req({ images: [] }), r);
    expect(out.status).toBe(401);
  });

  it('an admin gets per-image results, errors included', async () => {
    const h = setup({ id: 'a', isAdmin: true }, okFetch);
    const { r, out } = res();
    await h.pinImages(req({ images: ['mongo:4.4', '10.0.0.1/x:1'] }), r);
    expect(out.status).toBe(200);
    const results = (out.body as { results: Array<Record<string, string>> }).results;
    expect(results[0]).toEqual({ image: 'mongo:4.4', pinned: `mongo@${D}` });
    expect(results[1]?.image).toBe('10.0.0.1/x:1');
    expect(results[1]?.error).toBeTruthy();
  });

  it.each([
    ['not json', 'nope'],
    ['no images', {}],
    ['non-string', { images: [1] }],
    ['too many', { images: Array.from({ length: 33 }, () => 'a:1') }],
  ])('rejects a bad body (400): %s', async (_n, body) => {
    const h = setup({ id: 'a', isAdmin: true }, okFetch);
    const { r, out } = res();
    await h.pinImages(req(body), r);
    expect(out.status).toBe(400);
  });

  it('is registered on the admin bundle only', async () => {
    const bus = new HookBus();
    const paths: string[] = [];
    bus.registerService('http:register-route', 't', async (_c, i: { method: string; path: string }) => {
      paths.push(`${i.method} ${i.path}`);
      return { unregister: () => {} };
    });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await registerAdminConnectorRoutes(bus, ctx);
    expect(paths).toContain('POST /admin/connectors/pin-images');
    paths.length = 0;
    await registerUserConnectorRoutes(bus, ctx);
    expect(paths.filter((p) => p.includes('pin-images'))).toEqual([]);
  });
});
