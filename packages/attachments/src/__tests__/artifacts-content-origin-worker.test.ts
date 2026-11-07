import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@ax/core';
import * as frameGuard from '@ax/frame-guard';
import { createHtmlPreparer, type HtmlPreparer } from '@ax/frame-guard';
import {
  HTML_TOO_LARGE_BODY,
  HTML_TRY_AGAIN_BODY,
  MAX_HTML_TRANSFORM_BYTES,
  startContentOrigin,
  type ContentOriginOptions,
  type ServedArtifact,
} from '../artifacts/content-origin.js';
import { signViewToken } from '../artifacts/view-token.js';

// The content origin on its real HTML preparer: the worker thread @ax/frame-guard
// starts, from the compiled package (this is how it is used, and the only form a worker
// can be started from). The transform bounds what it costs by counts and a CPU-time budget,
// and a third review round after the first two found pages that got past both: one that cost
// the whole budget and held the thread that serves every request for 1.6 s, one that ended the
// process. What these tests hold is that neither is the origin's problem any more: whatever a
// page costs, it costs it on the worker, and the origin keeps answering.

// Counts the calls of the transform made in THIS thread, the one that serves every request. The worker
// thread loads its own copy of the package, so a call it makes is not counted here: what is counted is a
// page that was prepared on the request thread.
// The preparers the origin makes for itself are watched too: what options it made them with can be added to
// (a worker that cannot start), and whether it closed them.
const made = vi.hoisted(() => ({ preparers: [] as Array<{ close: () => Promise<void> }>, extra: {} as Record<string, unknown> }));
vi.mock('@ax/frame-guard', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ax/frame-guard')>();
  return {
    ...real,
    prepareArtifactHtml: vi.fn(real.prepareArtifactHtml),
    createHtmlPreparer: vi.fn((options?: Parameters<typeof real.createHtmlPreparer>[0]) => {
      const preparer = real.createHtmlPreparer({ ...options, ...made.extra });
      const close = preparer.close.bind(preparer);
      preparer.close = vi.fn(close);
      made.preparers.push(preparer);
      return preparer;
    }),
  };
});
const transformHere = vi.mocked(frameGuard.prepareArtifactHtml);

const MiB = 1024 * 1024;
const CAP = MAX_HTML_TRANSFORM_BYTES;

const key = randomBytes(32);
const closers: Array<() => Promise<void>> = [];
const stubs = new Map<string, ServedArtifact>();
let lines: string[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  stubs.clear();
  lines = [];
  transformHere.mockClear();
  made.preparers.length = 0;
  made.extra = {};
});

function logger(): Logger {
  const l: Logger = {
    debug: () => undefined,
    info: () => undefined,
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
    serve: async (c) => stubs.get(c.artifactId) ?? null,
    ...extra,
  });
  closers.push(() => origin.close());
  return origin.url;
}

function put(id: string, bytes: Uint8Array, contentKey: string | undefined = `sha-${id}`): void {
  stubs.set(id, { bytes, mediaType: 'text/html', preview: 'html', filename: 'a.html', ...(contentKey === undefined ? {} : { contentKey }) });
}

function tokenUrl(base: string, id: string): string {
  const t = signViewToken(key, { artifactId: id, version: 1, purpose: 'view', linkBinding: null, expiresAt: Math.floor(Date.now() / 1000) + 60 });
  return `${base}/v/${t}`;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const repeat = (unit: string, bytes: number, head = ''): string => head + unit.repeat(Math.ceil(Math.max(0, bytes - head.length) / unit.length));

/** The shape the clock alone stops: a block of 70,000 children the adoption agency moves one at a time, in a 4 MiB page. */
function holdsTheThread(): Uint8Array {
  const adopted = repeat('<i></i>', MiB - 12, '<a><div>') + '</a>';
  return enc(`<!--${'x'.repeat(CAP - adopted.length - 7)}-->${adopted}`);
}

/** The page that ended the host: 80 copies of a 200 KiB attribute of quotes, each written six characters per quote. */
function endsTheHost(): Uint8Array {
  const each = Math.floor((CAP - 2000) / 20);
  let page = '<div>';
  for (let i = 0; i < 20; i++) page += `<b x=${i} y='${'"'.repeat(each)}'>`;
  return enc(`${page}</div>${'<div><span></div>'.repeat(3)}`);
}

/**
 * How late the event loop ran its timers while `during` ran: the longest the thread that serves every
 * request was held. A timer every 10 ms, and the most one of them was late by.
 */
async function loopLag<T>(during: () => Promise<T>): Promise<{ result: T; lagMs: number; elapsedMs: number }> {
  let lagMs = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const t = performance.now();
    lagMs = Math.max(lagMs, t - last - 10);
    last = t;
  }, 10);
  const started = performance.now();
  try {
    const result = await during();
    return { result, lagMs, elapsedMs: performance.now() - started };
  } finally {
    clearInterval(ticker);
  }
}

/** The loop is not held by a page's work: this much late is nothing, and a held loop is more than a second late. */
const LAG_OK_MS = 400;

describe('the content origin on its real worker thread', () => {
  it('serves an ordinary page, guard first in head, with the headers it always had', async () => {
    const base = await start();
    put('a', enc('<!doctype html><title>t</title><p>hello</p><iframe srcdoc="x"></iframe>'));
    const r = await fetch(tokenUrl(base, 'a'));
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
    expect(body).toMatch(/<head><script>[\s\S]*?axFrameGuard[\s\S]*?<\/script>/);
    expect(body).toContain('<p>hello</p>');
    expect(body).not.toMatch(/<iframe/i);
    expect(lines).toEqual([]);
  });

  it('never runs the transform on the thread that serves requests: not for a page it serves, one it refuses, or one it remembers', async () => {
    // The transform's own time ceiling is 500 ms where nothing else runs it for longer (the worker is given 1.5 s),
    // and a page it has to refuse costs all of it. Whatever the origin is given, it goes to the worker.
    const base = await start();
    put('good', enc('<!doctype html><title>t</title><p>ok</p>'));
    put('refused', enc('<plaintext>x'));
    put('slow', holdsTheThread());
    put('big', enc(`<!doctype html><script>${'a=1;'.repeat(CAP / 4 - 64)}</script>`));
    for (const id of ['good', 'good', 'refused', 'refused', 'slow', 'slow', 'big']) {
      await (await fetch(tokenUrl(base, id))).arrayBuffer();
    }
    expect(transformHere).not.toHaveBeenCalled();
    // ...and the pages really were prepared: this is not a test of an origin that served nothing.
    expect(lines.map((l) => (JSON.parse(l) as [string, string, { code: string }])[2].code)).toEqual([
      'plaintext',
      'plaintext',
      'too_slow',
      'too_slow',
    ]);
  });

  it('serves a page with text that is not ASCII exactly as the transform writes it', async () => {
    const base = await start();
    put('a', enc('<!doctype html><title>t</title><p>héllo 日本語 😀 &amp; "quoted"</p>'));
    const body = await (await fetch(tokenUrl(base, 'a'))).text();
    expect(body).toContain('<p>héllo 日本語 😀 &amp; "quoted"</p>');
  });

  it('a page that costs the whole time budget (4 MiB, the clock alone stops it) is refused, and the loop that serves everyone is not held', async () => {
    const base = await start();
    put('slow', holdsTheThread());
    const first = await loopLag(async () => {
      const r = await fetch(tokenUrl(base, 'slow'));
      return [r.status, await r.text()] as const;
    });
    expect(first.result).toEqual([422, HTML_TOO_LARGE_BODY]);
    // Held in the thread that serves requests, this was the whole 1.6 s budget; on the worker it is nothing.
    expect(first.lagMs).toBeLessThan(LAG_OK_MS);
    expect(first.elapsedMs).toBeLessThan(8000);

    // The same bytes again: remembered, so it costs the worker nothing and takes a moment, however often it is asked.
    const again = await loopLag(async () => {
      const r = await fetch(tokenUrl(base, 'slow'));
      return [r.status, await r.text()] as const;
    });
    expect(again.result).toEqual([422, HTML_TOO_LARGE_BODY]);
    expect(again.elapsedMs).toBeLessThan(Math.max(250, first.elapsedMs / 4));
    expect(lines.map((l) => (JSON.parse(l) as [string, string, { code: string }])[2].code)).toEqual(['too_slow', 'too_slow']);
  });

  it('the 4 MiB page that ended the host (millions of quotes to escape) is refused, and the next page is served', async () => {
    const base = await start();
    put('blow', endsTheHost());
    put('after', enc('<!doctype html><p>still here</p>'));
    const refused = await loopLag(async () => {
      const r = await fetch(tokenUrl(base, 'blow'));
      return [r.status, await r.text()] as const;
    });
    expect(refused.result).toEqual([422, HTML_TOO_LARGE_BODY]);
    expect(refused.lagMs).toBeLessThan(LAG_OK_MS);
    expect(JSON.parse(lines[0]!)[2]).toMatchObject({ code: 'output_too_large' });
    const r = await fetch(tokenUrl(base, 'after'));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('<p>still here</p>');
  });

  it('a 4 MiB page of script, the heaviest an ordinary page gets (about 270 MB of heap), is served with the heap the worker is given', async () => {
    const base = await start();
    put('big', enc(`<!doctype html><script>${'a=1;'.repeat(CAP / 4 - 64)}</script>`));
    const r = await fetch(tokenUrl(base, 'big'));
    expect(r.status).toBe(200);
    expect((await r.text()).length).toBeGreaterThan(CAP - 1000);
  });

  it('turns a page away when the worker is taken, and does not remember it: the next view is prepared', async () => {
    const preparer = createHtmlPreparer({ maxQueued: 0 });
    closers.push(() => preparer.close());
    const base = await start({ htmlPreparer: preparer });
    put('one', enc(`<!doctype html><script>${'a=1;'.repeat(CAP / 4 - 64)}</script>`));
    put('two', enc('<!doctype html><p>two</p>'));
    // The first holds the worker for a few hundred milliseconds; the second arrives while it does (a moment after
    // it was sent, not at the same time: two requests sent together reach the server in either order).
    const firstView = fetch(tokenUrl(base, 'one'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const two = await fetch(tokenUrl(base, 'two'));
    const one = await firstView;
    expect(one.status).toBe(200);
    expect([two.status, await two.text()]).toEqual([422, HTML_TRY_AGAIN_BODY]);
    expect(lines.map((l) => (JSON.parse(l) as [string, string, { code: string }])[2].code)).toEqual(['busy']);
    const retry = await fetch(tokenUrl(base, 'two'));
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('<p>two</p>');
  });

  it('a worker that cannot start is an error in the log (the codes of the failure and nothing else) and a refusal for the viewer, not a hang', async () => {
    made.extra = { workerUrl: new URL('file:///there-is-no-such-worker-entry.js') };
    const base = await start();
    put('a', enc('<!doctype html><p>x</p>'));
    const r = await fetch(tokenUrl(base, 'a'));
    expect([r.status, await r.text()]).toEqual([422, HTML_TRY_AGAIN_BODY]);
    const logged = lines.map((l) => JSON.parse(l) as [string, string, Record<string, unknown>]);
    // The failure, as an error with its codes; then the refusal the viewer got, as the warning it always is.
    expect(logged.map(([level, message]) => [level, message])).toEqual([
      ['error', 'artifacts_content_origin_worker_failed'],
      ['warn', 'artifacts_content_origin_refused'],
    ]);
    expect(logged[0]![2]).toMatchObject({ code: expect.stringMatching(/MODULE_NOT_FOUND$/) });
    expect(logged[1]![2]).toMatchObject({ code: 'worker_failed' });
    expect(JSON.stringify(logged)).not.toContain('there-is-no-such-worker-entry');
    // ...and it is not remembered: the next view tries a worker again (and the log says so again).
    await (await fetch(tokenUrl(base, 'a'))).arrayBuffer();
    expect(lines.filter((l) => l.includes('artifacts_content_origin_worker_failed'))).toHaveLength(2);
  });

  it('closing the origin closes the worker it made, and not one it was given', async () => {
    const base = await start();
    put('a', enc('<!doctype html><p>x</p>'));
    expect((await fetch(tokenUrl(base, 'a'))).status).toBe(200);
    expect(made.preparers).toHaveLength(1);
    await closers.pop()!();
    expect(made.preparers[0]!.close).toHaveBeenCalledTimes(1);

    let closed = 0;
    const given: HtmlPreparer = {
      prepare: async () => ({ ok: true, bytes: enc('<p>given</p>') }),
      close: async () => void (closed += 1),
    };
    const origin = await startContentOrigin({
      host: '127.0.0.1',
      port: 0,
      frameAncestors: ['http://localhost:9090'],
      key,
      serve: async () => null,
      htmlPreparer: given,
    });
    await origin.close();
    expect(closed).toBe(0);
    expect(made.preparers).toHaveLength(1); // and it made none of its own for that one
  });
});
