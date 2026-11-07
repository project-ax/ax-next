import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginError, type Logger } from '@ax/core';
import { MAX_RETAINED_VERSIONS } from '../artifacts/store.js';
import { createArtifactServe, startContentOrigin } from '../artifacts/content-origin.js';
import { createArtifactsMintViewTokenHandler } from '../artifacts/handlers.js';
import { VIEW_TOKEN_TTL_SECONDS, signViewToken, verifyViewToken } from '../artifacts/view-token.js';
import type { ArtifactsMintViewTokenOutput, ArtifactsSetLinkOutput } from '../artifacts/types.js';
import { BYTES, SHA, SHA2, ctxFor, makeRig, publish, useArtifactsDb, type Rig } from './artifacts-fixture.js';

useArtifactsDb();

const HTML_SHA = 'c'.repeat(64);
const SVG_SHA = 'd'.repeat(64);
const HTML = '<!doctype html><title>t</title><script>document.title="x"</script>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
BYTES[HTML_SHA] = new TextEncoder().encode(HTML);
BYTES[SVG_SHA] = new TextEncoder().encode(SVG);

const HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; frame-ancestors http://localhost:9090; sandbox allow-scripts allow-downloads";

/** A logger that records every line it is handed, so a test can scan them all. */
function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (m, b) => void lines.push(JSON.stringify([m, b ?? {}])),
    info: (m, b) => void lines.push(JSON.stringify([m, b ?? {}])),
    warn: (m, b) => void lines.push(JSON.stringify([m, b ?? {}])),
    error: (m, b) => void lines.push(JSON.stringify([m, b ?? {}])),
    child: () => logger,
  };
  return { logger, lines };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  vi.restoreAllMocks();
});

interface Origin {
  rig: Rig;
  url: string;
  key: Uint8Array;
  lines: string[];
  mintRaw(input: unknown, userId?: string): Promise<ArtifactsMintViewTokenOutput>;
}

async function startOrigin(opts: { serveThrows?: boolean } = {}): Promise<Origin> {
  const rig = await makeRig();
  const key = randomBytes(32);
  const { logger, lines } = captureLogger();
  const realServe = createArtifactServe({ artifacts: rig.artifacts, bus: rig.bus });
  const origin = await startContentOrigin({
    host: '127.0.0.1',
    port: 0,
    frameAncestors: ['http://localhost:9090'],
    key,
    logger,
    serve: opts.serveThrows
      ? async () => {
          throw new Error('boom /v/secret-path');
        }
      : realServe,
  });
  closers.push(() => origin.close());
  rig.bus.registerService(
    'artifacts:mint-view-token',
    '@ax/attachments',
    createArtifactsMintViewTokenHandler({ artifacts: rig.artifacts, bus: rig.bus }, () => ({
      key,
      publicOrigin: origin.url,
    })),
  );
  return {
    rig,
    url: origin.url,
    key,
    lines,
    mintRaw: (input, userId = 'u-1') =>
      rig.bus.call<unknown, ArtifactsMintViewTokenOutput>('artifacts:mint-view-token', ctxFor(userId), input),
  };
}

function sourcePathFor(kind: 'html' | 'pdf' | 'svg'): string {
  return kind === 'html' ? 'site/index.html' : kind === 'svg' ? 'img/logo.svg' : 'reports/q3.pdf';
}

/** Publish (as u-1 / agt-1) and mint an owner token for its current version. */
async function publishAndMint(
  o: Origin,
  args: { purpose: 'view' | 'download'; kind?: 'html' | 'pdf' | 'svg'; title?: string },
): Promise<{ url: string; artifactId: string; version: number }> {
  const kind = args.kind ?? (args.purpose === 'view' ? 'html' : 'pdf');
  const sha256 = kind === 'html' ? HTML_SHA : kind === 'svg' ? SVG_SHA : SHA;
  const p = await publish(o.rig, {
    sha256,
    sourcePath: sourcePathFor(kind),
    ...(args.title !== undefined ? { title: args.title } : {}),
  });
  const { url } = await o.mintRaw({ artifactId: p.artifactId, version: p.version, purpose: args.purpose });
  return { url, artifactId: p.artifactId, version: p.version };
}

function setLink(rig: Rig, artifactId: string, action: 'ensure' | 'off' | 'rotate') {
  return rig.bus.call<unknown, ArtifactsSetLinkOutput>('artifacts:set-link', ctxFor('u-1'), { artifactId, action });
}

function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

function expectBaseHeaders(r: Response): void {
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  expect(r.headers.get('set-cookie')).toBeNull();
}

describe('content origin', () => {
  it('serves HTML with the exact CSP and headers', async () => {
    const o = await startOrigin();
    const { url } = await publishAndMint(o, { purpose: 'view' });
    expect(url.startsWith(`${o.url}/v/`)).toBe(true);
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toBe(HTML_CSP);
    // Ruling R8: opened top-level, the page still gets an opaque origin, with no allow-same-origin.
    const directives = (r.headers.get('content-security-policy') ?? '').split('; ');
    expect(directives).toContain('sandbox allow-scripts allow-downloads');
    expect(r.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBeNull();
    expectBaseHeaders(r);
    expect(await r.text()).toBe(HTML);
  });

  it('every content response says Referrer-Policy: no-referrer, 404s included', async () => {
    const o = await startOrigin();
    const view = await publishAndMint(o, { purpose: 'view' });
    const dl = await publishAndMint(o, { purpose: 'download', title: 'Other report' });
    const urls = [
      `${o.url}/`,
      view.url,
      dl.url,
      `${o.url}/v/nope`,
      `${o.url}/d/nope`,
      `${o.url}/elsewhere`,
      `${o.url}/v/`,
    ];
    for (const u of urls) {
      const r = await fetch(u);
      expectBaseHeaders(r);
      await r.arrayBuffer();
    }
    const post = await fetch(view.url, { method: 'POST' });
    expect(post.status).toBe(405);
    expectBaseHeaders(post);
  });

  it('serves an SVG as image/svg+xml under the sandboxing CSP', async () => {
    const o = await startOrigin();
    const { url } = await publishAndMint(o, { purpose: 'view', kind: 'svg' });
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/svg+xml');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expectBaseHeaders(r);
    expect(await r.text()).toBe(SVG);
  });

  it('a hostile title gives one safe Content-Disposition', async () => {
    const o = await startOrigin();
    // Published through artifacts:publish, so the stored title is normalized to 'a"b Set-Cookie: x=1'.
    const { url } = await publishAndMint(o, { purpose: 'download', title: 'a"b\u000d\u000aSet-Cookie: x=1' });
    expect(url.startsWith(`${o.url}/d/`)).toBe(true);
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="a_b Set-Cookie_ x_1.pdf"');
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expectBaseHeaders(r);
    expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it('a link token dies when the link goes off, rotates, or the owner restores', async () => {
    const o = await startOrigin();
    const { artifactId } = await publishAndMint(o, { purpose: 'view' });
    const mintByCode = async (shareCode: string, purpose: 'view' | 'download') =>
      (await o.mintRaw({ shareCode, purpose }, 'u-9')).url;

    // Off.
    let code = (await setLink(o.rig, artifactId, 'ensure')).shareCode!;
    let url = await mintByCode(code, 'view');
    expect((await fetch(url)).status).toBe(200);
    await setLink(o.rig, artifactId, 'off');
    expect((await fetch(url)).status).toBe(404);

    // Rotate.
    code = (await setLink(o.rig, artifactId, 'ensure')).shareCode!;
    url = await mintByCode(code, 'view');
    const dlUrl = await mintByCode(code, 'download');
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(dlUrl)).status).toBe(200);
    await setLink(o.rig, artifactId, 'rotate');
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(dlUrl)).status).toBe(404);

    // Restore (and a new version): the link token named a version that is no longer current.
    code = (await setLink(o.rig, artifactId, 'ensure')).shareCode!;
    url = await mintByCode(code, 'view');
    expect((await fetch(url)).status).toBe(200);
    await publish(o.rig, { sha256: HTML_SHA, sourcePath: sourcePathFor('html') });
    expect((await fetch(url)).status).toBe(404);
    url = await mintByCode(code, 'view');
    expect((await fetch(url)).status).toBe(200);
    await o.rig.bus.call('artifacts:restore', ctxFor('u-1'), { artifactId, version: 1 });
    expect((await fetch(url)).status).toBe(404);

    // An owner token is not bound to the link, and survives all of it.
    const owner = await o.mintRaw({ artifactId, version: 2, purpose: 'view' });
    await setLink(o.rig, artifactId, 'off');
    expect((await fetch(owner.url)).status).toBe(200);
  });

  it('an owner token for a deleted artifact or a pruned version is a 404', async () => {
    const o = await startOrigin();
    const first = await publishAndMint(o, { purpose: 'download' });
    expect((await fetch(first.url)).status).toBe(200);
    for (let i = 0; i < MAX_RETAINED_VERSIONS; i++) {
      await publish(o.rig, { sha256: i % 2 === 0 ? SHA2 : SHA, sourcePath: sourcePathFor('pdf') });
    }
    expect((await fetch(first.url)).status).toBe(404);

    const other = await publishAndMint(o, { purpose: 'view' });
    expect((await fetch(other.url)).status).toBe(200);
    await o.rig.bus.call('artifacts:delete', ctxFor('u-1'), { artifactId: other.artifactId });
    expect((await fetch(other.url)).status).toBe(404);
  });

  // R31: the mint refuses a chat visual, and the content origin re-checks on
  // every request, so even a validly signed token for one serves nothing.
  it('a signed token for a chat visual is a 404', async () => {
    const o = await startOrigin();
    const { artifactId } = await publish(o.rig, { sha256: HTML_SHA, sourcePath: `visuals/${HTML_SHA}.html`, visual: true });
    const now = Math.floor(Date.now() / 1000);
    for (const purpose of ['view', 'download'] as const) {
      const token = signViewToken(o.key, { artifactId, version: 1, purpose, linkBinding: null, expiresAt: now + 60 });
      expect((await fetch(`${o.url}/${purpose === 'view' ? 'v' : 'd'}/${token}`)).status).toBe(404);
    }
  });

  it('a view token is refused at /d/ and a download token at /v/', async () => {
    const o = await startOrigin();
    const view = await publishAndMint(o, { purpose: 'view' });
    const dl = await publishAndMint(o, { purpose: 'download' });
    expect((await fetch(`${o.url}/d/${tokenOf(view.url)}`)).status).toBe(404);
    expect((await fetch(`${o.url}/v/${tokenOf(dl.url)}`)).status).toBe(404);
    // An owner may download an HTML artifact, and still never gets it inline at /d/.
    const htmlDl = await o.mintRaw({ artifactId: view.artifactId, version: view.version, purpose: 'download' });
    const r = await fetch(htmlDl.url);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="Q3 pipeline report.html"');
  });

  it('forged, expired and malformed tokens get the same 404 body, and nothing logs the token or the path', async () => {
    const o = await startOrigin();
    const stderr = vi.spyOn(process.stderr, 'write');
    const stdout = vi.spyOn(process.stdout, 'write');
    const { url, artifactId, version } = await publishAndMint(o, { purpose: 'view' });
    const now = Math.floor(Date.now() / 1000);
    const claims = { artifactId, version, purpose: 'view' as const, linkBinding: null };
    const forged = signViewToken(randomBytes(32), { ...claims, expiresAt: now + VIEW_TOKEN_TTL_SECONDS });
    const expired = signViewToken(o.key, { ...claims, expiresAt: now - 1 });
    const unknownArtifact = signViewToken(o.key, { ...claims, artifactId: 'no-such', expiresAt: now + 60 });
    const malformed = ['garbage', 'v1.x.y', 'x'.repeat(2000), encodeURIComponent('a/b')];

    const bodies = new Set<string>();
    for (const t of [forged, expired, unknownArtifact, ...malformed]) {
      const r = await fetch(`${o.url}/v/${t}`);
      expect(r.status).toBe(404);
      expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      bodies.add(await r.text());
    }
    const missingPath = await fetch(`${o.url}/nowhere/${tokenOf(url)}`);
    expect(missingPath.status).toBe(404);
    bodies.add(await missingPath.text());
    expect(bodies.size).toBe(1);

    expect((await fetch(url)).status).toBe(200);
    const everything = [
      ...o.lines,
      ...stderr.mock.calls.map((c) => String(c[0])),
      ...stdout.mock.calls.map((c) => String(c[0])),
    ].join('\n');
    for (const secret of [tokenOf(url), forged, expired, 'garbage', 'nowhere', artifactId]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('a lookup that throws answers 500 and logs the route pattern and codes only', async () => {
    const o = await startOrigin({ serveThrows: true });
    const now = Math.floor(Date.now() / 1000);
    const token = signViewToken(o.key, {
      artifactId: 'art-x',
      version: 1,
      purpose: 'view',
      linkBinding: null,
      expiresAt: now + 60,
    });
    const r = await fetch(`${o.url}/v/${token}`);
    expect(r.status).toBe(500);
    expectBaseHeaders(r);
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0]).toContain('/v/:token');
    expect(o.lines[0]).toContain('500');
    expect(o.lines[0]).not.toContain(token);
    expect(o.lines[0]).not.toContain('secret-path');
    expect(o.lines[0]).not.toContain('art-x');
  });

  it('GET / answers 200 ok; other paths 404; POST 405', async () => {
    const o = await startOrigin();
    const root = await fetch(`${o.url}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toBe('ok');
    expectBaseHeaders(root);
    expect((await fetch(`${o.url}/v`)).status).toBe(404);
    expect((await fetch(`${o.url}/v/a/b`)).status).toBe(404);
    expect((await fetch(`${o.url}/api/me`)).status).toBe(404);
    expect((await fetch(`${o.url}/`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${o.url}/d/x`, { method: 'DELETE' })).status).toBe(405);
  });

  it("a request Node can't parse gets a fixed 400 with the base headers, then the socket closes", async () => {
    const o = await startOrigin();
    const u = new URL(o.url);
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(Number(u.port), u.hostname, () => sock.write('GARBAGE \u0001\r\n\r\n'));
      let got = '';
      sock.setEncoding('latin1');
      sock.on('data', (d: string) => (got += d));
      sock.on('close', () => resolve(got));
      sock.on('error', reject);
    });
    const [head = '', body] = raw.split('\r\n\r\n');
    const lines = head.split('\r\n');
    expect(lines[0]).toBe('HTTP/1.1 400 Bad Request');
    const headers = Object.fromEntries(
      lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]),
    );
    expect(headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      connection: 'close',
    });
    expect(headers['set-cookie']).toBeUndefined();
    expect(body).toBe('bad request');
    expect(o.lines).toEqual([]);
  });

  it('never reads a cookie: a request carrying one is answered the same', async () => {
    const o = await startOrigin();
    const { url } = await publishAndMint(o, { purpose: 'view' });
    const u = new URL(url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: u.hostname, port: u.port, path: u.pathname, headers: { cookie: 'ax_auth_session=abc' } },
        (res) => {
          res.resume();
          expect(res.headers['set-cookie']).toBeUndefined();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });
});

describe('artifacts:mint-view-token', () => {
  it('mint: view refuses a PDF (invalid-payload); a link holder may mint only the current version; no content origin means unavailable', async () => {
    const o = await startOrigin();
    const pdf = await publish(o.rig, { sha256: SHA, sourcePath: sourcePathFor('pdf') });
    await expect(o.mintRaw({ artifactId: pdf.artifactId, version: 1, purpose: 'view' })).rejects.toMatchObject({
      code: 'invalid-payload',
    });
    // A non-member asking about the same PDF learns nothing from the refusal.
    await expect(
      o.mintRaw({ artifactId: pdf.artifactId, version: 1, purpose: 'view' }, 'u-9'),
    ).rejects.toMatchObject({ code: 'not-found', message: 'artifact not found' });

    // A link holder: current version only; no way to name another.
    const html = await publish(o.rig, { sha256: HTML_SHA, sourcePath: sourcePathFor('html') });
    await publish(o.rig, { sha256: HTML_SHA, sourcePath: sourcePathFor('html') });
    const code = (await setLink(o.rig, html.artifactId, 'ensure')).shareCode!;
    const byCode = await o.mintRaw({ shareCode: code, purpose: 'view' }, 'u-9');
    const claims = verifyViewToken(o.key, tokenOf(byCode.url), Math.floor(Date.now() / 1000));
    expect(claims).toMatchObject({ artifactId: html.artifactId, version: 2, purpose: 'view' });
    expect(claims?.linkBinding).toHaveLength(22);
    await expect(o.mintRaw({ shareCode: code, version: 1, purpose: 'view' }, 'u-9')).rejects.toMatchObject({
      code: 'invalid-payload',
    });
    // Naming the id is the member path, and a link holder is not a member.
    await expect(
      o.mintRaw({ artifactId: html.artifactId, version: 1, purpose: 'view' }, 'u-9'),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(o.mintRaw({ shareCode: 'A'.repeat(32), purpose: 'view' }, 'u-9')).rejects.toMatchObject({
      code: 'not-found',
      message: 'artifact not found',
    });

    // The owner may mint any retained version.
    const v1 = await o.mintRaw({ artifactId: html.artifactId, version: 1, purpose: 'view' });
    expect(verifyViewToken(o.key, tokenOf(v1.url), Math.floor(Date.now() / 1000))).toMatchObject({
      version: 1,
      linkBinding: null,
    });
    await expect(o.mintRaw({ artifactId: html.artifactId, version: 9, purpose: 'view' })).rejects.toMatchObject({
      code: 'not-found',
    });
    const expiresAt = Date.parse(v1.expiresAt);
    expect(expiresAt - Date.now()).toBeGreaterThan((VIEW_TOKEN_TTL_SECONDS - 10) * 1000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(VIEW_TOKEN_TTL_SECONDS * 1000);

    // Malformed input.
    for (const bad of [
      { artifactId: html.artifactId, version: 1, purpose: 'edit' },
      { artifactId: html.artifactId, version: 0, purpose: 'view' },
      { artifactId: html.artifactId, purpose: 'view' },
      { artifactId: html.artifactId, shareCode: code, version: 1, purpose: 'view' },
    ]) {
      await expect(o.mintRaw(bad)).rejects.toMatchObject({ code: 'invalid-payload' });
    }

    // No content origin configured: unavailable, never a URL.
    o.rig.bus.registerService(
      'artifacts:mint-view-token:none',
      '@ax/attachments',
      createArtifactsMintViewTokenHandler({ artifacts: o.rig.artifacts, bus: o.rig.bus }, () => undefined),
    );
    const err = await o.rig.bus
      .call('artifacts:mint-view-token:none', ctxFor('u-1'), { artifactId: html.artifactId, version: 1, purpose: 'view' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err).toMatchObject({ code: 'unavailable' });
  });
});
