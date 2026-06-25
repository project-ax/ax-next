import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { createBrandingPlugin } from '../plugin.js';
import {
  registerBrandingRoutes,
  BRANDING_BODY_MAX_BYTES,
} from '../routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

// --- request / response fakes -------------------------------------------------

interface CapturedRes {
  res: RouteResponse;
  statusOf: () => number;
  jsonOf: () => unknown;
  headersOf: () => Record<string, string>;
  bodyOf: () => Buffer | undefined;
}

function mkRes(): CapturedRes {
  let status = 200;
  let json: unknown;
  let bodyBuf: Buffer | undefined;
  const headers: Record<string, string> = {};
  const res: RouteResponse = {
    status(n) {
      status = n;
      return res;
    },
    header(name, value) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    json(v) {
      json = v;
    },
    text() {},
    body(buf, ct) {
      bodyBuf = buf;
      if (ct !== undefined && headers['content-type'] === undefined) {
        headers['content-type'] = ct;
      }
    },
    end() {},
  };
  return {
    res,
    statusOf: () => status,
    jsonOf: () => json,
    headersOf: () => headers,
    bodyOf: () => bodyBuf,
  };
}

function mkReq(opts: {
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}): RouteRequest {
  return {
    headers: opts.headers ?? {},
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

// --- in-process bus with stubbed kernel hooks --------------------------------

interface CapturedRoute {
  method: string;
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  maxBodyBytes?: number;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
const SVG = new TextEncoder().encode('<svg xmlns="http://x"><rect/></svg>');

function harness(opts?: { auth?: { id: string; isAdmin: boolean } | 'throw' }) {
  const bus = new HookBus();
  let auth: { id: string; isAdmin: boolean } | 'throw' =
    opts?.auth ?? { id: 'admin', isAdmin: true };
  const storage = new Map<string, Uint8Array>();
  const blobs = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const routes: CapturedRoute[] = [];

  bus.registerService('auth:require-user', 'test', async () => {
    if (auth === 'throw') {
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'test',
        message: 'no cookie',
      });
    }
    return { user: auth };
  });
  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get',
    'test',
    async (_ctx, input) => ({ value: storage.get(input.key) }),
  );
  bus.registerService<{ key: string; value: Uint8Array }, Record<string, never>>(
    'storage:set',
    'test',
    async (_ctx, input) => {
      storage.set(input.key, input.value);
      return {};
    },
  );
  bus.registerService<{ bytes: Uint8Array }, { sha256: string; size: number }>(
    'blob:put',
    'test',
    async (_ctx, input) => {
      const sha = sha256(input.bytes);
      blobs.set(sha, input.bytes);
      return { sha256: sha, size: input.bytes.length };
    },
  );
  bus.registerService<
    { sha256: string },
    { bytes: Uint8Array } | { found: false }
  >('blob:get', 'test', async (_ctx, input) => {
    const got = blobs.get(input.sha256);
    return got === undefined ? { found: false } : { bytes: got };
  });
  bus.registerService<{ sha256: string }, Record<string, never>>(
    'blob:delete',
    'test',
    async (_ctx, input) => {
      deleted.push(input.sha256);
      blobs.delete(input.sha256);
      return {};
    },
  );
  bus.registerService<CapturedRoute, { unregister: () => void }>(
    'http:register-route',
    'test',
    async (_ctx, input) => {
      routes.push(input);
      return { unregister: () => {} };
    },
  );

  return {
    bus,
    storage,
    blobs,
    deleted,
    routes,
    setAuth: (a: { id: string; isAdmin: boolean } | 'throw') => {
      auth = a;
    },
  };
}

const ctx = makeAgentContext({
  sessionId: 'test',
  agentId: '@ax/branding',
  userId: 'system',
});

/** Register routes with a deterministic version clock and return an invoker. */
async function bootRoutes(h: ReturnType<typeof harness>) {
  let n = 0;
  await registerBrandingRoutes(h.bus, ctx, () => `V${++n}`);
  return async (
    method: string,
    path: string,
    opts: {
      body?: unknown;
      params?: Record<string, string>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<CapturedRes> => {
    const route = h.routes.find((r) => r.method === method && r.path === path);
    if (route === undefined) throw new Error(`no route ${method} ${path}`);
    const res = mkRes();
    await route.handler(mkReq(opts), res.res);
    return res;
  };
}

// --- tests -------------------------------------------------------------------

describe('GET /api/branding', () => {
  it('returns defaults when nothing is stored', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    const res = await call('GET', '/api/branding');
    expect(res.statusOf()).toBe(200);
    expect(res.jsonOf()).toEqual({
      name: '',
      logoType: 'full',
      light: false,
      dark: false,
      version: '',
    });
  });
});

describe('PUT /admin/branding — happy paths', () => {
  it('sets a light PNG and reflects it in the public GET', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    const put = await call('PUT', '/admin/branding', {
      body: {
        name: 'Canopy AI',
        logoType: 'icon',
        light: { contentType: 'image/png', dataBase64: b64(PNG_A) },
      },
    });
    expect(put.statusOf()).toBe(204);

    const get = await call('GET', '/api/branding');
    expect(get.jsonOf()).toEqual({
      name: 'Canopy AI',
      logoType: 'icon',
      light: true,
      dark: false,
      version: 'V1',
    });
  });

  it('serves the light logo with content-type + cache + nosniff headers', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    await call('PUT', '/admin/branding', {
      body: { light: { contentType: 'image/png', dataBase64: b64(PNG_A) } },
    });
    const res = await call('GET', '/api/branding/logo/:variant', {
      params: { variant: 'light' },
    });
    expect(res.statusOf()).toBe(200);
    const headers = res.headersOf();
    expect(headers['content-type']).toBe('image/png');
    expect(headers['cache-control']).toMatch(/max-age=/);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(res.bodyOf()).toEqual(Buffer.from(PNG_A));
  });

  it('serves SVG with a locked-down CSP + nosniff', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    await call('PUT', '/admin/branding', {
      body: { dark: { contentType: 'image/svg+xml', dataBase64: b64(SVG) } },
    });
    const res = await call('GET', '/api/branding/logo/:variant', {
      params: { variant: 'dark' },
    });
    expect(res.statusOf()).toBe(200);
    const headers = res.headersOf();
    expect(headers['content-type']).toBe('image/svg+xml');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['content-security-policy']).toContain('sandbox');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns 404 for an unset variant', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    const res = await call('GET', '/api/branding/logo/:variant', {
      params: { variant: 'dark' },
    });
    expect(res.statusOf()).toBe(404);
  });

  it('rejects a variant outside {light,dark} with 400', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    const res = await call('GET', '/api/branding/logo/:variant', {
      params: { variant: 'evil' },
    });
    expect(res.statusOf()).toBe(400);
  });

  it('leaves omitted fields unchanged', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    await call('PUT', '/admin/branding', {
      body: { name: 'First', light: { contentType: 'image/png', dataBase64: b64(PNG_A) } },
    });
    await call('PUT', '/admin/branding', { body: { name: 'Second' } });
    const get = await call('GET', '/api/branding');
    const wire = get.jsonOf() as { name: string; light: boolean };
    expect(wire.name).toBe('Second');
    expect(wire.light).toBe(true); // unchanged by the name-only PUT
  });
});

describe('PUT /admin/branding — blob lifecycle', () => {
  it('deletes the previous blob when a logo is replaced', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    await call('PUT', '/admin/branding', {
      body: { light: { contentType: 'image/png', dataBase64: b64(PNG_A) } },
    });
    await call('PUT', '/admin/branding', {
      body: { light: { contentType: 'image/png', dataBase64: b64(PNG_B) } },
    });
    expect(h.deleted).toContain(sha256(PNG_A));
    expect(h.deleted).not.toContain(sha256(PNG_B));
  });

  it('deletes the blob when a logo is cleared with null', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    await call('PUT', '/admin/branding', {
      body: { light: { contentType: 'image/png', dataBase64: b64(PNG_A) } },
    });
    await call('PUT', '/admin/branding', { body: { light: null } });
    const get = await call('GET', '/api/branding');
    expect((get.jsonOf() as { light: boolean }).light).toBe(false);
    expect(h.deleted).toContain(sha256(PNG_A));
  });

  it('does NOT delete a blob still referenced by the other variant', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    // Same bytes for both variants → same sha in the content-addressed store.
    await call('PUT', '/admin/branding', {
      body: {
        light: { contentType: 'image/png', dataBase64: b64(PNG_A) },
        dark: { contentType: 'image/png', dataBase64: b64(PNG_A) },
      },
    });
    await call('PUT', '/admin/branding', { body: { light: null } });
    expect(h.deleted).not.toContain(sha256(PNG_A));
    // dark still serves it
    const res = await call('GET', '/api/branding/logo/:variant', {
      params: { variant: 'dark' },
    });
    expect(res.statusOf()).toBe(200);
  });
});

describe('PUT /admin/branding — auth + validation', () => {
  it('returns 403 for a non-admin user', async () => {
    const h = harness({ auth: { id: 'u1', isAdmin: false } });
    const call = await bootRoutes(h);
    const res = await call('PUT', '/admin/branding', { body: { name: 'x' } });
    expect(res.statusOf()).toBe(403);
  });

  it('returns 401 when unauthenticated', async () => {
    const h = harness({ auth: 'throw' });
    const call = await bootRoutes(h);
    const res = await call('PUT', '/admin/branding', { body: { name: 'x' } });
    expect(res.statusOf()).toBe(401);
  });

  it('returns 422 when bytes do not match the declared content-type', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    const res = await call('PUT', '/admin/branding', {
      body: { light: { contentType: 'image/png', dataBase64: b64(JPEG) } },
    });
    expect(res.statusOf()).toBe(422);
  });

  it('returns 422 for a content-type outside the allowlist', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    const res = await call('PUT', '/admin/branding', {
      body: { light: { contentType: 'text/html', dataBase64: b64(PNG_A) } },
    });
    expect(res.statusOf()).toBe(422);
  });

  it('does not store anything when one of two logos fails validation', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    const res = await call('PUT', '/admin/branding', {
      body: {
        light: { contentType: 'image/png', dataBase64: b64(PNG_A) },
        dark: { contentType: 'image/png', dataBase64: b64(JPEG) }, // bad
      },
    });
    expect(res.statusOf()).toBe(422);
    expect(h.blobs.size).toBe(0); // light was NOT put before dark failed
    const get = await call('GET', '/api/branding');
    expect((get.jsonOf() as { light: boolean }).light).toBe(false);
  });

  it('rejects unknown body fields', async () => {
    const h = harness();
    const call = await bootRoutes(h);
    const res = await call('PUT', '/admin/branding', {
      body: { surprise: true },
    });
    expect(res.statusOf()).toBe(400);
  });
});

describe('plugin wiring', () => {
  it('registers the three routes with the right methods, paths, and body cap', async () => {
    const h = harness();
    const plugin = createBrandingPlugin();
    await plugin.init!({ bus: h.bus } as never);
    const sig = h.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(sig).toEqual([
      'GET /api/branding',
      'GET /api/branding/logo/:variant',
      'PUT /admin/branding',
    ]);
    const put = h.routes.find((r) => r.method === 'PUT');
    expect(put?.maxBodyBytes).toBe(BRANDING_BODY_MAX_BYTES);
    expect(BRANDING_BODY_MAX_BYTES).toBe(3 * 1024 * 1024);
  });
});
