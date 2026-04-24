import * as http from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import {
  BadJsonError,
  DEFAULT_MAX_BODY_BYTES,
  readJsonBody,
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
    const h = await startHarness(DEFAULT_MAX_BODY_BYTES);
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
  });

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
    const h = await startHarness(DEFAULT_MAX_BODY_BYTES);
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
