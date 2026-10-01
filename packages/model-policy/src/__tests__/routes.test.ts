import { describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { createCatalog } from '../catalog.js';
import { createPolicyStore } from '../policy-store.js';
import { createHandlers, registerModelPolicyRoutes } from '../routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const OPUS = 'anthropic/claude-opus-4-7';
const KIMI = 'openrouter/moonshotai/kimi-k3';

function mkRes() {
  let status = 200;
  let json: unknown;
  const res: RouteResponse = {
    status(n) {
      status = n;
      return res;
    },
    header() {
      return res;
    },
    json(v) {
      json = v;
    },
    text() {},
    end() {},
  };
  return { res, statusOf: () => status, jsonOf: () => json };
}

function mkReq(opts: { body?: unknown; rawBody?: Buffer; query?: Record<string, string> } = {}): RouteRequest {
  return {
    headers: {},
    body:
      opts.rawBody ?? (opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body))),
    cookies: {},
    query: opts.query ?? {},
    params: {},
    signedCookie: () => null,
  };
}

function setup(auth: { id: string; isAdmin: boolean } | 'throw' = { id: 'admin-1', isAdmin: true }) {
  const bus = new HookBus();
  const storage = new Map<string, Uint8Array>();
  const captured: Array<{ method: string; path: string; handler: unknown; maxBodyBytes?: number }> = [];
  let who = auth;
  let openrouterCalls = 0;
  let lastUserId: string | undefined;
  bus.registerService('auth:require-user', 'test', async () => {
    if (who === 'throw') throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'no cookie' });
    return { user: who };
  });
  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>('storage:get', 'test', async (_c, i) => ({
    value: storage.get(i.key),
  }));
  bus.registerService<{ key: string; value: Uint8Array }, Record<string, never>>('storage:set', 'test', async (_c, i) => {
    storage.set(i.key, i.value);
    return {};
  });
  bus.registerService('http:register-route', 'test', async (_c, i) => {
    captured.push(i as never);
    return { unregister: () => {} };
  });
  bus.registerService('models:list-available:openrouter', 'test', async (c) => {
    openrouterCalls += 1;
    lastUserId = (c as { userId?: string }).userId;
    return { status: 'live', models: [{ ref: KIMI, label: 'Kimi K3' }] };
  });
  const store = createPolicyStore({ bus, builtin: { allowed: [OPUS, SONNET], default: SONNET }, ttlMs: 0 });
  const catalog = createCatalog({ bus, providers: [{ id: 'openrouter', name: 'OpenRouter' }], minRefreshMs: 0 });
  const handlers = createHandlers({ bus, store, catalog });
  return {
    bus,
    storage,
    captured,
    handlers,
    setAuth: (a: typeof auth) => (who = a),
    openrouterCalls: () => openrouterCalls,
    lastUserId: () => lastUserId,
  };
}

async function run(
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>,
  req: RouteRequest,
) {
  const r = mkRes();
  await handler(req, r.res);
  return r;
}

describe('admin gate', () => {
  it.each(['catalog', 'getPolicy', 'putPolicy'] as const)('%s → 401 without a session', async (name) => {
    const h = setup('throw');
    const r = await run(h.handlers[name], mkReq({ body: {} }));
    expect(r.statusOf()).toBe(401);
    expect(r.jsonOf()).toEqual({ error: 'unauthenticated' });
  });

  it.each(['catalog', 'getPolicy', 'putPolicy'] as const)('%s → 403 for a non-admin', async (name) => {
    const h = setup({ id: 'u1', isAdmin: false });
    const r = await run(h.handlers[name], mkReq({ body: {} }));
    expect(r.statusOf()).toBe(403);
    expect(r.jsonOf()).toEqual({ error: 'forbidden' });
  });
});

describe('GET /admin/models/policy', () => {
  it('returns the built-in policy before any save', async () => {
    const h = setup();
    const r = await run(h.handlers.getPolicy, mkReq());
    expect(r.statusOf()).toBe(200);
    expect(r.jsonOf()).toEqual({ source: 'builtin', version: 0, allowed: [OPUS, SONNET], default: SONNET });
  });
});

describe('PUT /admin/models/policy', () => {
  it('saves and returns the new policy, recording who saved it', async () => {
    const h = setup();
    const r = await run(h.handlers.putPolicy, mkReq({ body: { baseVersion: 0, allowed: [KIMI, SONNET], default: KIMI } }));
    expect(r.statusOf()).toBe(200);
    expect(r.jsonOf()).toMatchObject({ source: 'admin', version: 1, allowed: [KIMI, SONNET], default: KIMI, updatedBy: 'admin-1' });
    const again = await run(h.handlers.getPolicy, mkReq());
    expect(again.jsonOf()).toMatchObject({ version: 1, default: KIMI });
  });

  it.each([
    ['an empty selection', { baseVersion: 0, allowed: [], default: SONNET }, 'pick-at-least-one-model'],
    ['a Default that is not selected', { baseVersion: 0, allowed: [SONNET], default: OPUS }, 'default-not-selected'],
    ['a bare id', { baseVersion: 0, allowed: ['nope'], default: 'nope' }, 'invalid-model-ref'],
    ['a duplicate', { baseVersion: 0, allowed: [SONNET, SONNET], default: SONNET }, 'duplicate-model'],
  ])('400s on %s and writes nothing', async (_l, body, code) => {
    const h = setup();
    const r = await run(h.handlers.putPolicy, mkReq({ body }));
    expect(r.statusOf()).toBe(400);
    expect(r.jsonOf()).toMatchObject({ error: code });
    expect(h.storage.size).toBe(0);
  });

  it.each([
    ['a missing baseVersion', { allowed: [SONNET], default: SONNET }],
    ['a fractional baseVersion', { baseVersion: 0.5, allowed: [SONNET], default: SONNET }],
    ['a negative baseVersion', { baseVersion: -1, allowed: [SONNET], default: SONNET }],
    ['an unknown extra key', { baseVersion: 0, allowed: [SONNET], default: SONNET, extra: 1 }],
  ])('400s on %s', async (_l, body) => {
    const h = setup();
    const r = await run(h.handlers.putPolicy, mkReq({ body }));
    expect(r.statusOf()).toBe(400);
    expect(r.jsonOf()).toMatchObject({ error: 'invalid-payload' });
  });

  it('400s on invalid JSON and 413s on an oversized body', async () => {
    const h = setup();
    expect((await run(h.handlers.putPolicy, mkReq({ rawBody: Buffer.from('{nope') }))).statusOf()).toBe(400);
    const big = Buffer.alloc(256 * 1024 + 1, 0x20);
    expect((await run(h.handlers.putPolicy, mkReq({ rawBody: big }))).statusOf()).toBe(413);
  });

  it('409s on a stale baseVersion', async () => {
    const h = setup();
    await run(h.handlers.putPolicy, mkReq({ body: { baseVersion: 0, allowed: [SONNET], default: SONNET } }));
    const r = await run(h.handlers.putPolicy, mkReq({ body: { baseVersion: 0, allowed: [OPUS], default: OPUS } }));
    expect(r.statusOf()).toBe(409);
    expect(r.jsonOf()).toEqual({ error: 'stale-version' });
  });
});

describe('GET /admin/models/catalog', () => {
  it("lists providers, and looks up keys as the requesting admin (not a fixed 'system' user)", async () => {
    const h = setup();
    const r = await run(h.handlers.catalog, mkReq());
    expect(r.statusOf()).toBe(200);
    expect(r.jsonOf()).toMatchObject({ providers: [{ id: 'openrouter', status: 'live', models: [{ ref: KIMI }] }] });
    expect(h.lastUserId()).toBe('admin-1');
  });

  it('honours ?refresh=1', async () => {
    const h = setup();
    await run(h.handlers.catalog, mkReq());
    await run(h.handlers.catalog, mkReq());
    expect(h.openrouterCalls()).toBe(1); // cached
    await run(h.handlers.catalog, mkReq({ query: { refresh: '1' } }));
    expect(h.openrouterCalls()).toBe(2);
  });
});

describe('registerModelPolicyRoutes', () => {
  it('registers the three routes, with a 256 KiB cap on the PUT', async () => {
    const h = setup();
    const unregisters = await registerModelPolicyRoutes(
      h.bus,
      makeAgentContext({ sessionId: 'init', agentId: '@ax/model-policy', userId: 'system' }),
      h.handlers,
    );
    expect(unregisters).toHaveLength(3);
    expect(h.captured.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /admin/models/catalog',
      'GET /admin/models/policy',
      'PUT /admin/models/policy',
    ]);
    expect(h.captured.find((r) => r.method === 'PUT')?.maxBodyBytes).toBe(256 * 1024);
  });
});
