// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PluginError, type HookBus } from '@ax/core';
import {
  ARTIFACTS_ZIP_MAX_BYTES,
  ARTIFACTS_ZIP_MAX_CONCURRENT,
  ARTIFACTS_ZIP_MAX_ENTRIES,
  ARTIFACT_TEXT_PREVIEW_MAX_BYTES,
  artifactRoutes,
  createArtifactsRouteHandlers,
  registerArtifactsRoutes,
} from '../../server/routes-artifacts.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-attachments.js';
import { faultInitCtx } from './require-user-fault.js';

// ---------------------------------------------------------------------------
// The artifact owner routes, on a stub bus. Access itself is the hooks' job
// (@ax/attachments tests it against a real store); here we pin what the
// routes add: sign-in first, the uniform 404, body shapes that carry nothing
// the hook did not mean to hand a browser, the text preview, and Download all.
// ---------------------------------------------------------------------------

const SOURCE_PATH = 'secret-dir/reports/q3-draft.md';
const SHARE_CODE = 'Abcdefghijklmnopqrstuvwxyz012345';

const mkInitCtx = faultInitCtx;

function mkReq(params: Record<string, string> = {}, body?: unknown): RouteRequest {
  return {
    headers: {},
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8'),
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
  body?: Buffer;
  ended: boolean;
}
function mkRes(): { res: RouteResponse; got: Captured } {
  const got: Captured = { status: 0, headers: {}, ended: false };
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
    body(buf, contentType) {
      got.body = buf;
      if (contentType !== undefined && got.headers['content-type'] === undefined) got.headers['content-type'] = contentType;
    },
    end() {
      got.ended = true;
    },
  };
  return { res, got };
}

type Stub = (input: unknown) => unknown;
function fakeBus(stubs: Record<string, Stub>) {
  const call = vi.fn(async (hook: string, _ctx: unknown, input: unknown) => {
    const fn = stubs[hook];
    if (!fn) throw new Error(`unexpected hook: ${hook}`);
    return fn(input);
  });
  return { bus: { call, hasService: (n: string) => n in stubs } as unknown as HookBus, call };
}

const notFound = (): never => {
  throw new PluginError({ code: 'not-found', plugin: '@ax/attachments', message: 'artifact not found' });
};

const AUTH_OK: Record<string, Stub> = { 'auth:require-user': () => ({ user: { id: 'u1', isAdmin: false } }) };
const AUTH_NONE: Record<string, Stub> = {
  'auth:require-user': () => {
    throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'no' });
  },
};

function summary(over: Partial<Record<string, unknown>> = {}) {
  return {
    artifactId: 'art-1',
    agentId: 'agent-1',
    title: 'Report',
    mediaType: 'application/pdf',
    kind: 'document',
    preview: 'pdf',
    extension: 'PDF',
    currentVersion: 2,
    sizeBytes: 10,
    linkOn: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    // What a hook must never hand out, here to prove the route drops it.
    sourcePath: SOURCE_PATH,
    shareCode: SHARE_CODE,
    ...over,
  };
}

function readOut(bytes: Uint8Array, over: Partial<Record<string, unknown>> = {}) {
  return {
    bytes,
    mediaType: 'text/csv',
    preview: 'text',
    sizeBytes: bytes.byteLength,
    filename: 'Data.csv',
    version: 1,
    sourcePath: SOURCE_PATH,
    ...over,
  };
}

/** Every route, with the params and body that would get it past validation. */
const CASES: Array<{ name: string; handler: keyof ReturnType<typeof createArtifactsRouteHandlers>; params: Record<string, string>; body?: unknown }> = [
  { name: 'list', handler: 'list', params: { agentId: 'agent-1' } },
  { name: 'download-all', handler: 'downloadAll', params: { agentId: 'agent-1' } },
  { name: 'get', handler: 'get', params: { artifactId: 'art-1' } },
  { name: 'text', handler: 'text', params: { artifactId: 'art-1', version: '1' } },
  { name: 'token', handler: 'token', params: { artifactId: 'art-1', version: '1' }, body: { purpose: 'view' } },
  { name: 'rename', handler: 'rename', params: { artifactId: 'art-1' }, body: { title: 'New' } },
  { name: 'restore', handler: 'restore', params: { artifactId: 'art-1' }, body: { version: 1 } },
  { name: 'link', handler: 'link', params: { artifactId: 'art-1' }, body: { action: 'ensure' } },
  { name: 'delete', handler: 'remove', params: { artifactId: 'art-1' } },
];

const NINE = [
  'GET /api/workspace/agents/:agentId/artifacts',
  'GET /api/workspace/agents/:agentId/artifacts/download-all',
  'GET /api/workspace/artifacts/:artifactId',
  'GET /api/workspace/artifacts/:artifactId/versions/:version/text',
  'POST /api/workspace/artifacts/:artifactId/versions/:version/token',
  'PATCH /api/workspace/artifacts/:artifactId',
  'POST /api/workspace/artifacts/:artifactId/restore',
  'POST /api/workspace/artifacts/:artifactId/link',
  'DELETE /api/workspace/artifacts/:artifactId',
];

describe('artifact owner routes', () => {
  it('registers exactly these nine routes', async () => {
    const registered: string[] = [];
    const bus = {
      async call(hook: string, _ctx: unknown, route: { method: string; path: string }) {
        if (hook !== 'http:register-route') throw new Error(`unexpected hook ${hook}`);
        registered.push(`${route.method} ${route.path}`);
        return { unregister: () => {} };
      },
    } as unknown as HookBus;
    const unregisters = await registerArtifactsRoutes(bus, mkInitCtx().ctx);
    expect([...registered].sort()).toEqual([...NINE].sort());
    expect(unregisters).toHaveLength(9);
    expect(artifactRoutes(createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }))).toHaveLength(9);
  });

  it('every route answers 401 to a signed-out request', async () => {
    for (const c of CASES) {
      const { bus, call } = fakeBus(AUTH_NONE);
      const h = createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
      const { res, got } = mkRes();
      await h[c.handler](mkReq(c.params, c.body), res);
      expect({ route: c.name, status: got.status, cache: got.headers['cache-control'] }).toEqual({
        route: c.name,
        status: 401,
        cache: 'private, no-store',
      });
      expect(call.mock.calls.map(([hook]) => hook)).toEqual(['auth:require-user']);
    }
  });

  it("a non-member's agent or artifact gets the same 404 body as a missing one", async () => {
    const refusals: Array<() => never> = [
      notFound,
      () => {
        throw new PluginError({ code: 'forbidden', plugin: 'other-impl', message: 'not yours' });
      },
    ];
    const bodies = new Set<string>();
    for (const refuse of refusals) {
      for (const c of CASES) {
        const { bus } = fakeBus({
          ...AUTH_OK,
          'artifacts:list': refuse,
          'artifacts:get': refuse,
          'artifacts:read': refuse,
          'artifacts:mint-view-token': refuse,
          'artifacts:rename': refuse,
          'artifacts:restore': refuse,
          'artifacts:set-link': refuse,
          'artifacts:delete': refuse,
        });
        const h = createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
        const { res, got } = mkRes();
        await h[c.handler](mkReq(c.params, c.body), res);
        expect({ route: c.name, status: got.status, cache: got.headers['cache-control'] }).toEqual({
          route: c.name,
          status: 404,
          cache: 'private, no-store',
        });
        bodies.add(JSON.stringify(got.json));
      }
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: 'artifact-not-found' })]);
  });

  it('maps invalid-payload to 400, conflict to 409, and anything else to a code-only logged 500', async () => {
    const cases: Array<[PluginError | Error, number, unknown]> = [
      [new PluginError({ code: 'invalid-payload', plugin: 'a', message: 'bad title' }), 400, { error: 'invalid' }],
      [new PluginError({ code: 'conflict', plugin: 'a', message: 'busy' }), 409, { error: 'conflict' }],
      [new PluginError({ code: 'unavailable', plugin: 'a', message: `at ${SOURCE_PATH}` }), 500, { error: 'internal' }],
      [new Error(`boom at ${SOURCE_PATH}`), 500, { error: 'internal' }],
    ];
    for (const [err, status, body] of cases) {
      const { ctx, logger } = mkInitCtx();
      const { bus } = fakeBus({
        ...AUTH_OK,
        'artifacts:rename': () => {
          throw err;
        },
      });
      const { res, got } = mkRes();
      await createArtifactsRouteHandlers({ bus, initCtx: ctx }).rename(mkReq({ artifactId: 'art-1' }, { title: 'x' }), res);
      expect({ status: got.status, body: got.json, cache: got.headers['cache-control'] }).toEqual({
        status,
        body,
        cache: 'private, no-store',
      });
      expect(JSON.stringify(logger.errors)).not.toContain(SOURCE_PATH);
      if (status === 500) {
        expect(logger.errors.map((e) => e.event)).toContain('artifacts_route_failed');
      }
    }
  });

  it('previews a 3 MiB CSV as its first 1 MiB with truncated: true', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(0x61);
    const read = vi.fn(() => readOut(bytes));
    const { bus } = fakeBus({ ...AUTH_OK, 'artifacts:read': read });
    const { res, got } = mkRes();
    await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).text(mkReq({ artifactId: 'art-1', version: '3' }), res);
    expect(got.status).toBe(200);
    const body = got.json as { text: string; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.text.length).toBe(ARTIFACT_TEXT_PREVIEW_MAX_BYTES);
    expect(Object.keys(body).sort()).toEqual(['text', 'truncated']);
    expect(read).toHaveBeenCalledWith({ artifactId: 'art-1', version: 3 });
  });

  it('a small markdown file previews whole, and a cut never splits a character', async () => {
    const { bus } = fakeBus({
      ...AUTH_OK,
      'artifacts:read': () => readOut(new TextEncoder().encode('# Hi é'), { preview: 'markdown' }),
    });
    const { res, got } = mkRes();
    await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).text(mkReq({ artifactId: 'a', version: '1' }), res);
    expect(got.json).toEqual({ text: '# Hi é', truncated: false });

    // 'é' is two bytes; put its first byte at the last position of the preview.
    const big = new Uint8Array(ARTIFACT_TEXT_PREVIEW_MAX_BYTES + 1).fill(0x61);
    big[ARTIFACT_TEXT_PREVIEW_MAX_BYTES - 1] = 0xc3;
    big[ARTIFACT_TEXT_PREVIEW_MAX_BYTES] = 0xa9;
    const { bus: bus2 } = fakeBus({ ...AUTH_OK, 'artifacts:read': () => readOut(big) });
    const r2 = mkRes();
    await createArtifactsRouteHandlers({ bus: bus2, initCtx: mkInitCtx().ctx }).text(mkReq({ artifactId: 'a', version: '1' }), r2.res);
    const body = r2.got.json as { text: string; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.text).not.toContain('�');
  });

  it('refuses a text preview of HTML, PDF and binary with not-previewable', async () => {
    for (const preview of ['html', 'pdf', 'image', 'none']) {
      const { bus } = fakeBus({ ...AUTH_OK, 'artifacts:read': () => readOut(new Uint8Array([1, 2, 3]), { preview }) });
      const { res, got } = mkRes();
      await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).text(mkReq({ artifactId: 'a', version: '1' }), res);
      expect({ preview, status: got.status, body: got.json, cache: got.headers['cache-control'] }).toEqual({
        preview,
        status: 404,
        body: { error: 'not-previewable' },
        cache: 'private, no-store',
      });
    }
  });

  it('refuses a malformed version or body with 400 before any artifact hook runs', async () => {
    const bad: Array<[keyof ReturnType<typeof createArtifactsRouteHandlers>, Record<string, string>, unknown]> = [
      ['text', { artifactId: 'a', version: '0' }, undefined],
      ['text', { artifactId: 'a', version: '1.5' }, undefined],
      ['token', { artifactId: 'a', version: 'x' }, { purpose: 'view' }],
      ['token', { artifactId: 'a', version: '1' }, { purpose: 'share' }],
      ['rename', { artifactId: 'a' }, { title: 7 }],
      ['restore', { artifactId: 'a' }, { version: '2' }],
      ['link', { artifactId: 'a' }, { action: 'publish' }],
    ];
    for (const [handler, params, body] of bad) {
      const { bus, call } = fakeBus(AUTH_OK);
      const { res, got } = mkRes();
      await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx })[handler](mkReq(params, body), res);
      expect({ handler, status: got.status, body: got.json, cache: got.headers['cache-control'] }).toEqual({
        handler,
        status: 400,
        body: { error: 'invalid' },
        cache: 'private, no-store',
      });
      expect(call.mock.calls.map(([hook]) => hook)).toEqual(['auth:require-user']);
    }
  });

  it('the token route returns the hook url and never a share code', async () => {
    const mint = vi.fn(() => ({
      url: 'https://content.example/v/tok',
      expiresAt: '2026-11-05T00:05:00.000Z',
      shareCode: SHARE_CODE,
    }));
    const { bus } = fakeBus({ ...AUTH_OK, 'artifacts:mint-view-token': mint });
    const { res, got } = mkRes();
    await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).token(
      mkReq({ artifactId: 'art-1', version: '2' }, { purpose: 'download' }),
      res,
    );
    expect(got.status).toBe(200);
    expect(got.json).toEqual({ url: 'https://content.example/v/tok', expiresAt: '2026-11-05T00:05:00.000Z' });
    expect(JSON.stringify(got.json)).not.toContain(SHARE_CODE);
    expect(mint).toHaveBeenCalledWith({ artifactId: 'art-1', version: 2, purpose: 'download' });
  });

  it('the token route passes a light or dark theme to the hook, and refuses any other value', async () => {
    const mint = vi.fn(() => ({ url: 'https://content.example/v/tok', expiresAt: '2026-11-05T00:05:00.000Z' }));
    const { bus } = fakeBus({ ...AUTH_OK, 'artifacts:mint-view-token': mint });
    const h = createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });

    const ok = mkRes();
    await h.token(mkReq({ artifactId: 'art-1', version: '2' }, { purpose: 'view', theme: 'dark' }), ok.res);
    expect(ok.got.status).toBe(200);
    expect(mint).toHaveBeenCalledWith({ artifactId: 'art-1', version: 2, purpose: 'view', theme: 'dark' });

    for (const theme of ['purple', '', 1, null, { x: 1 }]) {
      const bad = mkRes();
      await h.token(mkReq({ artifactId: 'art-1', version: '2' }, { purpose: 'view', theme }), bad.res);
      expect({ theme, status: bad.got.status }).toEqual({ theme, status: 400 });
    }
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('rename, restore, link and delete pass the request through and answer their shapes', async () => {
    const rename = vi.fn(() => ({ artifact: summary({ title: 'New' }) }));
    const restore = vi.fn(() => ({ artifact: summary({ currentVersion: 1 }) }));
    const setLink = vi.fn(() => ({ shareCode: SHARE_CODE }));
    const del = vi.fn(() => ({ deleted: true }));
    const { bus } = fakeBus({
      ...AUTH_OK,
      'artifacts:rename': rename,
      'artifacts:restore': restore,
      'artifacts:set-link': setLink,
      'artifacts:delete': del,
    });
    const h = createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });

    const r1 = mkRes();
    await h.rename(mkReq({ artifactId: 'art-1' }, { title: 'New' }), r1.res);
    expect(rename).toHaveBeenCalledWith({ artifactId: 'art-1', title: 'New' });
    expect((r1.got.json as { artifact: { title: string } }).artifact.title).toBe('New');

    const r2 = mkRes();
    await h.restore(mkReq({ artifactId: 'art-1' }, { version: 1 }), r2.res);
    expect(restore).toHaveBeenCalledWith({ artifactId: 'art-1', version: 1 });
    expect((r2.got.json as { artifact: { currentVersion: number } }).artifact.currentVersion).toBe(1);

    const r3 = mkRes();
    await h.link(mkReq({ artifactId: 'art-1' }, { action: 'rotate' }), r3.res);
    expect(setLink).toHaveBeenCalledWith({ artifactId: 'art-1', action: 'rotate' });
    expect(r3.got.json).toEqual({ shareCode: SHARE_CODE });

    const r4 = mkRes();
    await h.remove(mkReq({ artifactId: 'art-1' }), r4.res);
    expect(del).toHaveBeenCalledWith({ artifactId: 'art-1' });
    expect({ status: r4.got.status, ended: r4.got.ended, json: r4.got.json }).toEqual({ status: 204, ended: true, json: undefined });
  });

  it('no body ever carries a source path', async () => {
    const detail = { ...summary(), versions: [{ version: 2, mediaType: 'application/pdf', sizeBytes: 10, createdAt: 'x', sourcePath: SOURCE_PATH }] };
    const { bus } = fakeBus({
      ...AUTH_OK,
      'artifacts:list': () => ({ artifacts: [summary()] }),
      'artifacts:get': () => ({ artifact: detail }),
      'artifacts:read': () => readOut(new TextEncoder().encode('a,b\n1,2\n')),
      'artifacts:mint-view-token': () => ({ url: 'https://c/v/t', expiresAt: 'x', sourcePath: SOURCE_PATH }),
      'artifacts:rename': () => ({ artifact: summary() }),
      'artifacts:restore': () => ({ artifact: summary() }),
      'artifacts:set-link': () => ({ shareCode: null, sourcePath: SOURCE_PATH }),
      'artifacts:delete': () => ({ deleted: true, sourcePath: SOURCE_PATH }),
      'agents:resolve': () => ({ agent: { id: 'agent-1', displayName: 'Ada' } }),
    });
    const h = createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
    for (const c of CASES) {
      const { res, got } = mkRes();
      await h[c.handler](mkReq(c.params, c.body), res);
      expect({ route: c.name, ok: got.status >= 200 && got.status < 300 }).toEqual({ route: c.name, ok: true });
      const wire = `${JSON.stringify(got.json ?? null)}${got.body?.toString('latin1') ?? ''}${JSON.stringify(got.headers)}`;
      expect(wire).not.toContain(SOURCE_PATH);
      expect(wire).not.toContain('sourcePath');
      if (c.name !== 'link') expect(wire).not.toContain(SHARE_CODE);
    }
  });
});

// --- Download all -----------------------------------------------------------

/** Entry names and bytes, read back from a STORE zip's central directory. */
function zipEntries(zip: Buffer): Array<{ name: string; data: string }> {
  const eocd = zip.length - 22;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; data: string }> = [];
  for (let i = 0; i < count; i++) {
    const nameLen = zip.readUInt16LE(p + 28);
    const size = zip.readUInt32LE(p + 24);
    const off = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = zip.readUInt16LE(off + 26);
    const at = off + 30 + lNameLen + zip.readUInt16LE(off + 28);
    out.push({ name, data: zip.subarray(at, at + size).toString('utf8') });
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return out;
}

describe('Download all', () => {
  function downloadBus(opts: {
    artifacts: Array<ReturnType<typeof summary>>;
    files?: Record<string, { filename: string; text: string }>;
    agentName?: string;
  }) {
    const read = vi.fn((input: unknown) => {
      const id = (input as { artifactId: string }).artifactId;
      const f = opts.files?.[id];
      if (f === undefined) return notFound();
      return readOut(new TextEncoder().encode(f.text), { filename: f.filename });
    });
    const resolve = vi.fn(() => ({ agent: { id: 'agent-1', displayName: opts.agentName ?? 'Ada' } }));
    const { bus, call } = fakeBus({
      ...AUTH_OK,
      'artifacts:list': () => ({ artifacts: opts.artifacts }),
      'artifacts:read': read,
      'agents:resolve': resolve,
    });
    return { bus, call, read, resolve };
  }

  it('Download all zips every current version, deduping names, as an application/zip attachment with nosniff and no-store', async () => {
    const { bus, read, resolve } = downloadBus({
      artifacts: [summary({ artifactId: 'a1' }), summary({ artifactId: 'a2' }), summary({ artifactId: 'a3' })],
      files: {
        a1: { filename: 'Report.pdf', text: 'one' },
        a2: { filename: 'Report.pdf', text: 'two' },
        a3: { filename: 'Notes.md', text: 'three' },
      },
    });
    const { res, got } = mkRes();
    await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).downloadAll(mkReq({ agentId: 'agent-1' }), res);
    expect(got.status).toBe(200);
    expect(got.headers).toEqual({
      'content-type': 'application/zip',
      'content-length': String(got.body?.length),
      'content-disposition': 'attachment; filename="Ada artifacts.zip"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
    // The current version: read by id with no version.
    expect(read.mock.calls.map(([i]) => i)).toEqual([{ artifactId: 'a1' }, { artifactId: 'a2' }, { artifactId: 'a3' }]);
    expect(resolve).toHaveBeenCalledWith({ agentId: 'agent-1', userId: 'u1' });
    expect(zipEntries(got.body!)).toEqual([
      { name: 'Report.pdf', data: 'one' },
      { name: 'Report (2).pdf', data: 'two' },
      { name: 'Notes.md', data: 'three' },
    ]);
  });

  it('an agent name with a quote and CRLF cannot break out of the header', async () => {
    const { bus } = downloadBus({
      artifacts: [summary({ artifactId: 'a1' })],
      files: { a1: { filename: 'x.txt', text: 'x' } },
      agentName: 'Evil"\r\nSet-Cookie: a=b; x="',
    });
    const { res, got } = mkRes();
    await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).downloadAll(mkReq({ agentId: 'agent-1' }), res);
    const cd = got.headers['content-disposition']!;
    expect(cd).toBe('attachment; filename="Evil___Set-Cookie_ a_b_ x__ artifacts.zip"');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd.match(/"/g)).toHaveLength(2);
  });

  it('skips an artifact deleted between the list and the read', async () => {
    const { bus } = downloadBus({
      artifacts: [summary({ artifactId: 'a1' }), summary({ artifactId: 'gone' })],
      files: { a1: { filename: 'Keep.txt', text: 'k' } },
    });
    const { res, got } = mkRes();
    await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).downloadAll(mkReq({ agentId: 'agent-1' }), res);
    expect(got.status).toBe(200);
    expect(zipEntries(got.body!)).toEqual([{ name: 'Keep.txt', data: 'k' }]);
  });

  it('Download all over 100 MiB or 500 files is a 413 with the message, and reads no bytes', async () => {
    const tooBig = [summary({ artifactId: 'a1', sizeBytes: ARTIFACTS_ZIP_MAX_BYTES }), summary({ artifactId: 'a2', sizeBytes: 1 })];
    const tooMany = Array.from({ length: ARTIFACTS_ZIP_MAX_ENTRIES + 1 }, (_, i) => summary({ artifactId: `a${i}`, sizeBytes: 1 }));
    for (const artifacts of [tooBig, tooMany]) {
      const { bus, call } = downloadBus({ artifacts });
      const { res, got } = mkRes();
      await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).downloadAll(mkReq({ agentId: 'agent-1' }), res);
      expect({ status: got.status, body: got.json, cache: got.headers['cache-control'] }).toEqual({
        status: 413,
        body: { error: 'too-large', message: "That's too much to bundle at once — download them one at a time." },
        cache: 'private, no-store',
      });
      expect(call.mock.calls.map(([hook]) => hook)).toEqual(['auth:require-user', 'artifacts:list']);
      expect(got.body).toBeUndefined();
    }
  });

  const probeReq = (): RouteRequest => ({ ...mkReq({ agentId: 'agent-1' }), query: { probe: '1' } });

  it('?probe=1 answers 204 after the same list checks, building no zip', async () => {
    const { bus, call } = downloadBus({ artifacts: [summary({ artifactId: 'a1' })] });
    const { res, got } = mkRes();
    await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).downloadAll(probeReq(), res);
    expect({ status: got.status, ended: got.ended, body: got.body, cache: got.headers['cache-control'] }).toEqual({
      status: 204,
      ended: true,
      body: undefined,
      cache: 'private, no-store',
    });
    expect(call.mock.calls.map(([hook]) => hook)).toEqual(['auth:require-user', 'artifacts:list']);
  });

  it('?probe=1 answers the 413 a real download would', async () => {
    const tooMany = Array.from({ length: ARTIFACTS_ZIP_MAX_ENTRIES + 1 }, (_, i) => summary({ artifactId: `a${i}`, sizeBytes: 0 }));
    const { bus } = downloadBus({ artifacts: tooMany });
    const { res, got } = mkRes();
    await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).downloadAll(probeReq(), res);
    expect({ status: got.status, body: got.json }).toEqual({
      status: 413,
      body: { error: 'too-large', message: "That's too much to bundle at once — download them one at a time." },
    });
  });

  it('exactly at the caps still bundles', async () => {
    const atCap = Array.from({ length: ARTIFACTS_ZIP_MAX_ENTRIES }, (_, i) => summary({ artifactId: `a${i}`, sizeBytes: 0 }));
    const files = Object.fromEntries(atCap.map((a) => [a.artifactId as string, { filename: 'f.txt', text: '' }]));
    const { bus } = downloadBus({ artifacts: atCap, files });
    const { res, got } = mkRes();
    await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).downloadAll(mkReq({ agentId: 'agent-1' }), res);
    expect(got.status).toBe(200);
    expect(zipEntries(got.body!)).toHaveLength(ARTIFACTS_ZIP_MAX_ENTRIES);
  });

  it('caps a bundle at 100 MiB, 500 files and 2 at once on the host', () => {
    expect([ARTIFACTS_ZIP_MAX_BYTES, ARTIFACTS_ZIP_MAX_ENTRIES, ARTIFACTS_ZIP_MAX_CONCURRENT]).toEqual([
      100 * 1024 * 1024,
      500,
      2,
    ]);
  });
});

// --- Download all: one at a time ---------------------------------------------

describe('Download all concurrency', () => {
  /** A signed-in request as `user` (the stub auth reads the header). */
  function asUser(user: string): RouteRequest {
    return { ...mkReq({ agentId: 'agent-1' }), headers: { 'x-test-user': user } };
  }

  /**
   * A bus whose `artifacts:list` waits until the test lets it go, so a bundle
   * can be held "in flight". `listBehaviour` picks what a released list does.
   */
  function gatedBus() {
    const gates: Array<() => void> = [];
    let listBehaviour: 'ok' | 'fault' = 'ok';
    let resolveBehaviour: 'ok' | 'throw' = 'ok';
    const { bus } = fakeBus({
      'auth:require-user': (input) => ({
        user: { id: (input as { req: RouteRequest }).req.headers['x-test-user'], isAdmin: false },
      }),
      'artifacts:list': async () => {
        await new Promise<void>((release) => gates.push(release));
        if (listBehaviour === 'fault') throw new Error('database went away');
        return { artifacts: [summary({ artifactId: 'a1' })] };
      },
      'artifacts:read': () => readOut(new TextEncoder().encode('x'), { filename: 'x.txt' }),
      'agents:resolve': () => {
        if (resolveBehaviour === 'throw') return { agent: null };
        return { agent: { id: 'agent-1', displayName: 'Ada' } };
      },
    });
    const h = createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx });
    /** Start a request; resolves to its captured response once it finishes (and rejects if the handler throws). */
    function start(user: string) {
      const { res, got } = mkRes();
      const done = h.downloadAll(asUser(user), res).then(() => got);
      return { got, done };
    }
    /** A `?probe=1` request as `user`. */
    function probe(user: string) {
      const { res, got } = mkRes();
      const done = h.downloadAll({ ...asUser(user), query: { probe: '1' } }, res).then(() => got);
      return { got, done };
    }
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return {
      start,
      probe,
      flush,
      releaseAll: () => gates.splice(0).forEach((g) => g()),
      setList: (b: 'ok' | 'fault') => (listBehaviour = b),
      setResolve: (b: 'ok' | 'throw') => (resolveBehaviour = b),
    };
  }

  const ONE_AT_A_TIME = { error: 'busy', message: 'One download at a time, please — try again in a moment.' };
  const HOST_BUSY = { error: 'busy', message: "We're bundling a few downloads already — try again in a moment." };

  it("a second bundle from the same person is a 429 while the first is building", async () => {
    const t = gatedBus();
    const first = t.start('u1');
    await t.flush();
    const second = await t.start('u1').done;
    expect({ status: second.status, body: second.json, cache: second.headers['cache-control'] }).toEqual({
      status: 429,
      body: ONE_AT_A_TIME,
      cache: 'private, no-store',
    });
    t.releaseAll();
    expect((await first.done).status).toBe(200);
  });

  it('a third bundle on the host is a 429 while two are building', async () => {
    const t = gatedBus();
    const a = t.start('u1');
    const b = t.start('u2');
    await t.flush();
    const c = await t.start('u3').done;
    expect({ status: c.status, body: c.json }).toEqual({ status: 429, body: HOST_BUSY });
    t.releaseAll();
    expect([(await a.done).status, (await b.done).status]).toEqual([200, 200]);
  });

  it('the slot is released after a success, after a refusal, and after a throw', async () => {
    const t = gatedBus();

    // Success.
    const ok = t.start('u1');
    await t.flush();
    t.releaseAll();
    expect((await ok.done).status).toBe(200);

    // A hook fault, answered as a 500.
    t.setList('fault');
    const fault = t.start('u1');
    await t.flush();
    t.releaseAll();
    expect((await fault.done).status).toBe(500);

    // A throw out of the handler (a malformed resolve reply).
    t.setList('ok');
    t.setResolve('throw');
    const thrown = t.start('u1');
    await t.flush();
    t.releaseAll();
    await expect(thrown.done).rejects.toThrow();

    // And the same person, and two others, can each bundle again.
    t.setResolve('ok');
    const again = [t.start('u1'), t.start('u2')];
    await t.flush();
    t.releaseAll();
    expect(await Promise.all(again.map(async (r) => (await r.done).status))).toEqual([200, 200]);
  });

  describe('?probe=1', () => {
    it("answers 429 while that person's bundle is building", async () => {
      const t = gatedBus();
      const building = t.start('u1');
      await t.flush();
      const refused = await t.probe('u1').done;
      expect({ status: refused.status, body: refused.json }).toEqual({ status: 429, body: ONE_AT_A_TIME });
      t.releaseAll();
      expect((await building.done).status).toBe(200);
    });

    it('answers the host-busy 429 when two bundles are building', async () => {
      const t = gatedBus();
      const a = t.start('u1');
      const b = t.start('u2');
      await t.flush();
      const refused = await t.probe('u3').done;
      expect({ status: refused.status, body: refused.json }).toEqual({ status: 429, body: HOST_BUSY });
      t.releaseAll();
      expect([(await a.done).status, (await b.done).status]).toEqual([200, 200]);
    });

    it('never holds a slot: two probes in flight do not crowd out two real downloads', async () => {
      const t = gatedBus();
      const p1 = t.probe('u3');
      const p2 = t.probe('u4');
      const a = t.start('u1');
      const b = t.start('u2');
      await t.flush();
      t.releaseAll();
      expect([(await p1.done).status, (await p2.done).status]).toEqual([204, 204]);
      expect([(await a.done).status, (await b.done).status]).toEqual([200, 200]);
    });
  });
});
