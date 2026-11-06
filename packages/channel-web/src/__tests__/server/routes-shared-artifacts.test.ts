// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAgentContext, PluginError, type HookBus, type Logger } from '@ax/core';
import {
  SHARED_LOOKUPS_PER_MINUTE,
  createSharedArtifactsRouteHandlers,
  registerSharedArtifactsRoutes,
  sharedArtifactRoutes,
} from '../../server/routes-shared-artifacts.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-attachments.js';

// ---------------------------------------------------------------------------
// The link-holder routes (/api/shared/:code…), on a stub bus. Whether a code
// resolves is @ax/attachments' job (tested there against a real store); here
// we pin what the routes add: sign-in first, a per-person limit, one 404 for
// every code that does not work, bodies that carry the current version only,
// and a code that never reaches a log line.
// ---------------------------------------------------------------------------

const CODE = 'Abcdefghijklmnopqrstuvwxyz012345';
const OTHER_CODE = 'ZZZZefghijklmnopqrstuvwxyz0123_-';
const SOURCE_PATH = 'secret-dir/reports/q3-draft.md';

interface LogLine {
  level: string;
  event: string;
  fields: Record<string, unknown> | undefined;
}
function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: string) =>
    (event: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, event, fields });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return { logger, lines };
}

function mkInitCtx() {
  const { logger, lines } = recordingLogger();
  return { ctx: makeAgentContext({ sessionId: 'init', agentId: 'test', userId: 'system', logger }), lines };
}

function mkReq(params: Record<string, string>, opts: { user?: string; body?: unknown } = {}): RouteRequest {
  return {
    headers: opts.user === undefined ? {} : { 'x-test-user': opts.user },
    body: opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body), 'utf8'),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}

interface Captured {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
}
function mkRes(): { res: RouteResponse; got: Captured } {
  const got: Captured = { status: 0, headers: {} };
  const res: RouteResponse = {
    status(n) {
      got.status = n;
      return res;
    },
    header(name, value) {
      got.headers[name.toLowerCase()] = value;
      return res;
    },
    json(v) {
      got.json = v;
    },
    text() {},
    body() {},
    end() {},
  };
  return { res, got };
}

type Stub = (input: unknown) => unknown;
/** A bus whose auth signs in whoever the `x-test-user` header names. */
function fakeBus(stubs: Record<string, Stub>) {
  const all: Record<string, Stub> = {
    'auth:require-user': (input) => {
      const user = (input as { req: RouteRequest }).req.headers['x-test-user'];
      if (typeof user !== 'string') {
        throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'no' });
      }
      return { user: { id: user, isAdmin: false } };
    },
    ...stubs,
  };
  const call = vi.fn(async (hook: string, _ctx: unknown, input: unknown) => {
    const fn = all[hook];
    if (!fn) throw new Error(`unexpected hook: ${hook}`);
    return fn(input);
  });
  return { bus: { call, hasService: (n: string) => n in all } as unknown as HookBus, call };
}

const notFound = (): never => {
  throw new PluginError({ code: 'not-found', plugin: '@ax/attachments', message: 'artifact not found' });
};

/** A store with one artifact behind CODE. Every other code is not found. */
function storeWith(over: { linkOn?: boolean; text?: string } = {}): Record<string, Stub> {
  const linkOn = over.linkOn ?? true;
  const bytes = new TextEncoder().encode(over.text ?? '# Q3\n\nNumbers.');
  const ok = (input: unknown) => linkOn && (input as { shareCode?: unknown }).shareCode === CODE;
  return {
    'artifacts:resolve-share-code': (input) => {
      if (!ok(input)) notFound();
      return {
        artifact: {
          title: 'Q3 report',
          mediaType: 'text/markdown',
          kind: 'document',
          preview: 'markdown',
          extension: 'MD',
          sizeBytes: bytes.byteLength,
          updatedAt: '2026-11-02T00:00:00.000Z',
          agentName: 'Research bot',
          // What must never reach a link holder, here to prove the route drops it.
          artifactId: 'art-1',
          version: 3,
          versions: [{ version: 3 }, { version: 2 }],
          sourcePath: SOURCE_PATH,
          shareCode: CODE,
        },
      };
    },
    'artifacts:read': (input) => {
      if (!ok(input)) notFound();
      return {
        bytes,
        mediaType: 'text/markdown',
        preview: 'markdown',
        sizeBytes: bytes.byteLength,
        filename: 'Q3 report.md',
        version: 3,
        sourcePath: SOURCE_PATH,
      };
    },
    'artifacts:mint-view-token': (input) => {
      if (!ok(input)) notFound();
      const purpose = (input as { purpose: string }).purpose;
      return {
        url: `https://content.example/v/tok-${purpose}`,
        expiresAt: '2026-11-05T00:05:00.000Z',
        shareCode: CODE,
        version: 3,
      };
    },
  };
}

type HandlerName = keyof ReturnType<typeof createSharedArtifactsRouteHandlers>;
const ROUTES: Array<{ handler: HandlerName; body?: unknown }> = [
  { handler: 'resolve' },
  { handler: 'text' },
  { handler: 'token', body: { purpose: 'view' } },
];

async function hit(
  h: ReturnType<typeof createSharedArtifactsRouteHandlers>,
  name: HandlerName,
  code: string,
  opts: { user?: string; body?: unknown } = { user: 'u1' },
): Promise<Captured> {
  const { res, got } = mkRes();
  await h[name](mkReq({ code }, opts), res);
  return got;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shared artifact routes', () => {
  it('registers exactly the three /api/shared routes', async () => {
    const registered: Array<{ method: string; path: string }> = [];
    const bus = {
      call: vi.fn(async (hook: string, _ctx: unknown, route: { method: string; path: string }) => {
        if (hook !== 'http:register-route') throw new Error(`unexpected hook: ${hook}`);
        registered.push({ method: route.method, path: route.path });
        return { unregister: () => {} };
      }),
    } as unknown as HookBus;
    const unregisters = await registerSharedArtifactsRoutes(bus, mkInitCtx().ctx);
    expect(unregisters).toHaveLength(3);
    expect(registered.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      ['GET /api/shared/:code', 'GET /api/shared/:code/text', 'POST /api/shared/:code/token'].sort(),
    );
  });

  it('registers no GET /a/:code route — that path stays the SPA’s', () => {
    const routes = sharedArtifactRoutes(createSharedArtifactsRouteHandlers({ bus: fakeBus({}).bus, initCtx: mkInitCtx().ctx }));
    for (const r of routes) {
      expect(r.path.startsWith('/api/shared/')).toBe(true);
      expect(r.path).not.toMatch(/^\/a(\/|$)/);
    }
  });

  it('every route answers 401 to a signed-out request, with no-store, before any artifact hook', async () => {
    const { bus, call } = fakeBus(storeWith());
    const h = createSharedArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
    for (const r of ROUTES) {
      const got = await hit(h, r.handler, CODE, { body: r.body });
      expect(got.status, r.handler).toBe(401);
      expect(got.headers['cache-control']).toBe('private, no-store');
    }
    expect(call.mock.calls.map((c) => c[0]).filter((n) => n !== 'auth:require-user')).toEqual([]);
  });

  it('malformed, wrong and turned-off codes are all 404 link-not-found', async () => {
    const malformed = ['short', `${CODE}x`, 'Abcdefghijklmnopqrstuvwxyz01234!', '../../etc/passwd', ''];
    for (const r of ROUTES) {
      // Wrong: well-formed, matches nothing.
      {
        const { bus } = fakeBus(storeWith());
        const h = createSharedArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
        const got = await hit(h, r.handler, OTHER_CODE, { user: 'u1', body: r.body });
        expect([r.handler, got.status, got.json]).toEqual([r.handler, 404, { error: 'link-not-found' }]);
        expect(got.headers['cache-control']).toBe('private, no-store');
      }
      // Turned off: the right code, but the link is off (the hook says not-found).
      {
        const { bus } = fakeBus(storeWith({ linkOn: false }));
        const h = createSharedArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
        const got = await hit(h, r.handler, CODE, { user: 'u1', body: r.body });
        expect([r.handler, got.status, got.json]).toEqual([r.handler, 404, { error: 'link-not-found' }]);
      }
      // A `forbidden` refusal is the same 404 (a 403 would say the artifact exists).
      {
        const forbidden = (): never => {
          throw new PluginError({ code: 'forbidden', plugin: '@ax/attachments', message: 'no' });
        };
        const { bus } = fakeBus({
          'artifacts:resolve-share-code': forbidden,
          'artifacts:read': forbidden,
          'artifacts:mint-view-token': forbidden,
        });
        const h = createSharedArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
        const got = await hit(h, r.handler, CODE, { user: 'u1', body: r.body });
        expect([r.handler, got.status, got.json]).toEqual([r.handler, 404, { error: 'link-not-found' }]);
      }
      // Malformed: refused by shape, before any artifact hook runs.
      const { bus, call } = fakeBus(storeWith());
      const h = createSharedArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
      for (const code of malformed) {
        const got = await hit(h, r.handler, code, { user: 'u1', body: r.body });
        expect([r.handler, code, got.status, got.json]).toEqual([r.handler, code, 404, { error: 'link-not-found' }]);
      }
      expect(call.mock.calls.map((c) => c[0]).filter((n) => n !== 'auth:require-user')).toEqual([]);
    }
  });

  it('a signed-in non-member with the code sees the current version and can mint view and download tokens', async () => {
    const { bus, call } = fakeBus(storeWith());
    const h = createSharedArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });

    const view = await hit(h, 'resolve', CODE, { user: 'stranger' });
    expect(view.status).toBe(200);
    expect(view.headers['cache-control']).toBe('private, no-store');
    expect(view.json).toEqual({
      artifact: {
        title: 'Q3 report',
        mediaType: 'text/markdown',
        kind: 'document',
        preview: 'markdown',
        extension: 'MD',
        sizeBytes: 14,
        updatedAt: '2026-11-02T00:00:00.000Z',
        agentName: 'Research bot',
      },
    });

    const text = await hit(h, 'text', CODE, { user: 'stranger' });
    expect(text.status).toBe(200);
    expect(text.json).toEqual({ text: '# Q3\n\nNumbers.', truncated: false });

    for (const purpose of ['view', 'download'] as const) {
      const tok = await hit(h, 'token', CODE, { user: 'stranger', body: { purpose } });
      expect(tok.status).toBe(200);
      expect(tok.json).toEqual({ url: `https://content.example/v/tok-${purpose}`, expiresAt: '2026-11-05T00:05:00.000Z' });
    }

    // Every artifact hook was asked by code alone — never an id or a version.
    const artifactCalls = call.mock.calls.filter((c) => String(c[0]).startsWith('artifacts:'));
    expect(artifactCalls.map((c) => [c[0], c[2]])).toEqual([
      ['artifacts:resolve-share-code', { shareCode: CODE }],
      ['artifacts:read', { shareCode: CODE }],
      ['artifacts:mint-view-token', { shareCode: CODE, purpose: 'view' }],
      ['artifacts:mint-view-token', { shareCode: CODE, purpose: 'download' }],
    ]);
    // The hooks ran as the signed-in person.
    for (const c of artifactCalls) expect((c[1] as { userId: string }).userId).toBe('stranger');

    // No body carries a version, an id, a path or the code.
    const bodies = JSON.stringify([view.json, text.json]);
    for (const leak of [SOURCE_PATH, CODE, 'art-1', '"version"', 'versions']) expect(bodies).not.toContain(leak);
  });

  it('the text route follows the owner rules: not-previewable for HTML, truncated past 1 MiB', async () => {
    const big = 'a'.repeat(1024 * 1024 + 10);
    const stubs = storeWith({ text: big });
    const { bus } = fakeBus(stubs);
    const h = createSharedArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
    const got = await hit(h, 'text', CODE);
    expect(got.status).toBe(200);
    const body = got.json as { text: string; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.text.length).toBe(1024 * 1024);

    const read = stubs['artifacts:read']!;
    const { bus: htmlBus } = fakeBus({
      ...stubs,
      'artifacts:read': (input) => ({ ...(read(input) as object), preview: 'html', mediaType: 'text/html' }),
    });
    const hh = createSharedArtifactsRouteHandlers({ bus: htmlBus, initCtx: mkInitCtx().ctx });
    const html = await hit(hh, 'text', CODE);
    expect([html.status, html.json]).toEqual([404, { error: 'not-previewable' }]);
  });

  it('the token route refuses a missing or unknown purpose with 400 before any artifact hook', async () => {
    const { bus, call } = fakeBus(storeWith());
    const h = createSharedArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
    for (const body of [undefined, {}, { purpose: 'edit' }, ['view']]) {
      const got = await hit(h, 'token', CODE, { user: 'u1', body });
      expect([got.status, got.json]).toEqual([400, { error: 'invalid' }]);
    }
    expect(call.mock.calls.map((c) => c[0]).filter((n) => n !== 'auth:require-user')).toEqual([]);
  });

  it('the 31st lookup in a minute from one person is a 429 with Retry-After: 60; another person is unaffected; the window slides', async () => {
    expect(SHARED_LOOKUPS_PER_MINUTE).toBe(30);
    let t = 5_000_000;
    const { bus } = fakeBus(storeWith());
    const h = createSharedArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx, now: () => t });

    // The three routes share one limiter: 10 rounds of all three = 30 lookups.
    for (let i = 0; i < 10; i++) {
      for (const r of ROUTES) {
        const got = await hit(h, r.handler, CODE, { user: 'u1', body: r.body });
        expect(got.status).toBe(200);
      }
      t += 1_000;
    }
    const over = await hit(h, 'resolve', CODE, { user: 'u1' });
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('60');
    expect(over.headers['cache-control']).toBe('private, no-store');
    expect(over.json).toMatchObject({ error: 'rate-limited' });
    expect(typeof (over.json as { message?: unknown }).message).toBe('string');

    // Wrong codes count too: guessing is what the limit is for.
    expect((await hit(h, 'resolve', OTHER_CODE, { user: 'u1' })).status).toBe(429);
    expect((await hit(h, 'resolve', 'malformed', { user: 'u1' })).status).toBe(429);

    // Someone else is unaffected.
    expect((await hit(h, 'resolve', CODE, { user: 'u2' })).status).toBe(200);

    // Slide: the first round was spent at t0..; 60 s after it, three takes free up.
    t = 5_000_000 + 60_000;
    expect((await hit(h, 'resolve', CODE, { user: 'u1' })).status).toBe(200);
    expect((await hit(h, 'resolve', CODE, { user: 'u1' })).status).toBe(200);
    expect((await hit(h, 'resolve', CODE, { user: 'u1' })).status).toBe(200);
    expect((await hit(h, 'resolve', CODE, { user: 'u1' })).status).toBe(429);
  });

  it('the code never appears in a log line or in stderr', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    const consoleLines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(' '));
      });
    }
    const { ctx, lines } = mkInitCtx();
    // An unplanned fault whose message quotes the code (the log must carry codes only).
    const boom = (): never => {
      throw new PluginError({ code: 'unknown', plugin: '@ax/attachments', message: `store blew up on ${CODE}` });
    };
    const { bus } = fakeBus({
      'artifacts:resolve-share-code': boom,
      'artifacts:read': boom,
      'artifacts:mint-view-token': boom,
    });
    const h = createSharedArtifactsRouteHandlers({ bus, initCtx: ctx, now: () => 0 });
    for (const r of ROUTES) {
      const got = await hit(h, r.handler, CODE, { user: 'u1', body: r.body });
      expect(got.status).toBe(500);
      expect(got.json).toEqual({ error: 'internal' });
    }
    // The 404 and the 429 paths too.
    const { bus: okBus } = fakeBus(storeWith({ linkOn: false }));
    const h2 = createSharedArtifactsRouteHandlers({ bus: okBus, initCtx: ctx, now: () => 0 });
    for (let i = 0; i < SHARED_LOOKUPS_PER_MINUTE + 2; i++) await hit(h2, 'resolve', CODE);

    expect(lines.length).toBeGreaterThan(0); // the 500s were logged…
    const everything = JSON.stringify(lines) + stderr.join('') + consoleLines.join('\n');
    expect(everything).not.toContain(CODE); // …but never with the code, whole
    expect(everything).not.toContain(CODE.slice(0, 8)); // or in part.
  });
});
