import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@ax/core';
import * as frameGuard from '@ax/frame-guard';
import {
  MAX_HTML_TRANSFORM_BYTES,
  startContentOrigin,
  type ServedArtifact,
} from '../artifacts/content-origin.js';
import { signViewToken } from '../artifacts/view-token.js';

// The HTML branch of the content origin (TASK-1082 T5), with a stub `serve` so
// no Postgres is needed: every page goes through prepareArtifactHtml, and
// nothing else does. artifacts-content-origin.test.ts covers the same branch
// end to end through the real artifact store.

vi.mock('@ax/frame-guard', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ax/frame-guard')>();
  return { ...real, prepareArtifactHtml: vi.fn(real.prepareArtifactHtml) };
});
const prepare = vi.mocked(frameGuard.prepareArtifactHtml);

const HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; frame-ancestors http://localhost:9090; sandbox allow-scripts allow-downloads";
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const DOWNLOAD_CSP = "default-src 'none'; sandbox";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Stub {
  served: ServedArtifact;
}

const key = randomBytes(32);
const closers: Array<() => Promise<void>> = [];
const stubs = new Map<string, Stub>();
let lines: string[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  stubs.clear();
  lines = [];
  prepare.mockClear();
});

function logger(): Logger {
  const l: Logger = {
    debug: (m, b) => void lines.push(JSON.stringify([m, b ?? {}])),
    info: (m, b) => void lines.push(JSON.stringify([m, b ?? {}])),
    warn: (m, b) => void lines.push(JSON.stringify([m, b ?? {}])),
    error: (m, b) => void lines.push(JSON.stringify([m, b ?? {}])),
    child: () => l,
  };
  return l;
}

async function start(): Promise<string> {
  const origin = await startContentOrigin({
    host: '127.0.0.1',
    port: 0,
    frameAncestors: ['http://localhost:9090'],
    key,
    logger: logger(),
    serve: async (c) => stubs.get(c.artifactId)?.served ?? null,
  });
  closers.push(() => origin.close());
  return origin.url;
}

function put(id: string, served: Partial<ServedArtifact> & Pick<ServedArtifact, 'bytes'>): string {
  stubs.set(id, {
    served: { mediaType: 'text/html', preview: 'html', filename: 'a.html', ...served },
  });
  return id;
}

function tokenUrl(base: string, id: string, purpose: 'view' | 'download' = 'view'): string {
  const t = signViewToken(key, {
    artifactId: id,
    version: 1,
    purpose,
    linkBinding: null,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  });
  return `${base}/${purpose === 'view' ? 'v' : 'd'}/${t}`;
}

function expectBaseHeaders(r: Response): void {
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  expect(r.headers.get('set-cookie')).toBeNull();
}

const GUARD_FIRST_IN_HEAD = /<head><script>[\s\S]*?axFrameGuard[\s\S]*?<\/script>/;

describe('content origin: HTML goes through prepareArtifactHtml', () => {
  it('keeps the CSP and the headers exactly as they were', async () => {
    const base = await start();
    put('a', { bytes: enc('<!doctype html><title>t</title>') });
    const r = await fetch(tokenUrl(base, 'a'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toBe(HTML_CSP);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBeNull();
    expectBaseHeaders(r);
    // content-length is the length of what was sent, not of what was stored.
    const body = new Uint8Array(await r.arrayBuffer());
    expect(Number(r.headers.get('content-length'))).toBe(body.byteLength);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('an ordinary page (table + chart-drawing script) comes back whole, with the guard first in head', async () => {
    const base = await start();
    const script = 'var c=document.getElementById("c").getContext("2d");for(var i=0;i<3;i++){c.fillRect(i*10,0,8,i*5+1);}';
    const page =
      '<!doctype html><html><head><meta charset="utf-8"><title>Q3</title><style>td{padding:4px}</style></head>' +
      `<body><table><thead><tr><th>Region</th><th>Pipeline</th></tr></thead><tbody><tr><td>EMEA</td><td>1&amp;2</td></tr></tbody></table><canvas id="c" width="40" height="20"></canvas><script>${script}</script></body></html>`;
    put('a', { bytes: enc(page) });
    const r = await fetch(tokenUrl(base, 'a'));
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).toMatch(GUARD_FIRST_IN_HEAD);
    expect(body).toContain(`<script>${script}</script>`);
    expect(body).toContain(
      '<table><thead><tr><th>Region</th><th>Pipeline</th></tr></thead><tbody><tr><td>EMEA</td><td>1&amp;2</td></tr></tbody></table>',
    );
    expect(body).toContain('<style>td{padding:4px}</style>');
    expect(body.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('cuts a child frame out of the page it serves', async () => {
    const base = await start();
    put('a', { bytes: enc('<!doctype html><p>hi</p><iframe srcdoc="<script>1</script>"></iframe>') });
    const body = await (await fetch(tokenUrl(base, 'a'))).text();
    expect(body).toContain('<p>hi</p>');
    expect(body).not.toMatch(/<iframe/i);
  });

  it('a page the transform refuses (null) is the same 404, with the base headers, and logs a fixed code only', async () => {
    const base = await start();
    const MARK = 'SECRETPAGECONTENT';
    put('art-secret-id', { bytes: enc(`<!doctype html><plaintext>${MARK}`) });
    const url = tokenUrl(base, 'art-secret-id');
    const refused = await fetch(url);
    const unknown = await fetch(`${base}/v/garbage`);
    expect(refused.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await refused.text()).toBe(await unknown.text());
    expect(refused.headers.get('content-type')).toBe(unknown.headers.get('content-type'));
    expect(refused.headers.get('content-security-policy')).toBeNull();
    expectBaseHeaders(refused);
    expect(prepare).toHaveLastReturnedWith(null);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual([
      'artifacts_content_origin_failed',
      { route: '/v/:token', status: 404, code: 'html_unsafe', name: 'HtmlRefusal' },
    ]);
    const everything = lines.join('\n');
    for (const secret of [MARK, 'art-secret-id', url.slice(url.lastIndexOf('/') + 1), '/v/garbage']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('HTML over the transform cap is a 404, never served as it was; at the cap it is served', async () => {
    const base = await start();
    const head = '<!doctype html><p>x</p><!--';
    const tail = '-->';
    const pad = (n: number): string => head + 'a'.repeat(n - head.length - tail.length) + tail;
    put('at', { bytes: enc(pad(MAX_HTML_TRANSFORM_BYTES)) });
    put('over', { bytes: enc(pad(MAX_HTML_TRANSFORM_BYTES + 1)) });

    const over = await fetch(tokenUrl(base, 'over'));
    expect(over.status).toBe(404);
    expect(await over.text()).toBe('not found');
    expectBaseHeaders(over);
    expect(over.headers.get('content-security-policy')).toBeNull();
    // Refused before it was parsed: the cap exists to bound the CPU.
    expect(prepare).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual([
      'artifacts_content_origin_failed',
      { route: '/v/:token', status: 404, code: 'html_too_large', name: 'HtmlRefusal' },
    ]);

    const at = await fetch(tokenUrl(base, 'at'));
    expect(at.status).toBe(200);
    expect((await at.text()).length).toBeGreaterThan(MAX_HTML_TRANSFORM_BYTES);
  });
});

describe('content origin: everything that is not inline HTML is byte-identical', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><iframe/><script>alert(1)</script></svg>';
  // Looks like HTML on purpose: nothing but `preview === 'html'` may be rewritten.
  const HTML_LOOKING = '<!doctype html><iframe srcdoc="x"></iframe><template shadowrootmode="closed"></template>';
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 255, 1, 2, 0xc3, 0x28]);

  it('an SVG under the sandboxing CSP', async () => {
    const base = await start();
    put('svg', { bytes: enc(SVG), mediaType: 'image/svg+xml', preview: 'image', filename: 'a.svg' });
    const r = await fetch(tokenUrl(base, 'svg'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/svg+xml');
    expect(r.headers.get('content-security-policy')).toBe(IMAGE_CSP);
    expectBaseHeaders(r);
    expect(await r.text()).toBe(SVG);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('a PDF download, an HTML download and a PDF opened inline', async () => {
    const base = await start();
    put('pdf', { bytes: PDF, mediaType: 'application/pdf', preview: 'other', filename: 'r.pdf' });
    put('html', { bytes: enc(HTML_LOOKING) });

    const dl = await fetch(tokenUrl(base, 'pdf', 'download'));
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-security-policy')).toBe(DOWNLOAD_CSP);
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
    expect(Array.from(new Uint8Array(await dl.arrayBuffer()))).toEqual(Array.from(PDF));

    const htmlDl = await fetch(tokenUrl(base, 'html', 'download'));
    expect(htmlDl.status).toBe(200);
    expect(htmlDl.headers.get('content-type')).toBe('application/octet-stream');
    expect(await htmlDl.text()).toBe(HTML_LOOKING);

    const inline = await fetch(tokenUrl(base, 'pdf'));
    expect(inline.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('content origin: prepared-HTML cache', () => {
  const page = (n: number): Uint8Array => enc(`<!doctype html><p>page ${n}</p><iframe></iframe>`);

  it('a second view of the same bytes skips the transform and sends the same bytes', async () => {
    const base = await start();
    put('a', { bytes: page(1), contentKey: 'sha-1' });
    put('b', { bytes: page(1), contentKey: 'sha-1' });
    const first = new Uint8Array(await (await fetch(tokenUrl(base, 'a'))).arrayBuffer());
    const second = new Uint8Array(await (await fetch(tokenUrl(base, 'b'))).arrayBuffer());
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(new TextDecoder().decode(second)).toContain('page 1');
  });

  it('different bytes (a different key) are transformed again', async () => {
    const base = await start();
    put('a', { bytes: page(1), contentKey: 'sha-1' });
    put('b', { bytes: page(2), contentKey: 'sha-2' });
    await (await fetch(tokenUrl(base, 'a'))).arrayBuffer();
    const b = await (await fetch(tokenUrl(base, 'b'))).text();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(b).toContain('page 2');
  });

  it('a serve with no content key is never cached', async () => {
    const base = await start();
    put('a', { bytes: page(1) });
    await (await fetch(tokenUrl(base, 'a'))).arrayBuffer();
    await (await fetch(tokenUrl(base, 'a'))).arrayBuffer();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('a refusal is cached too: the same hostile page is not re-parsed, and is still a 404', async () => {
    const base = await start();
    put('a', { bytes: enc('<!doctype html><plaintext>x'), contentKey: 'sha-bad' });
    expect((await fetch(tokenUrl(base, 'a'))).status).toBe(404);
    expect((await fetch(tokenUrl(base, 'a'))).status).toBe(404);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(2);
  });

  it('is bounded: the 17th distinct page pushes the oldest out; a hit keeps a page fresh', async () => {
    const base = await start();
    for (let i = 0; i < 17; i++) put(`p${i}`, { bytes: page(i), contentKey: `sha-${i}` });
    for (let i = 0; i < 16; i++) await (await fetch(tokenUrl(base, `p${i}`))).arrayBuffer();
    expect(prepare).toHaveBeenCalledTimes(16);
    await (await fetch(tokenUrl(base, 'p0'))).arrayBuffer(); // hit: p0 is now the newest
    expect(prepare).toHaveBeenCalledTimes(16);
    await (await fetch(tokenUrl(base, 'p16'))).arrayBuffer(); // evicts p1, the oldest
    expect(prepare).toHaveBeenCalledTimes(17);
    await (await fetch(tokenUrl(base, 'p0'))).arrayBuffer();
    expect(prepare).toHaveBeenCalledTimes(17);
    await (await fetch(tokenUrl(base, 'p1'))).arrayBuffer();
    expect(prepare).toHaveBeenCalledTimes(18);
  });
});
