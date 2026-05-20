import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import {
  ALLOWED_SETTINGS,
  createSettingsHandlers,
  registerAdminSettingsRoutes,
  type RouteRequest,
  type RouteResponse,
} from '../routes.js';

// ---------------------------------------------------------------------------
// /admin/settings/:key handler tests.
//
// In-process bus, hand-rolled `auth:require-user` + `storage:get` / `storage:set`
// stubs so we don't pull in the real storage plugin for these route checks.
// ---------------------------------------------------------------------------

function mkRes(): {
  res: RouteResponse;
  statusOf: () => number;
  bodyOf: () => unknown;
} {
  let _status = 200;
  let _body: unknown = undefined;
  const res: RouteResponse = {
    status(n: number) {
      _status = n;
      return res;
    },
    json(v: unknown) {
      _body = v;
    },
    text(s: string) {
      _body = s;
    },
    end() {},
  };
  return {
    res,
    statusOf: () => _status,
    bodyOf: () => _body,
  };
}

function mkReq(opts: {
  body?: unknown;
  params?: Record<string, string>;
}): RouteRequest {
  return {
    headers: {},
    body:
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(opts.body)),
    cookies: {},
    query: {},
    params: opts.params ?? {},
    signedCookie: () => null,
  };
}

function makeBus(
  authedUser: { id: string; isAdmin: boolean } | null,
  initialStorage: Map<string, Uint8Array> = new Map(),
): { bus: HookBus; storage: Map<string, Uint8Array> } {
  const bus = new HookBus();
  if (authedUser !== null) {
    bus.registerService(
      'auth:require-user',
      'test',
      async (_ctx, _input) => ({ user: authedUser }),
    );
  } else {
    bus.registerService('auth:require-user', 'test', async () => {
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'test',
        message: 'no cookie',
      });
    });
  }
  bus.registerService<
    { key: string },
    { value: Uint8Array | undefined }
  >('storage:get', 'test', async (_ctx, input) => ({
    value: initialStorage.get(input.key),
  }));
  bus.registerService<
    { key: string; value: Uint8Array },
    Record<string, never>
  >('storage:set', 'test', async (_ctx, input) => {
    initialStorage.set(input.key, input.value);
    return {};
  });
  return { bus, storage: initialStorage };
}

describe('admin-settings handlers', () => {
  // ---- GET /admin/settings/:key -----------------------------------------

  it('GET: returns { value: null } when storage is empty', async () => {
    const { bus } = makeBus({ id: 'admin', isAdmin: true });
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.get(mkReq({ params: { key: 'fast-model' } }), res);
    expect(statusOf()).toBe(200);
    expect(bodyOf()).toEqual({ value: null });
  });

  it('GET: returns the decoded UTF-8 string when storage has bytes', async () => {
    const seed = new Map<string, Uint8Array>([
      ['settings:fast-model', new TextEncoder().encode('anthropic/claude-haiku')],
    ]);
    const { bus } = makeBus({ id: 'admin', isAdmin: true }, seed);
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.get(mkReq({ params: { key: 'fast-model' } }), res);
    expect(statusOf()).toBe(200);
    expect(bodyOf()).toEqual({ value: 'anthropic/claude-haiku' });
  });

  it('GET: returns 404 for an unknown setting key', async () => {
    const { bus } = makeBus({ id: 'admin', isAdmin: true });
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.get(mkReq({ params: { key: 'not-a-real-setting' } }), res);
    expect(statusOf()).toBe(404);
    expect((bodyOf() as { error: string }).error).toBe('unknown-setting');
  });

  it('GET: rejects prototype keys (constructor / toString / __proto__) with 404', async () => {
    // Defense-in-depth: own-property check on the allowlist must NOT let
    // prototype keys resolve to a storage key.
    const { bus, storage } = makeBus({ id: 'admin', isAdmin: true });
    const handlers = createSettingsHandlers({ bus });
    for (const proto of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const { res, statusOf, bodyOf } = mkRes();
      await handlers.get(mkReq({ params: { key: proto } }), res);
      expect(statusOf()).toBe(404);
      expect((bodyOf() as { error: string }).error).toBe('unknown-setting');
    }
    expect(storage.size).toBe(0);
  });

  it('GET: non-admin gets 403', async () => {
    const { bus } = makeBus({ id: 'alice', isAdmin: false });
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.get(mkReq({ params: { key: 'fast-model' } }), res);
    expect(statusOf()).toBe(403);
  });

  it('GET: unauthenticated gets 401', async () => {
    const { bus } = makeBus(null);
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.get(mkReq({ params: { key: 'fast-model' } }), res);
    expect(statusOf()).toBe(401);
  });

  it('GET: returns null when stored bytes are not valid UTF-8', async () => {
    // 0xFF is invalid as a leading byte in UTF-8.
    const seed = new Map<string, Uint8Array>([
      ['settings:fast-model', new Uint8Array([0xff, 0xff])],
    ]);
    const { bus } = makeBus({ id: 'admin', isAdmin: true }, seed);
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.get(mkReq({ params: { key: 'fast-model' } }), res);
    expect(statusOf()).toBe(200);
    expect(bodyOf()).toEqual({ value: null });
  });

  // ---- PUT /admin/settings/:key -----------------------------------------

  it('PUT: stores the value and returns 204', async () => {
    const { bus, storage } = makeBus({ id: 'admin', isAdmin: true });
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.put(
      mkReq({
        params: { key: 'fast-model' },
        body: { value: 'anthropic/claude-sonnet-4-6' },
      }),
      res,
    );
    expect(statusOf()).toBe(204);
    expect(
      new TextDecoder().decode(storage.get('settings:fast-model')),
    ).toBe('anthropic/claude-sonnet-4-6');
  });

  it('PUT: overwrites an existing value', async () => {
    const seed = new Map<string, Uint8Array>([
      ['settings:fast-model', new TextEncoder().encode('old')],
    ]);
    const { bus, storage } = makeBus({ id: 'admin', isAdmin: true }, seed);
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.put(
      mkReq({
        params: { key: 'fast-model' },
        body: { value: 'new' },
      }),
      res,
    );
    expect(statusOf()).toBe(204);
    expect(new TextDecoder().decode(storage.get('settings:fast-model'))).toBe('new');
  });

  it('PUT: rejects an unknown setting key with 404', async () => {
    const { bus, storage } = makeBus({ id: 'admin', isAdmin: true });
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.put(
      mkReq({
        params: { key: 'not-a-real-setting' },
        body: { value: 'x' },
      }),
      res,
    );
    expect(statusOf()).toBe(404);
    expect(storage.size).toBe(0);
  });

  it('PUT: rejects missing value with 400', async () => {
    const { bus } = makeBus({ id: 'admin', isAdmin: true });
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.put(
      mkReq({ params: { key: 'fast-model' }, body: {} }),
      res,
    );
    expect(statusOf()).toBe(400);
  });

  it('PUT: rejects empty-string value with 400', async () => {
    const { bus } = makeBus({ id: 'admin', isAdmin: true });
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.put(
      mkReq({ params: { key: 'fast-model' }, body: { value: '' } }),
      res,
    );
    expect(statusOf()).toBe(400);
  });

  it('PUT: rejects a value longer than the cap with 400', async () => {
    const { bus } = makeBus({ id: 'admin', isAdmin: true });
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf } = mkRes();
    const longValue = 'x'.repeat(257);
    await handlers.put(
      mkReq({ params: { key: 'fast-model' }, body: { value: longValue } }),
      res,
    );
    expect(statusOf()).toBe(400);
  });

  it('PUT: non-admin gets 403 (no storage:set call)', async () => {
    const { bus, storage } = makeBus({ id: 'alice', isAdmin: false });
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.put(
      mkReq({
        params: { key: 'fast-model' },
        body: { value: 'whatever' },
      }),
      res,
    );
    expect(statusOf()).toBe(403);
    expect(storage.size).toBe(0);
  });

  it('PUT: unauthenticated gets 401', async () => {
    const { bus } = makeBus(null);
    const handlers = createSettingsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.put(
      mkReq({
        params: { key: 'fast-model' },
        body: { value: 'whatever' },
      }),
      res,
    );
    expect(statusOf()).toBe(401);
  });

  it('PUT: rejects invalid JSON with 400', async () => {
    const { bus } = makeBus({ id: 'admin', isAdmin: true });
    const handlers = createSettingsHandlers({ bus });
    const req: RouteRequest = {
      headers: {},
      body: Buffer.from('not-json-{'),
      cookies: {},
      query: {},
      params: { key: 'fast-model' },
      signedCookie: () => null,
    };
    const { res, statusOf } = mkRes();
    await handlers.put(req, res);
    expect(statusOf()).toBe(400);
  });

  // ---- Atomic route registration ---------------------------------------

  it('registerAdminSettingsRoutes unwinds already-mounted routes when a later call fails', async () => {
    // Stand up a fake http:register-route service that succeeds for the
    // first N-1 invocations and throws on the last. The helper must
    // unmount the earlier ones before propagating the error so the
    // running system never sees half-registered routes.
    const bus = new HookBus();
    const calls: Array<{ method: string; path: string }> = [];
    const unmounts: string[] = [];
    let invocation = 0;
    bus.registerService<
      { method: string; path: string },
      { unregister: () => void }
    >('http:register-route', 'test', async (_ctx, input) => {
      calls.push({ method: input.method, path: input.path });
      invocation += 1;
      if (invocation === 2) {
        throw new PluginError({
          code: 'unknown',
          plugin: 'test',
          message: 'second registration blew up',
        });
      }
      return {
        unregister: () => {
          unmounts.push(input.path);
        },
      };
    });

    const initCtx = makeAgentContext({
      sessionId: 's',
      agentId: 'test',
      userId: 'system',
    });

    await expect(registerAdminSettingsRoutes(bus, initCtx)).rejects.toThrow(
      /second registration blew up/,
    );
    // Both routes were attempted; the first one was unmounted on failure.
    expect(calls).toHaveLength(2);
    expect(unmounts).toEqual([calls[0]!.path]);
  });

  // ---- Allowlist contract ----------------------------------------------

  it('ALLOWED_SETTINGS includes fast-model mapped to settings:fast-model', () => {
    expect(ALLOWED_SETTINGS['fast-model']).toBe('settings:fast-model');
  });

  it('storage_key namespace check: every allowed key maps to a settings: prefix', () => {
    for (const [, storageKey] of Object.entries(ALLOWED_SETTINGS)) {
      expect(storageKey.startsWith('settings:')).toBe(true);
    }
    // Reference makeAgentContext to keep the import live in case the
    // module is refactored to use it; otherwise unused import lint fires.
    void makeAgentContext;
  });
});
