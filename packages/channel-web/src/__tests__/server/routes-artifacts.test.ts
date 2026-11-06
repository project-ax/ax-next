// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PluginError, type HookBus } from '@ax/core';
import {
  ARTIFACTS_ZIP_MAX_BYTES,
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
      expect({ route: c.name, status: got.status }).toEqual({ route: c.name, status: 401 });
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
        expect({ route: c.name, status: got.status }).toEqual({ route: c.name, status: 404 });
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
      expect({ status: got.status, body: got.json }).toEqual({ status, body });
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
      expect({ preview, status: got.status, body: got.json }).toEqual({ preview, status: 404, body: { error: 'not-previewable' } });
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
      expect({ handler, status: got.status, body: got.json }).toEqual({ handler, status: 400, body: { error: 'invalid' } });
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

  it('Download all over 256 MiB or 500 files is a 413 with the message, and reads no bytes', async () => {
    const tooBig = [summary({ artifactId: 'a1', sizeBytes: ARTIFACTS_ZIP_MAX_BYTES }), summary({ artifactId: 'a2', sizeBytes: 1 })];
    const tooMany = Array.from({ length: ARTIFACTS_ZIP_MAX_ENTRIES + 1 }, (_, i) => summary({ artifactId: `a${i}`, sizeBytes: 1 }));
    for (const artifacts of [tooBig, tooMany]) {
      const { bus, call } = downloadBus({ artifacts });
      const { res, got } = mkRes();
      await createArtifactsRouteHandlers({ bus, initCtx: mkInitCtx().ctx }).downloadAll(mkReq({ agentId: 'agent-1' }), res);
      expect({ status: got.status, body: got.json }).toEqual({
        status: 413,
        body: { error: 'too-large', message: "That's too much to bundle at once — download them one at a time." },
      });
      expect(call.mock.calls.map(([hook]) => hook)).toEqual(['auth:require-user', 'artifacts:list']);
      expect(got.body).toBeUndefined();
    }
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
});
