import * as http from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { MAX_FRAME } from '@ax/core';
import {
  BadJsonError,
  readJsonBody,
  readRawBody,
  TooLargeError,
} from '../body.js';

// ---------------------------------------------------------------------------
// Body reader tests
//
// We use a pair of in-process http.Server + http.request to drive realistic
// IncomingMessage streams through readJsonBody. This avoids synthesizing
// Readable mocks and picks up every real-world behavior (end events, data
// chunks, content-length handling) for free.
// ---------------------------------------------------------------------------

interface BodyHarness {
  url: string;
  received: Promise<{ value?: unknown; bytesRead?: number; err?: Error }>;
  close: () => Promise<void>;
}

async function startHarness(maxBytes: number): Promise<BodyHarness> {
  let resolveReceived!: (v: { value?: unknown; bytesRead?: number; err?: Error }) => void;
  const received = new Promise<{ value?: unknown; bytesRead?: number; err?: Error }>((resolve) => {
    resolveReceived = resolve;
  });

  const server = http.createServer(async (req, res) => {
    try {
      const { value, bytesRead } = await readJsonBody(req, maxBytes);
      resolveReceived({ value, bytesRead });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      resolveReceived({ err: err as Error });
      try {
        if (!res.headersSent) {
          res.writeHead(400);
          res.end('rejected');
        }
      } catch {
        // ignore
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server.address() returned unexpected shape');
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface PostOptions {
  body?: Buffer | string;
  contentLength?: number;
  headers?: Record<string, string>;
  abortAfterHeaders?: boolean;
}

async function post(url: string, opts: PostOptions = {}): Promise<http.IncomingMessage | undefined> {
  const u = new URL(url);
  const body = opts.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.contentLength !== undefined) {
    headers['Content-Length'] = String(opts.contentLength);
  } else if (opts.body !== undefined) {
    headers['Content-Length'] = String(body.length);
  }

  return new Promise<http.IncomingMessage | undefined>((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port),
        method: 'POST',
        path: '/',
        headers,
      },
      (res) => {
        // Drain to not leak connections.
        res.resume();
        resolve(res);
      },
    );
    req.on('error', (err) => {
      // Connection can be forcibly closed by our handler; that's expected
      // for the mid-stream overflow test.
      resolve(undefined);
      // Suppress unhandled rejection propagation — tests only await the
      // harness.received promise.
      void err;
      void reject;
    });
    req.write(body);
    req.end();
  });
}

describe('readJsonBody', () => {
  const harnesses: BodyHarness[] = [];

  afterEach(async () => {
    for (const h of harnesses) await h.close();
    harnesses.length = 0;
  });

  it('reads a small JSON body and returns parsed value + bytesRead', async () => {
    const h = await startHarness(MAX_FRAME);
    harnesses.push(h);
    await post(h.url, { body: JSON.stringify({ hello: 'world' }) });
    const got = await h.received;
    expect(got.err).toBeUndefined();
    expect(got.value).toEqual({ hello: 'world' });
    expect(got.bytesRead).toBe(Buffer.byteLength(JSON.stringify({ hello: 'world' })));
  });

  it('rejects with TooLargeError when Content-Length exceeds cap (fails fast)', async () => {
    // Cap = 16 bytes; claim 1024 via Content-Length; send empty body. The
    // fail-fast path must NOT require any bytes to arrive.
    const cap = 16;
    const h = await startHarness(cap);
    harnesses.push(h);
    await post(h.url, { body: '', contentLength: 1024 });
    const got = await h.received;
    expect(got.err).toBeInstanceOf(TooLargeError);
    expect((got.err as Error).message).toContain('1024');
    // Fail-fast means the server rejects on the Content-Length header without
    // ever reading the (empty) body, but the request still has to round-trip a
    // real HTTP socket whose handshake/teardown dance settles at a stable ~4 s —
    // ~80% of vitest's 5 s default per-test timeout. Give it explicit headroom
    // so a loaded CI runner can't tip it over (mirrors PR #146). (TASK-5)
  }, 15_000);

  it('rejects with TooLargeError when streamed body crosses the cap mid-flight', async () => {
    // We can't easily make http.request send a body that disagrees with its
    // Content-Length header (Node enforces consistency). Instead, synthesize
    // a Readable that emits chunks larger than the cap and has no
    // content-length header — this exercises the accumulator path directly.
    const { Readable } = await import('node:stream');
    const cap = 8;
    const chunks = [Buffer.alloc(4, 0x61), Buffer.alloc(16, 0x62)]; // 20 bytes total > 8
    let idx = 0;
    const fakeReq = new Readable({
      read() {
        if (idx < chunks.length) {
          this.push(chunks[idx++]);
        } else {
          this.push(null);
        }
      },
    });
    (fakeReq as unknown as { headers: Record<string, string> }).headers = {};

    let caught: unknown;
    try {
      await readJsonBody(fakeReq as unknown as http.IncomingMessage, cap);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TooLargeError);
    expect((caught as Error).message).toContain(`cap ${cap}`);
  });

  it('rejects with BadJsonError on invalid JSON', async () => {
    const h = await startHarness(MAX_FRAME);
    harnesses.push(h);
    await post(h.url, { body: '{"a":' });
    const got = await h.received;
    expect(got.err).toBeInstanceOf(BadJsonError);
    expect((got.err as Error).message.length).toBeGreaterThan(0);
  });

  it('propagates stream errors unchanged', async () => {
    // Simulate a stream error by emitting on a synthesized Readable — easier
    // than triggering a real socket error across a TCP pair.
    const { Readable } = await import('node:stream');
    const fakeReq = new Readable({
      read() {
        // Emit an error on next tick so readJsonBody's listener is attached.
        queueMicrotask(() => this.destroy(new Error('boom')));
      },
    });
    // Pretend to be IncomingMessage: headers empty, content-length missing.
    (fakeReq as unknown as { headers: Record<string, string> }).headers = {};

    let caught: unknown;
    try {
      await readJsonBody(fakeReq as unknown as http.IncomingMessage);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe('boom');
    // Not a TooLargeError / BadJsonError — propagated unchanged.
    expect(caught).not.toBeInstanceOf(TooLargeError);
    expect(caught).not.toBeInstanceOf(BadJsonError);
  });
});

// ---------------------------------------------------------------------------
// TASK-1024: a request that is already gone must SETTLE, not hang.
//
// Both readers used to attach data/error/end listeners and wait. A request the
// client hung up on BEFORE those listeners attached has already emitted its
// last event, so nothing ever fired and the promise never settled. A bare
// destroy() AFTER attach emits only 'close', which they didn't listen for
// either. Each case races the read against a short timer so a regression
// reads as "hung", not as a vitest timeout.
// ---------------------------------------------------------------------------

describe('body readers on a request that is already gone (TASK-1024)', () => {
  type Outcome = { kind: 'resolved' } | { kind: 'rejected'; err: unknown } | { kind: 'hung' };

  async function settleWithin(p: Promise<unknown>, ms = 500): Promise<Outcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'hung' }), ms);
    });
    try {
      return await Promise.race([
        p.then(
          (): Outcome => ({ kind: 'resolved' }),
          (err: unknown): Outcome => ({ kind: 'rejected', err }),
        ),
        hung,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fakeReq(): Promise<http.IncomingMessage> {
    const { Readable } = await import('node:stream');
    const r = new Readable({ read() {} });
    (r as unknown as { headers: Record<string, string> }).headers = {};
    return r as unknown as http.IncomingMessage;
  }

  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const GONE = /request was already (destroyed|ended)|request closed before its body was read/;

  const readers: Array<[string, (req: http.IncomingMessage) => Promise<unknown>]> = [
    ['readJsonBody', (req) => readJsonBody(req)],
    ['readRawBody', (req) => readRawBody(req, 1024)],
  ];

  describe.each(readers)('%s', (_name, read) => {
    it('rejects when the request was destroyed before the read', async () => {
      const req = await fakeReq();
      req.destroy();
      await tick(); // let 'close' fire before the reader attaches
      const out = await settleWithin(read(req));
      expect(out.kind).toBe('rejected');
      expect((out as { err: Error }).err.message).toMatch(GONE);
    });

    it('rejects with the original error when the request errored before the read', async () => {
      const req = await fakeReq();
      const boom = new Error('client-reset-early');
      req.on('error', () => {}); // the pre-read error is someone else's to observe
      req.destroy(boom);
      await tick();
      const out = await settleWithin(read(req));
      expect(out).toEqual({ kind: 'rejected', err: boom });
    });

    it('rejects when the request already ended before the read', async () => {
      const req = await fakeReq();
      req.push(null);
      req.resume();
      await new Promise((resolve) => req.on('end', resolve));
      const out = await settleWithin(read(req));
      expect(out.kind).toBe('rejected');
      expect((out as { err: Error }).err.message).toMatch(GONE);
    });

    it('rejects when the request is destroyed mid-read with no error', async () => {
      const req = await fakeReq();
      const p = read(req);
      req.push(Buffer.from('{"partial":'));
      await tick();
      req.destroy();
      const out = await settleWithin(p);
      expect(out.kind).toBe('rejected');
      expect((out as { err: Error }).err.message).toMatch(GONE);
    });

    it('still resolves a body that ends normally (end, then close)', async () => {
      const req = await fakeReq();
      const p = read(req);
      req.push(Buffer.from('{"ok":true}'));
      req.push(null);
      const out = await settleWithin(p);
      expect(out.kind).toBe('resolved');
    });
  });
});
