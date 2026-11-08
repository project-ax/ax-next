import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@ax/core';
import * as frameGuard from '@ax/frame-guard';
import {
  HTML_REFUSED_BODY,
  HTML_TOO_LARGE_BODY,
  HTML_TRY_AGAIN_BODY,
  MAX_HTML_TRANSFORM_BYTES,
  startContentOrigin,
  type ContentOriginOptions,
  type ServedArtifact,
} from '../artifacts/content-origin.js';
import { signViewToken } from '../artifacts/view-token.js';

// The HTML branch of the content origin (TASK-1082 T5), with a stub `serve` so
// no Postgres is needed: every page goes through the HTML preparer, and nothing
// else does. artifacts-content-origin.test.ts covers the same branch end to end
// through the real artifact store, and artifacts-content-origin-worker.test.ts
// through the real worker process. Here the preparer runs the transform in THIS
// process, through a spy, so a test can count how often it ran and make it answer
// as the worker would (out of time, out of memory, busy).

vi.mock('@ax/frame-guard', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ax/frame-guard')>();
  return { ...real, prepareArtifactHtml: vi.fn(real.prepareArtifactHtml) };
});
const prepare = vi.mocked(frameGuard.prepareArtifactHtml);

/** The transform, in this thread, behind the preparer's interface. */
const inThread: frameGuard.HtmlPreparer = {
  prepare: async (html) => {
    const result = prepare(html);
    return result.ok ? { ok: true, bytes: new TextEncoder().encode(result.html) } : result;
  },
  close: async () => undefined,
};
/** A preparer that refuses every page for one reason, as the worker does for a page that holds it or a pool that is full. */
const refusing = (reason: frameGuard.PoolRefusal): frameGuard.HtmlPreparer & { asked: number } => {
  const p = {
    asked: 0,
    prepare: async (): Promise<frameGuard.PreparedPage> => {
      p.asked += 1;
      return { ok: false, reason };
    },
    close: async () => undefined,
  };
  return p;
};

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

/** Every line the origin logs, as `[level, message, fields]`. */
function logger(): Logger {
  const l: Logger = {
    debug: (m, b) => void lines.push(JSON.stringify(['debug', m, b ?? {}])),
    info: (m, b) => void lines.push(JSON.stringify(['info', m, b ?? {}])),
    warn: (m, b) => void lines.push(JSON.stringify(['warn', m, b ?? {}])),
    error: (m, b) => void lines.push(JSON.stringify(['error', m, b ?? {}])),
    child: () => l,
  };
  return l;
}

async function start(extra: Partial<ContentOriginOptions> = {}): Promise<string> {
  const origin = await startContentOrigin({
    host: '127.0.0.1',
    port: 0,
    frameAncestors: ['http://localhost:9090'],
    key,
    logger: logger(),
    serve: async (c) => stubs.get(c.artifactId)?.served ?? null,
    htmlPreparer: inThread,
    ...extra,
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

  it('a page the transform refuses is a 422 with one fixed line, the base headers and the strict CSP; the log gets a reason code and nothing else', async () => {
    const base = await start();
    const MARK = 'SECRETPAGECONTENT';
    put('art-secret-id', { bytes: enc(`<!doctype html><plaintext>${MARK}`) });
    const url = tokenUrl(base, 'art-secret-id');
    const refused = await fetch(url);
    expect(refused.status).toBe(422);
    expect(await refused.text()).toBe(HTML_REFUSED_BODY);
    expect(refused.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(refused.headers.get('content-security-policy')).toBe(DOWNLOAD_CSP);
    expect(refused.headers.get('content-disposition')).toBeNull();
    expectBaseHeaders(refused);
    expect(prepare).toHaveLastReturnedWith({ ok: false, reason: 'plaintext' });

    // A warning, not an error: agent content the origin declined is not a fault of the origin.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual([
      'warn',
      'artifacts_content_origin_refused',
      { route: '/v/:token', status: 422, code: 'plaintext', name: 'HtmlRefusal' },
    ]);
    const everything = lines.join('\n');
    for (const secret of [MARK, 'art-secret-id', url.slice(url.lastIndexOf('/') + 1), '/v/garbage']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('a forged token, an unknown artifact and a refused page are told apart by status alone: 404, 404, 422', async () => {
    const base = await start();
    put('bad', { bytes: enc('<plaintext>x') });
    put('good', { bytes: enc('<!doctype html><p>x</p>') });
    const forged = await fetch(`${base}/v/garbage`);
    const missing = await fetch(tokenUrl(base, 'nobody-home'));
    const refused = await fetch(tokenUrl(base, 'bad'));
    expect([forged.status, missing.status, refused.status]).toEqual([404, 404, 422]);
    expect(await forged.text()).toBe('not found');
    expect(await missing.text()).toBe('not found');
    expect(forged.headers.get('content-security-policy')).toBeNull();
    expect(missing.headers.get('content-security-policy')).toBeNull();
    // Only the refused page logs; the two lookups that found nothing log nothing.
    expect(lines).toHaveLength(1);
    expect((await fetch(tokenUrl(base, 'good'))).status).toBe(200);
  });

  it('every reason for a page that is not safe answers with the same status, body and headers, so the viewer cannot tell them apart; the log says which', async () => {
    const base = await start();
    // One page per cause the transform can refuse for that is about what the page does, not how big it is.
    const causes: Array<[string, Uint8Array]> = [
      ['plaintext', enc('<plaintext>x')],
      ['too_deep', enc('<div>'.repeat(600))],
      ['nul', enc('a\u0000b')],
      ['cr_entity', enc('x&#13;y')],
      ['quirks', enc('<!DOCTYPE html foo><p>x</p>')],
      ['too_many_attrs', enc(`<div${Array.from({ length: 300 }, (_, i) => ` a${i}`).join('')}>`)],
    ];
    const answers: string[] = [];
    for (const [code, bytes] of causes) {
      put(code, { bytes });
      const r = await fetch(tokenUrl(base, code));
      answers.push(JSON.stringify([r.status, await r.text(), [...r.headers].filter(([k]) => k !== 'date' && k !== 'content-length')]));
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!).slice(0, 2)).toEqual([422, HTML_REFUSED_BODY]);
    // The log is where the reason is: one warn per refusal, its code, and nothing else about it.
    expect(lines.map((l) => (JSON.parse(l) as [string, string, { code: string }])[2].code)).toEqual(causes.map(([code]) => code));
    for (const l of lines) expect(JSON.parse(l)[0]).toBe('warn');
  });

  it('every reason for a page that is too big or too heavy answers with the second line, and otherwise the same status and headers; the log says which', async () => {
    const MARK = 'SECRETPAGECONTENT';
    // The real causes the transform has for it, by a page that causes each, and the worker's (out of time, out of memory).
    const real: Array<[string, Uint8Array]> = [
      ['html_too_large', new Uint8Array(MAX_HTML_TRANSFORM_BYTES + 1).fill(0x61)],
      ['too_many_nodes', enc(`<p>${MARK}</p>`.repeat(80_000))],
      ['output_too_large', enc(`<p title='${'"'.repeat(1024 * 1024)}'>${MARK}</p>`)],
    ];
    const answers: string[] = [];
    {
      const base = await start();
      for (const [code, bytes] of real) {
        put(code, { bytes });
        const r = await fetch(tokenUrl(base, code));
        answers.push(JSON.stringify([r.status, await r.text(), [...r.headers].filter(([k]) => k !== 'date' && k !== 'content-length')]));
      }
    }
    for (const reason of ['too_slow', 'too_much_work', 'worker_timeout', 'worker_oom'] as const) {
      const base = await start({ htmlPreparer: refusing(reason) });
      put(reason, { bytes: enc(`<p>${MARK}</p>`) });
      const r = await fetch(tokenUrl(base, reason));
      answers.push(JSON.stringify([r.status, await r.text(), [...r.headers].filter(([k]) => k !== 'date' && k !== 'content-length')]));
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!).slice(0, 2)).toEqual([422, HTML_TOO_LARGE_BODY]);
    expect(lines.map((l) => (JSON.parse(l) as [string, string, { code: string }])[2].code)).toEqual([
      'html_too_large',
      'too_many_nodes',
      'output_too_large',
      'too_slow',
      'too_much_work',
      'worker_timeout',
      'worker_oom',
    ]);
    expect(lines.join('\n')).not.toContain(MARK);
  });

  it('a page turned away unseen (busy, the worker failed) is told to try again, not that it is unsafe, whatever the page; the log says which', async () => {
    const answers: string[] = [];
    for (const reason of ['busy', 'worker_failed'] as const) {
      const base = await start({ htmlPreparer: refusing(reason) });
      put(reason, { bytes: enc('<p>x</p>') });
      const r = await fetch(tokenUrl(base, reason));
      answers.push(JSON.stringify([r.status, await r.text(), [...r.headers].filter(([k]) => k !== 'date' && k !== 'content-length')]));
    }
    // The same answer for both, in status, body and headers, and not the one for a page that is not safe.
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!).slice(0, 2)).toEqual([422, HTML_TRY_AGAIN_BODY]);
    expect(HTML_TRY_AGAIN_BODY).not.toBe(HTML_REFUSED_BODY);
    expect(lines.map((l) => (JSON.parse(l) as [string, string, { code: string }])[2].code)).toEqual(['busy', 'worker_failed']);
  });

  it('the three lines are fixed: they say nothing of the limit, the page or what the worker did', () => {
    expect(HTML_REFUSED_BODY).toBe("AX can't show this page safely.");
    expect(HTML_TOO_LARGE_BODY).toBe('This page is too large to preview here. Download it instead.');
    expect(HTML_TRY_AGAIN_BODY).toBe("AX can't show this page right now. Try again in a moment.");
  });

  it('HTML over the transform cap is a 422, never served as it was; at the cap it is served', async () => {
    const base = await start();
    const head = '<!doctype html><p>x</p><!--';
    const tail = '-->';
    const pad = (n: number): string => head + 'a'.repeat(n - head.length - tail.length) + tail;
    put('at', { bytes: enc(pad(MAX_HTML_TRANSFORM_BYTES)) });
    put('over', { bytes: enc(pad(MAX_HTML_TRANSFORM_BYTES + 1)) });

    const over = await fetch(tokenUrl(base, 'over'));
    expect(over.status).toBe(422);
    expect(await over.text()).toBe(HTML_TOO_LARGE_BODY);
    expectBaseHeaders(over);
    expect(over.headers.get('content-security-policy')).toBe(DOWNLOAD_CSP);
    // Refused before it was parsed: the cap exists to bound the CPU.
    expect(prepare).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual([
      'warn',
      'artifacts_content_origin_refused',
      { route: '/v/:token', status: 422, code: 'html_too_large', name: 'HtmlRefusal' },
    ]);

    const at = await fetch(tokenUrl(base, 'at'));
    expect(at.status).toBe(200);
    expect((await at.text()).length).toBeGreaterThan(MAX_HTML_TRANSFORM_BYTES);
  });

  it('a download of a page the viewer refuses is still its bytes: refusal is about what renders', async () => {
    const base = await start();
    put('bad', { bytes: enc('<plaintext>x') });
    const dl = await fetch(tokenUrl(base, 'bad', 'download'));
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('<plaintext>x');
    expect(lines).toHaveLength(0);
  });
});

describe('content origin: what the bytes are, as text', () => {
  const PAGE = '<!doctype html><title>t</title><p>héllo 日本語 😀</p>';
  const utf16le = (text: string): Uint8Array => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const utf16be = (text: string): Uint8Array => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);

  it.each([
    ['UTF-16LE with a byte order mark', utf16le(PAGE)],
    ['UTF-16BE with a byte order mark', utf16be(PAGE)],
  ])('a page saved as %s is served, guarded, text intact, as UTF-8', async (_name, bytes) => {
    const base = await start();
    put('a', { bytes });
    const r = await fetch(tokenUrl(base, 'a'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await r.text();
    expect(body).toMatch(GUARD_FIRST_IN_HEAD);
    expect(body).toContain('<title>t</title></head><body><p>héllo 日本語 😀</p></body></html>');
    expect(body).not.toContain('\u0000');
    expect(body).not.toContain('\ufeff');
    expect(lines).toHaveLength(0);
  });

  it('a UTF-8 byte order mark is dropped, as a browser does', async () => {
    const base = await start();
    put('a', { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PAGE)]) });
    const body = await (await fetch(tokenUrl(base, 'a'))).text();
    expect(body.startsWith('<!DOCTYPE html><html><head><script>')).toBe(true);
    expect(body).toContain('<p>héllo 日本語 😀</p>');
  });

  it('UTF-16 with no byte order mark is not sniffed (a browser would not either): its NULs refuse the page', async () => {
    const base = await start();
    put('a', { bytes: Buffer.from(PAGE, 'utf16le') });
    const r = await fetch(tokenUrl(base, 'a'));
    expect(r.status).toBe(422);
    expect(JSON.parse(lines[0]!)[2]).toMatchObject({ code: 'nul' });
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
    put('pdf', { bytes: PDF, mediaType: 'application/pdf', preview: 'pdf', filename: 'r.pdf' });
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

  it('a refusal is cached too: the same hostile page is not re-parsed, and is still a 422, logged each time', async () => {
    const base = await start();
    put('a', { bytes: enc('<!doctype html><plaintext>x'), contentKey: 'sha-bad' });
    expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
    expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(2);
  });

  it.each(['too_slow', 'worker_timeout', 'worker_oom', 'too_many_nodes', 'output_too_large'] as const)(
    'a page refused as %s is remembered like any refusal: the same bytes are not sent to be prepared again, and are still a 422, logged each time',
    async (reason) => {
      // A hostile page is one that is retried to burn the worker, so the views that follow a refusal do not reach it, and a
      // good page near a limit is the cost of a limit. (How long: `worker_timeout` and `worker_oom` a minute, the rest for
      // good; see 'how long a refusal is remembered'.)
      const preparer = refusing(reason);
      const base = await start({ htmlPreparer: preparer });
      put('a', { bytes: page(1), contentKey: 'sha-slow' });
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
      expect(preparer.asked).toBe(1);
      expect(lines.map((l) => (JSON.parse(l) as [string, string, { code: string }])[2].code)).toEqual([reason, reason, reason]);
    },
  );

  it.each(['busy', 'worker_failed'] as const)(
    'a page refused as %s is not remembered: that is the moment and not the page, and the next view tries again',
    async (reason) => {
      const answers: frameGuard.PreparedPage[] = [{ ok: false, reason }];
      let asked = 0;
      const base = await start({
        htmlPreparer: {
          prepare: async (html) => {
            asked += 1;
            return answers.shift() ?? (await inThread.prepare(html));
          },
          close: async () => undefined,
        },
      });
      put('a', { bytes: page(1), contentKey: 'sha-moment' });
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
      // The next view is prepared, and this time it is fine...
      const second = await fetch(tokenUrl(base, 'a'));
      expect(second.status).toBe(200);
      expect(asked).toBe(2);
      // ...and that one is remembered.
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(200);
      expect(asked).toBe(2);
    },
  );

  it('views of the same bytes that overlap are prepared once: the second waits for the first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    const base = await start({
      htmlPreparer: {
        prepare: async (html) => {
          asked += 1;
          await gate;
          return inThread.prepare(html);
        },
        close: async () => undefined,
      },
    });
    put('a', { bytes: page(1), contentKey: 'sha-once' });
    put('b', { bytes: page(1), contentKey: 'sha-once' });
    const views = [fetch(tokenUrl(base, 'a')), fetch(tokenUrl(base, 'b')), fetch(tokenUrl(base, 'a'))];
    // Let all three requests reach the preparer's door before it opens.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toBe(1);
    release();
    const bodies = await Promise.all(views.map(async (v) => (await v).text()));
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('page 1');
    expect(asked).toBe(1);
  });

  it('views of pages with no content key are each prepared, and are never waited for', async () => {
    let asked = 0;
    const base = await start({
      htmlPreparer: {
        prepare: async (html) => {
          asked += 1;
          return inThread.prepare(html);
        },
        close: async () => undefined,
      },
    });
    put('a', { bytes: page(1) });
    await Promise.all([fetch(tokenUrl(base, 'a')), fetch(tokenUrl(base, 'a'))].map(async (v) => (await v).arrayBuffer()));
    expect(asked).toBe(2);
  });

  describe('refusals are kept apart from pages', () => {
    // A hundred hostile pages viewed in turn used to push every page someone was reading out of the sixteen,
    // and seventeen of them in rotation were prepared again on every lap.
    it('however many pages are refused, none of them pushes a page out of the cache', async () => {
      const base = await start({ htmlCache: { maxEntries: 2 } });
      put('good1', { bytes: page(1), contentKey: 'sha-good-1' });
      put('good2', { bytes: page(2), contentKey: 'sha-good-2' });
      await (await fetch(tokenUrl(base, 'good1'))).arrayBuffer();
      await (await fetch(tokenUrl(base, 'good2'))).arrayBuffer();
      expect(prepare).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 40; i++) {
        put(`bad${i}`, { bytes: enc(`<!doctype html><plaintext>${i}`), contentKey: `sha-bad-${i}` });
        expect((await fetch(tokenUrl(base, `bad${i}`))).status).toBe(422);
      }
      expect(prepare).toHaveBeenCalledTimes(42);
      // Both pages are still there: viewing them prepares nothing.
      expect((await fetch(tokenUrl(base, 'good1'))).status).toBe(200);
      expect((await fetch(tokenUrl(base, 'good2'))).status).toBe(200);
      expect(prepare).toHaveBeenCalledTimes(42);
    });

    it('and they do not count against the pages\' entries: two pages and forty refusals are all kept', async () => {
      const base = await start({ htmlCache: { maxEntries: 2 } });
      for (let i = 0; i < 40; i++) put(`bad${i}`, { bytes: enc(`<!doctype html><plaintext>${i}`), contentKey: `sha-bad-${i}` });
      for (let i = 0; i < 40; i++) await (await fetch(tokenUrl(base, `bad${i}`))).arrayBuffer();
      for (let i = 0; i < 40; i++) await (await fetch(tokenUrl(base, `bad${i}`))).arrayBuffer();
      expect(prepare).toHaveBeenCalledTimes(40); // the second lap prepared nothing
    });

    it('a refusal is remembered in rotation of far more than sixteen: a lap of 40 hostile pages prepares each once', async () => {
      const base = await start();
      for (let i = 0; i < 40; i++) put(`bad${i}`, { bytes: enc(`<!doctype html><plaintext>${i}`), contentKey: `sha-bad-${i}` });
      for (let lap = 0; lap < 3; lap++) for (let i = 0; i < 40; i++) await (await fetch(tokenUrl(base, `bad${i}`))).arrayBuffer();
      expect(prepare).toHaveBeenCalledTimes(40);
    });

    it('is bounded all the same: past maxRefusals the oldest refusal is forgotten (and prepared again), and a hit keeps one fresh', async () => {
      const base = await start({ htmlCache: { maxRefusals: 3 } });
      for (let i = 0; i < 4; i++) put(`bad${i}`, { bytes: enc(`<!doctype html><plaintext>${i}`), contentKey: `sha-bad-${i}` });
      const view = async (i: number): Promise<void> => void (await (await fetch(tokenUrl(base, `bad${i}`))).arrayBuffer());
      await view(0);
      await view(1);
      await view(2);
      await view(0); // a hit: 0 is now the newest, 1 the oldest
      expect(prepare).toHaveBeenCalledTimes(3);
      await view(3); // a fourth: 1 goes
      expect(prepare).toHaveBeenCalledTimes(4);
      await view(0);
      await view(2);
      await view(3);
      expect(prepare).toHaveBeenCalledTimes(4); // all three still there
      await view(1);
      expect(prepare).toHaveBeenCalledTimes(5); // 1 was forgotten
    });
  });

  describe('how long a refusal is remembered', () => {
    const THE_MINUTE = 60_000;
    function clock(): { now: () => number; set: (ms: number) => void } {
      let t = 1_000_000;
      return { now: () => t, set: (ms) => void (t = 1_000_000 + ms) };
    }

    it.each([
      ['worker_timeout', 'it is a wall-clock deadline, and a good page can meet a bad minute'],
      ['worker_oom', 'a page can sit on the edge of the heap limit, and the kernel that kills a worker for the pod\'s memory is not the page'],
    ] as const)('a %s is remembered for a minute and no longer: %s', async (reason) => {
      const c = clock();
      const preparer = refusing(reason);
      const base = await start({ htmlPreparer: preparer, htmlCache: { now: c.now } });
      put('a', { bytes: page(1), contentKey: 'sha-held' });
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
      c.set(THE_MINUTE - 1);
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
      expect(preparer.asked).toBe(1); // inside the minute: not prepared again
      c.set(THE_MINUTE);
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
      expect(preparer.asked).toBe(2); // the minute is up: it gets another go...
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
      expect(preparer.asked).toBe(2); // ...and is remembered for a minute from then
    });

    it('a page that meets a bad minute and is fine the next time is served, and stays served', async () => {
      const c = clock();
      const answers: frameGuard.PreparedPage[] = [{ ok: false, reason: 'worker_timeout' }];
      const base = await start({
        htmlPreparer: {
          prepare: async (html) => answers.shift() ?? (await inThread.prepare(html)),
          close: async () => undefined,
        },
        htmlCache: { now: c.now },
      });
      put('a', { bytes: page(1), contentKey: 'sha-bad-minute' });
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
      c.set(THE_MINUTE);
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(200);
      c.set(10 * THE_MINUTE);
      expect((await fetch(tokenUrl(base, 'a'))).status).toBe(200);
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it('measures the minute on a monotonic clock: setting the system clock neither forgets a refusal nor keeps one for good', async () => {
      // No `now` option: the clock the origin has when nothing moves it. The system clock is a spy from before the origin
      // starts (an origin that took `Date.now` as its clock took the spy), that says what time it is by an offset the test
      // moves. A view token is checked against the system clock too, so each request is signed after the clock is set.
      const realNow = Date.now.bind(Date);
      let offsetMs = 0;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
      try {
        const preparer = refusing('worker_timeout');
        const base = await start({ htmlPreparer: preparer });
        put('a', { bytes: page(1), contentKey: 'sha-monotonic' });
        expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
        expect(preparer.asked).toBe(1);
        offsetMs = 2 * 3_600_000; // the system clock is put forward two hours...
        expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
        expect(preparer.asked).toBe(1); // ...and no time has gone by for the refusal
        offsetMs = -2 * 3_600_000; // ...and back four
        expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
        expect(preparer.asked).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it.each(['too_slow', 'output_too_large', 'too_many_nodes', 'plaintext'] as const)(
      'a refusal as %s is the page\'s and is remembered for good, however long it is since',
      async (reason) => {
        const c = clock();
        const preparer = refusing(reason);
        const base = await start({ htmlPreparer: preparer, htmlCache: { now: c.now } });
        put('a', { bytes: page(1), contentKey: 'sha-forever' });
        expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
        c.set(365 * 24 * 60 * THE_MINUTE);
        expect((await fetch(tokenUrl(base, 'a'))).status).toBe(422);
        expect(preparer.asked).toBe(1);
      },
    );

    it('a refusal that has run out is taken out, so that when it is remembered again it is the newest and not in the place it was', async () => {
      const c = clock();
      const preparer = refusing('worker_timeout');
      const base = await start({ htmlPreparer: preparer, htmlCache: { now: c.now, maxRefusals: 2 } });
      for (const id of ['a', 'b', 'c']) put(id, { bytes: page(1), contentKey: `sha-${id}` });
      const view = async (id: string): Promise<void> => void (await (await fetch(tokenUrl(base, id))).arrayBuffer());
      await view('a');
      await view('b');
      c.set(THE_MINUTE); // both have run out
      await view('a'); // prepared again, and remembered again: now the newest of the two
      expect(preparer.asked).toBe(3);
      await view('c'); // a third: the oldest goes, and that is b (which ran out), not a
      expect(preparer.asked).toBe(4);
      await view('a');
      expect(preparer.asked).toBe(4); // still there
    });
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

  describe('its byte bound', () => {
    // The bound is on the bytes of prepared pages, apart from how many there are: 1 MiB pages against a 2.5 MiB
    // bound (the real one is 32 MiB, and 4 MiB pages are what it is for, which is a second of test per page).
    const MAX_BYTES = 2.5 * 1024 * 1024;
    const PAGES = 6;
    const big = (n: number, mib = 1): Uint8Array => {
      const head = `<!doctype html><p>big ${n}</p><!--`;
      const tail = '-->';
      return enc(head + 'a'.repeat(mib * 1024 * 1024 - head.length - tail.length) + tail);
    };
    const view = async (base: string, id: string): Promise<void> => void (await (await fetch(tokenUrl(base, id))).arrayBuffer());

    it('pushes the oldest pages out by size with only a few in it, keeps the newest, and takes back what it pushed out', async () => {
      const base = await start({ htmlCache: { maxBytes: MAX_BYTES } });
      for (let i = 0; i < PAGES; i++) put(`b${i}`, { bytes: big(i), contentKey: `sha-big-${i}` });
      for (let i = 0; i < PAGES; i++) await view(base, `b${i}`);
      expect(prepare).toHaveBeenCalledTimes(PAGES);

      // The two newest fit in 2.5 MiB and are still there: what the bound took out was the oldest, not
      // everything. (If the bytes of a page it pushed out were never taken back, it would think it was still
      // over, and push these out too.)
      await view(base, `b${PAGES - 1}`);
      await view(base, `b${PAGES - 2}`);
      expect(prepare).toHaveBeenCalledTimes(PAGES);
      // The oldest is not: six pages are far under the 16 the entry bound allows, so only the bytes sent it away.
      await view(base, 'b0');
      expect(prepare).toHaveBeenCalledTimes(PAGES + 1);
    });

    it('does not cache a page bigger than the whole bound, and does not push the others out to make room for it', async () => {
      const base = await start({ htmlCache: { maxBytes: MAX_BYTES } });
      put('s0', { bytes: big(0), contentKey: 'sha-s0' });
      put('s1', { bytes: big(1), contentKey: 'sha-s1' });
      put('huge', { bytes: big(2, 3), contentKey: 'sha-huge' }); // 3 MiB against a 2.5 MiB bound
      await view(base, 's0');
      await view(base, 's1');
      await view(base, 'huge');
      expect(prepare).toHaveBeenCalledTimes(3);
      // The two small ones are still there; the huge one never was.
      await view(base, 's0');
      await view(base, 's1');
      expect(prepare).toHaveBeenCalledTimes(3);
      await view(base, 'huge');
      expect(prepare).toHaveBeenCalledTimes(4);
    });

    it('holds at its real size: 4 MiB pages against the real 32 MiB bound, with ten pages (far fewer than 16): the newest seven', { timeout: 60_000 }, async () => {
      // The pages the origin transforms at most (4 MiB each, 4.2 MB prepared): eight are over 32 MiB, so seven are kept and
      // the three oldest of ten have gone by size. This one runs the default bound, which the tests above lower to stay
      // quick, and which is four times the most a prepared page can be (8 MiB): a bound of one such page keeps only the newest.
      const base = await start();
      const TEN = 10;
      for (let i = 0; i < TEN; i++) put(`r${i}`, { bytes: big(i, 4), contentKey: `sha-real-${i}` });
      for (let i = 0; i < TEN; i++) await view(base, `r${i}`);
      expect(prepare).toHaveBeenCalledTimes(TEN);
      for (const i of [9, 8, 7, 6, 5, 4, 3]) await view(base, `r${i}`); // the newest seven are all still there
      expect(prepare).toHaveBeenCalledTimes(TEN);
      await view(base, 'r2'); // the eighth newest went by size
      expect(prepare).toHaveBeenCalledTimes(TEN + 1);
    });

    it('is a bound apart from the entry bound: the same pages with room for every byte are all kept', async () => {
      const base = await start({ htmlCache: { maxBytes: 64 * 1024 * 1024 } });
      for (let i = 0; i < PAGES; i++) put(`b${i}`, { bytes: big(i), contentKey: `sha-big-${i}` });
      for (let i = 0; i < PAGES; i++) await view(base, `b${i}`);
      for (let i = 0; i < PAGES; i++) await view(base, `b${i}`);
      expect(prepare).toHaveBeenCalledTimes(PAGES);
    });
  });
});
