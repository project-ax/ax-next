import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin, type HttpServerPlugin } from '../plugin.js';
import type {
  HttpResponse,
  HttpResponseSentEvent,
  HttpRouteHandler,
  SizedBodyOptions,
} from '../types.js';

// ---------------------------------------------------------------------------
// res.bodyStream(): a body of KNOWN length from an async source.
//
// The property every failure test below defends: a body that went wrong (the
// source threw, came up short, ran long, or the client left) must never reach
// the client as a complete response. The server tears the connection down
// instead of ending it, so the client holds fewer bytes than Content-Length
// and knows it.
//
// Failures are observed through node:http over a KEEP-ALIVE connection, which
// is what makes "ended" and "torn down" look different from the outside:
//   - ended short, the server parks the socket for the next request, and the
//     client sits waiting for bytes that never come (until the 5 s keep-alive
//     timeout);
//   - torn down, the client learns at once.
// rawGet() gives up after SETTLE_DEADLINE_MS and reports `timedOut`, so a
// regression from destroy() to end() fails by name instead of by hanging.
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const MiB = 1024 * 1024;
const SETTLE_DEADLINE_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a test source saw of its consumer. */
interface SourceProbe {
  /** Chunks handed out so far. */
  pulls: number;
  /** The generator's `finally` ran: it finished, threw, or was return()ed. */
  released: boolean;
}

/**
 * An async generator over `chunks`. After the last chunk it optionally waits
 * on `gate`, then either finishes or throws `failAfter` on that same pull.
 */
function probedSource(
  chunks: readonly Uint8Array[],
  opts: { failAfter?: Error; gate?: Promise<void> } = {},
): { probe: SourceProbe; source: AsyncIterable<Uint8Array> } {
  const probe: SourceProbe = { pulls: 0, released: false };
  async function* gen(): AsyncGenerator<Uint8Array> {
    try {
      for (const chunk of chunks) {
        probe.pulls += 1;
        yield chunk;
      }
      if (opts.gate !== undefined) await opts.gate;
      if (opts.failAfter !== undefined) throw opts.failAfter;
    } finally {
      probe.released = true;
    }
  }
  return { probe, source: gen() };
}

interface RawResponse {
  /** Undefined when the server never sent a response head. */
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** Node's verdict that the whole Content-Length arrived. */
  complete: boolean;
  /** The client was still waiting when the deadline passed. */
  timedOut: boolean;
}

describe('res.bodyStream()', () => {
  let harness: TestHarness;
  let plugin: HttpServerPlugin;
  let port: number;
  let agent: http.Agent;
  // Set only by the 'idle window' tests, which need a window short enough to wait out.
  let idleMs: number | undefined;

  beforeEach(async () => {
    // Empty allowedOrigins warns on stderr unless this escape hatch is set.
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
    plugin = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY,
      allowedOrigins: [],
      ...(idleMs !== undefined ? { bodyStreamIdleTimeoutMs: idleMs } : {}),
    });
    harness = await createTestHarness({ plugins: [plugin] });
    port = plugin.boundPort();
    agent = new http.Agent({ keepAlive: true });
  });

  afterEach(async () => {
    agent.destroy();
    await harness.close({ onError: () => {} });
  });

  async function route(path: string, handler: HttpRouteHandler): Promise<void> {
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'GET',
      path,
      handler,
    });
  }

  /**
   * Serve `source` at `path`. `outcome` settles with 'resolved', or with
   * whatever bodyStream() rejected with. `prepare` runs first, for headers.
   */
  async function serveBody(
    path: string,
    source: AsyncIterable<Uint8Array>,
    contentLength: number,
    prepare?: (res: HttpResponse) => void,
  ): Promise<{ outcome: Promise<unknown> }> {
    let report!: (value: unknown) => void;
    const outcome = new Promise<unknown>((resolve) => {
      report = resolve;
    });
    await route(path, async (_req, res) => {
      prepare?.(res);
      try {
        await res.bodyStream(source, { contentLength });
        report('resolved');
      } catch (err) {
        report(err);
      }
    });
    return { outcome };
  }

  function rawGet(
    path: string,
    opts: { onResponse?: (res: http.IncomingMessage) => void; deadlineMs?: number } = {},
  ): Promise<RawResponse> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let response: http.IncomingMessage | undefined;
      let settled = false;
      const settle = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status: response?.statusCode,
          headers: response?.headers ?? {},
          body: Buffer.concat(chunks),
          complete: response?.complete ?? false,
          timedOut,
        });
        if (timedOut) req.destroy();
      };
      const timer = setTimeout(() => settle(true), opts.deadlineMs ?? SETTLE_DEADLINE_MS);
      const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
        response = res;
        opts.onResponse?.(res);
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => settle(false));
        res.on('error', () => settle(false));
        res.on('close', () => settle(false));
      });
      req.on('error', () => settle(false));
    });
  }

  it('sends a sized body byte-identical with Content-Length and octet-stream', async () => {
    const chunks = [randomBytes(MiB), randomBytes(MiB), randomBytes(MiB)];
    const { probe, source } = probedSource(chunks);
    const { outcome } = await serveBody('/sized', source, 3 * MiB);

    const r = await fetch(`http://127.0.0.1:${port}/sized`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe('3145728');
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    // None of stream()'s SSE defaults: a download is not an event stream.
    expect(r.headers.get('x-accel-buffering')).toBeNull();
    expect(r.headers.get('cache-control')).toBeNull();
    const got = Buffer.from(await r.arrayBuffer());
    expect(got.equals(Buffer.concat(chunks))).toBe(true);
    expect(await outcome).toBe('resolved');
    expect(probe.released).toBe(true);
  });

  it('a prior header() content-type and cache-control win', async () => {
    const { source } = probedSource([Buffer.from('hi')]);
    const { outcome } = await serveBody('/typed', source, 2, (res) => {
      res.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'private, no-store');
    });

    const r = await fetch(`http://127.0.0.1:${port}/typed`);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(await r.text()).toBe('hi');
    expect(await outcome).toBe('resolved');
  });

  it('Content-Length always comes from contentLength, even over a prior header()', async () => {
    // The wire framing and the byte accounting are one number. Letting a
    // stale header('content-length') through would leave the client waiting
    // for 994 bytes that never come.
    const { source } = probedSource([Buffer.from('hello')]);
    const { outcome } = await serveBody('/framed', source, 5, (res) => {
      res.header('content-length', '999');
    });

    const got = await rawGet('/framed');
    expect(got.timedOut).toBe(false);
    expect(got.headers['content-length']).toBe('5');
    expect(got.body.toString()).toBe('hello');
    expect(got.complete).toBe(true);
    expect(await outcome).toBe('resolved');
  });

  it('a source that throws mid-body leaves the client an incomplete body', async () => {
    const first = randomBytes(MiB);
    const boom = new Error('the disk caught fire');
    const { source } = probedSource([first], { failAfter: boom });
    const { outcome } = await serveBody('/throws', source, 3 * MiB);

    const got = await rawGet('/throws');
    expect(got.timedOut).toBe(false);
    expect(got.status).toBe(200);
    expect(got.headers['content-length']).toBe('3145728');
    expect(got.complete).toBe(false);
    expect(got.body.length).toBeLessThanOrEqual(MiB);
    expect(got.body.equals(first.subarray(0, got.body.length))).toBe(true);
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 'source-failed' });
    expect((err as Error).cause).toBe(boom);
  });

  it('a source that throws after its LAST chunk never delivers that chunk', async () => {
    // The caller's last word (a final "is the file still the same?" check)
    // runs on the pull AFTER the last chunk. The chunk that completes the
    // length waits for it, so a "no" can still keep the body incomplete.
    const chunks = [randomBytes(MiB), randomBytes(MiB), randomBytes(MiB)];
    const { source } = probedSource(chunks, { failAfter: new Error('changed under us') });
    const { outcome } = await serveBody('/last', source, 3 * MiB);

    const got = await rawGet('/last');
    expect(got.timedOut).toBe(false);
    expect(got.status).toBe(200);
    expect(got.complete).toBe(false);
    expect(got.body.length).toBeLessThanOrEqual(2 * MiB);
    expect(await outcome).toMatchObject({ code: 'source-failed' });
  });

  it('a short source is a length-mismatch, never a clean end', async () => {
    const { source } = probedSource([randomBytes(MiB), randomBytes(MiB)]);
    const { outcome } = await serveBody('/short', source, 3 * MiB);

    const got = await rawGet('/short');
    expect(got.timedOut).toBe(false);
    expect(got.status).toBe(200);
    expect(got.complete).toBe(false);
    expect(got.body.length).toBeLessThanOrEqual(2 * MiB);
    expect(await outcome).toMatchObject({ code: 'length-mismatch' });
  });

  it.each([
    { label: '[6, 6] bytes into 10', sizes: [6, 6], length: 10, atMost: 6 },
    {
      label: '[1.5, 1.5] MiB into 2 MiB',
      sizes: [1.5 * MiB, 1.5 * MiB],
      length: 2 * MiB,
      atMost: 1.5 * MiB,
    },
    {
      label: '[1 MiB, 1 MiB, 1 byte] into 2 MiB, so the held final chunk is dropped too',
      sizes: [MiB, MiB, 1],
      length: 2 * MiB,
      atMost: MiB,
    },
  ])('a long source is refused before the excess is written: $label', async ({ sizes, length, atMost }) => {
    const { probe, source } = probedSource(sizes.map((n) => randomBytes(n)));
    const { outcome } = await serveBody('/long', source, length);

    // A few bytes can be torn down before they ever leave the process, so
    // "no response at all" passes too. The MiB rows wait out a drain before
    // the excess shows up, so they see what was really written.
    const got = await rawGet('/long');
    expect(got.timedOut).toBe(false);
    expect(got.complete).toBe(false);
    expect(got.body.length).toBeLessThanOrEqual(atMost);
    expect(await outcome).toMatchObject({ code: 'length-mismatch' });
    // The source was told to stop, not left suspended mid-yield.
    expect(probe.released).toBe(true);
  });

  it("client abort calls the source's return() and rejects client-gone", async () => {
    const chunk = randomBytes(MiB);
    const { probe, source } = probedSource(Array.from({ length: 100 }, () => chunk));
    const { outcome } = await serveBody('/abort', source, 100 * MiB);

    const got = await rawGet('/abort', {
      onResponse: (res) => {
        res.once('data', () => res.destroy());
      },
    });
    expect(got.complete).toBe(false);
    expect(await outcome).toMatchObject({ code: 'client-gone' });
    // 100 chunks were on offer; `released` with fewer pulled means return().
    expect(probe.pulls).toBeLessThan(100);
    expect(probe.released).toBe(true);
  });

  it('backpressure: a paused client stops the source being pulled', async () => {
    const all = randomBytes(64 * MiB);
    const chunks = Array.from({ length: 64 }, (_, i) => all.subarray(i * MiB, (i + 1) * MiB));
    const { probe, source } = probedSource(chunks);
    const { outcome } = await serveBody('/paused', source, all.length);

    let paused: http.IncomingMessage | undefined;
    let headArrived!: () => void;
    const head = new Promise<void>((resolve) => {
      headArrived = resolve;
    });
    const done = rawGet('/paused', {
      onResponse: (res) => {
        res.pause();
        paused = res;
        headArrived();
      },
      deadlineMs: 20_000,
    });
    await head;
    await sleep(300);
    // The socket and kernel buffers hold a few MiB; the source is not drained.
    expect(probe.pulls).toBeLessThanOrEqual(16);

    paused!.resume();
    const got = await done;
    expect(got.timedOut).toBe(false);
    expect(got.complete).toBe(true);
    expect(got.body.equals(all)).toBe(true);
    expect(await outcome).toBe('resolved');
  }, 30_000);

  it('resolves only after the final chunk is flushed, not when it is queued', async () => {
    // One chunk, so it is the held final one, written on its own with a
    // callback. With the client paused, 32 MiB cannot all fit in the socket
    // buffers, so that write (and with it, success) has to wait for the client.
    const body = randomBytes(32 * MiB);
    const { source } = probedSource([body]);
    const { outcome } = await serveBody('/final-flush', source, body.length);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });

    let paused: http.IncomingMessage | undefined;
    let headArrived!: () => void;
    const head = new Promise<void>((resolve) => {
      headArrived = resolve;
    });
    const done = rawGet('/final-flush', {
      onResponse: (res) => {
        res.pause();
        paused = res;
        headArrived();
      },
      deadlineMs: 20_000,
    });
    await head;
    await sleep(200);
    expect(settled).toBe(false);

    paused!.resume();
    const got = await done;
    expect(got.complete).toBe(true);
    expect(got.body.equals(body)).toBe(true);
    expect(await outcome).toBe('resolved');
  }, 30_000);

  it('empty chunks are skipped, even one after the final chunk', async () => {
    // An empty chunk arriving after the held final one must not take its
    // place, or the body would end 2 bytes short.
    const empty = new Uint8Array(0);
    const { source } = probedSource([Buffer.from('hel'), empty, Buffer.from('lo'), empty]);
    const { outcome } = await serveBody('/gaps', source, 5);

    const got = await rawGet('/gaps');
    expect(got.timedOut).toBe(false);
    expect(got.body.toString()).toBe('hello');
    expect(got.complete).toBe(true);
    expect(await outcome).toBe('resolved');
  });

  it('empty body: Content-Length 0 after the source is done', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { source } = probedSource([], { gate });
    const { outcome } = await serveBody('/empty', source, 0);

    let headSeen = false;
    const done = rawGet('/empty', {
      onResponse: () => {
        headSeen = true;
      },
    });
    await sleep(150);
    // The source has not finished, so not even the head has gone out.
    expect(headSeen).toBe(false);

    open();
    const got = await done;
    expect(got.timedOut).toBe(false);
    expect(got.status).toBe(200);
    expect(got.headers['content-length']).toBe('0');
    expect(got.body.length).toBe(0);
    expect(got.complete).toBe(true);
    expect(await outcome).toBe('resolved');
  });

  it('an empty body whose source throws sends no head', async () => {
    const { source } = probedSource([], { failAfter: new Error('could not even start') });
    const { outcome } = await serveBody('/empty-fail', source, 0);

    const got = await rawGet('/empty-fail');
    expect(got.timedOut).toBe(false);
    // Not a 200 with an empty body (that would read as a real empty file).
    expect(got.status).toBeUndefined();
    expect(await outcome).toMatchObject({ code: 'source-failed' });
  });

  it('a chunk that is not bytes is source-failed, and nothing is sent', async () => {
    // A string's .length is not its byte length; letting one through would
    // put the Content-Length accounting and the wire out of step.
    const { source } = probedSource(['abc' as unknown as Uint8Array]);
    const { outcome } = await serveBody('/not-bytes', source, 3);

    const got = await rawGet('/not-bytes');
    expect(got.timedOut).toBe(false);
    expect(got.status).toBeUndefined();
    const err = await outcome;
    expect(err).toMatchObject({ code: 'source-failed' });
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });

  it('a head Node refuses gets the same teardown, and rejects with its error', async () => {
    // header() stores values unchecked; Node checks them when the head is
    // written, which here is the first byte. Torn down, not left hanging.
    const { probe, source } = probedSource([Buffer.from('hel'), Buffer.from('lo')]);
    const { outcome } = await serveBody('/bad-head', source, 5, (res) => {
      res.header('x-bad', 'line\nbreak');
    });

    const got = await rawGet('/bad-head');
    expect(got.timedOut).toBe(false);
    expect(got.status).toBeUndefined();
    expect(await outcome).toMatchObject({ code: 'ERR_INVALID_CHAR' });
    expect(probe.released).toBe(true);
  });

  it('single-shot: json() and header() after bodyStream throw', async () => {
    const attempts: Record<string, string> = {};
    const attempt = (name: string, fn: () => unknown): void => {
      try {
        fn();
        attempts[name] = 'did not throw';
      } catch (err) {
        attempts[name] = (err as Error).message;
      }
    };
    let handlerDone!: () => void;
    const finished = new Promise<void>((resolve) => {
      handlerDone = resolve;
    });
    await route('/single', async (_req, res) => {
      const sending = res.bodyStream(probedSource([Buffer.from('hello')]).source, {
        contentLength: 5,
      });
      attempt('json while sending', () => res.json({ late: true }));
      attempt('header while sending', () => res.header('x-late', '1'));
      await sending;
      attempt('json after', () => res.json({ late: true }));
      attempt('header after', () => res.header('x-late', '1'));
      attempts['bodyStream again'] = await res
        .bodyStream(probedSource([]).source, { contentLength: 0 })
        .then(
          () => 'did not reject',
          (err: unknown) => (err as Error).message,
        );
      handlerDone();
    });

    const r = await fetch(`http://127.0.0.1:${port}/single`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-late')).toBeNull();
    expect(await r.text()).toBe('hello');
    await finished;
    expect(attempts).toEqual({
      'json while sending': 'response already finished',
      'header while sending': 'response already finished',
      'json after': 'response already finished',
      'header after': 'response already finished',
      'bodyStream again': 'response already finished',
    });
  });

  it.each([
    { label: 'a negative contentLength', opts: { contentLength: -1 } },
    { label: 'a fractional contentLength', opts: { contentLength: 1.5 } },
    { label: 'a NaN contentLength', opts: { contentLength: Number.NaN } },
    { label: 'an infinite contentLength', opts: { contentLength: Number.POSITIVE_INFINITY } },
    { label: 'an unsafe contentLength', opts: { contentLength: 2 ** 53 } },
    { label: 'a string contentLength', opts: { contentLength: '5' } },
    { label: 'a missing contentLength', opts: {} },
  ])(
    '$label rejects before anything is written; the handler can still send a 500',
    async ({ opts }) => {
      const { probe, source } = probedSource([Buffer.from('hello')]);
      const seen = await refuseThenRespond('/invalid', source, opts as unknown as SizedBodyOptions);

      const r = await fetch(`http://127.0.0.1:${port}/invalid`);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: 'refused' });
      await seen.handled;
      // It REJECTS (callers chain .catch on it); it does not throw at the call.
      expect(seen.threwSynchronously).toBe(false);
      expect(seen.rejection).toBeInstanceOf(TypeError);
      // Refused before it took the source over: never iterated.
      expect(probe.pulls).toBe(0);
    },
  );

  it('a source that is not async-iterable rejects before anything is written', async () => {
    const seen = await refuseThenRespond(
      '/not-iterable',
      {} as unknown as AsyncIterable<Uint8Array>,
      { contentLength: 0 },
    );

    const r = await fetch(`http://127.0.0.1:${port}/not-iterable`);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'refused' });
    await seen.handled;
    expect(seen.threwSynchronously).toBe(false);
    expect(seen.rejection).toBeInstanceOf(TypeError);
  });

  /** A route that tries bodyStream(), records how it failed, then answers 500 itself. */
  async function refuseThenRespond(
    path: string,
    source: AsyncIterable<Uint8Array>,
    opts: SizedBodyOptions,
  ): Promise<{ threwSynchronously: boolean; rejection: unknown; handled: Promise<void> }> {
    let markHandled!: () => void;
    const seen = {
      threwSynchronously: false,
      rejection: undefined as unknown,
      handled: new Promise<void>((resolve) => {
        markHandled = resolve;
      }),
    };
    await route(path, async (_req, res) => {
      try {
        let pending: Promise<void> | undefined;
        try {
          pending = res.bodyStream(source, opts);
        } catch {
          seen.threwSynchronously = true;
        }
        seen.rejection = await pending?.then(
          () => 'resolved',
          (err: unknown) => err,
        );
        res.status(500).json({ error: 'refused' });
      } finally {
        markHandled();
      }
    });
    return seen;
  }

  it('http:response-sent fires once with status 200 after a streamed body', async () => {
    const events: HttpResponseSentEvent[] = [];
    harness.bus.subscribe('http:response-sent', 'body-stream-observer', async (_ctx, payload) => {
      events.push(payload as HttpResponseSentEvent);
      return undefined;
    });
    const body = randomBytes(2 * MiB);
    // The source dawdles before saying it is done, and the held final chunk
    // waits with it, so the body takes at least that long to finish.
    async function* slowToFinish(): AsyncGenerator<Uint8Array> {
      yield body.subarray(0, MiB);
      yield body.subarray(MiB);
      await sleep(80);
    }
    const { outcome } = await serveBody('/observed', slowToFinish(), body.length);

    const r = await fetch(`http://127.0.0.1:${port}/observed`);
    expect(Buffer.from(await r.arrayBuffer()).equals(body)).toBe(true);
    expect(await outcome).toBe('resolved');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await sleep(50);
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe(200);
    // durationMs spans the whole body, not just the handler's setup.
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(70);
    expect(events[0]!.incomplete).toBe(false);
  });

  it('a body torn after its head is reported incomplete, with the status it was given', async () => {
    const events = responsesSent();
    // The first MiB goes out with the head, so the client really saw the 200.
    // Then the source fails and the body is cut short.
    const { source } = probedSource([randomBytes(MiB)], { failAfter: new Error('gone mid-read') });
    const { outcome } = await serveBody('/torn', source, 2 * MiB);

    const got = await rawGet('/torn');
    expect(got.timedOut).toBe(false);
    expect(got.status).toBe(200);
    expect(got.complete).toBe(false);
    expect(await outcome).toMatchObject({ code: 'source-failed' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events).toEqual([{ status: 200, durationMs: expect.any(Number), incomplete: true }]);
  });

  it('a client that leaves while the final chunk flushes is client-gone, reported incomplete', async () => {
    // REGRESSION (TASK-1016 review): one chunk, so it is the held final one.
    // A client that read about a MiB of it and left used to count as sent,
    // because Node fires 'finish' even when the socket write failed. For any
    // file of one range (1 MiB or less on /files) that was every disconnect.
    const events = responsesSent();
    const body = randomBytes(32 * MiB);
    const { source } = probedSource([body]);
    const { outcome } = await serveBody('/left-final', source, body.length);

    let read = 0;
    const got = await rawGet('/left-final', {
      onResponse: (res) => {
        res.on('data', (c: Buffer) => {
          read += c.length;
          if (read >= MiB) res.destroy();
        });
      },
    });
    expect(got.complete).toBe(false);
    expect(await outcome).toMatchObject({ code: 'client-gone' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events).toEqual([{ status: 200, durationMs: expect.any(Number), incomplete: true }]);
  }, 30_000);

  it('a teardown before the head is reported incomplete too', async () => {
    // Nothing reached the client, so nothing it holds is whole: the
    // connection was cut, and `incomplete` says so even with no head sent.
    const events = responsesSent();
    const { source } = probedSource([], { failAfter: new Error('failed before any byte') });
    const { outcome } = await serveBody('/torn-before-head', source, MiB);

    const got = await rawGet('/torn-before-head');
    expect(got.status).toBeUndefined();
    expect(await outcome).toMatchObject({ code: 'source-failed' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events).toEqual([{ status: 200, durationMs: expect.any(Number), incomplete: true }]);
  });

  /** Every http:response-sent payload from now on, in order. */
  function responsesSent(): HttpResponseSentEvent[] {
    const events: HttpResponseSentEvent[] = [];
    harness.bus.subscribe('http:response-sent', 'response-sent-observer', async (_ctx, payload) => {
      events.push(payload as HttpResponseSentEvent);
      return undefined;
    });
    return events;
  }

  // A client that stops reading is cut off once a wait on it outlasts the
  // window. The paused-client tests read the server's verdict first: a paused
  // client cannot see its connection close until it reads again.
  describe('idle window', () => {
    // Short enough to wait out here. The default is 60 s.
    const WINDOW_MS = 200;

    beforeAll(() => {
      idleMs = WINDOW_MS;
    });
    afterAll(() => {
      idleMs = undefined;
    });

    /** GET `path`, and stop reading as soon as the head arrives. */
    async function getThenStopReading(
      path: string,
    ): Promise<{ paused: http.IncomingMessage; done: Promise<RawResponse> }> {
      let paused: http.IncomingMessage | undefined;
      let headArrived!: () => void;
      const head = new Promise<void>((resolve) => {
        headArrived = resolve;
      });
      const done = rawGet(path, {
        onResponse: (res) => {
          res.pause();
          paused = res;
          headArrived();
        },
        deadlineMs: 10_000,
      });
      await head;
      return { paused: paused!, done };
    }

    /** GET `path` through `via` and read all of it. */
    function getWhole(
      path: string,
      via: http.Agent,
    ): Promise<{ status: number | undefined; body: Buffer; complete: boolean; reusedSocket: boolean }> {
      return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path, agent: via }, (res) => {
          const chunks: Buffer[] = [];
          const finish = (): void =>
            resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks),
              complete: res.complete,
              reusedSocket: req.reusedSocket,
            });
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', finish);
          res.on('close', finish);
          res.on('error', reject);
        });
        req.on('error', reject);
      });
    }

    it('a client that stops reading is cut after the idle window: client-stalled, source released, reported incomplete', async () => {
      const events = responsesSent();
      // 1 GiB on offer, one reused MiB at a time, so nothing big is allocated.
      const chunk = Buffer.alloc(MiB);
      const { probe, source } = probedSource(Array.from({ length: 1024 }, () => chunk));
      const { outcome } = await serveBody('/stalled', source, 1024 * MiB);

      const { paused, done } = await getThenStopReading('/stalled');
      expect(await outcome).toMatchObject({ code: 'client-stalled' });
      // 1024 chunks were on offer; `released` with fewer pulled means return().
      expect(probe.released).toBe(true);
      expect(probe.pulls).toBeLessThan(1024);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events).toEqual([{ status: 200, durationMs: expect.any(Number), incomplete: true }]);

      // Reading again, the client gets what the kernel held, then the close.
      paused.resume();
      const got = await done;
      expect(got.timedOut).toBe(false);
      expect(got.complete).toBe(false);
      expect(got.body.length).toBeLessThan(1024 * MiB);
      expect(events).toHaveLength(1);
    }, 30_000);

    it('a stall while the final chunk flushes is cut too', async () => {
      // One chunk, so it is the held final one, written on its own. 32 MiB
      // cannot all fit in the socket buffers, so with the client paused the
      // pump waits on that write's callback, never on 'drain'.
      const body = randomBytes(32 * MiB);
      const { source } = probedSource([body]);
      const { outcome } = await serveBody('/stalled-final', source, body.length);

      const { paused, done } = await getThenStopReading('/stalled-final');
      expect(await outcome).toMatchObject({ code: 'client-stalled' });

      paused.resume();
      const got = await done;
      expect(got.timedOut).toBe(false);
      expect(got.complete).toBe(false);
    }, 30_000);

    it('the idle window runs only while the client holds things up: a slow source is not a stalled client', async () => {
      const events = responsesSent();
      const chunks = [randomBytes(64 * 1024), randomBytes(64 * 1024), randomBytes(64 * 1024)];
      // Each chunk takes twice the window to arrive. Waiting on the source is
      // not waiting on the client, so none of that time counts.
      async function* slowSource(): AsyncGenerator<Uint8Array> {
        for (const c of chunks) {
          await sleep(2 * WINDOW_MS);
          yield c;
        }
      }
      const { outcome } = await serveBody('/slow-source', slowSource(), 3 * 64 * 1024);

      const got = await rawGet('/slow-source', { deadlineMs: 10_000 });
      expect(await outcome).toBe('resolved');
      expect(got.timedOut).toBe(false);
      expect(got.complete).toBe(true);
      expect(got.body.equals(Buffer.concat(chunks))).toBe(true);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({ status: 200, incomplete: false });
    }, 30_000);

    it('the idle timer dies with the body: the kept-alive connection serves the next request', async () => {
      const body = randomBytes(2 * MiB);
      await route('/kept', async (_req, res) => {
        await res.bodyStream(probedSource([body.subarray(0, MiB), body.subarray(MiB)]).source, {
          contentLength: body.length,
        });
      });
      // Every idle timer the pump arms (the only timers with this delay) must
      // be cleared by the time the body is over. A leftover one keeps `res`
      // alive for the window, once per wait: about 1024 of them for 1 GiB.
      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;
      const armed: unknown[] = [];
      const cleared = new Set<unknown>();
      const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        fn: () => void,
        ms?: number,
        ...rest: unknown[]
      ) => {
        const handle = realSetTimeout(fn, ms, ...rest);
        if (ms === WINDOW_MS) armed.push(handle);
        return handle;
      }) as typeof setTimeout);
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
        handle?: Parameters<typeof clearTimeout>[0],
      ) => {
        cleared.add(handle);
        realClearTimeout(handle);
      }) as typeof clearTimeout);
      const oneSocket = new http.Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const first = await getWhole('/kept', oneSocket);
        expect(first).toMatchObject({ status: 200, complete: true });
        expect(first.body.equals(body)).toBe(true);
        await vi.waitFor(() => {
          expect(armed.length).toBeGreaterThan(0);
          expect(armed.filter((h) => !cleared.has(h))).toEqual([]);
        });
        setSpy.mockRestore();
        clearSpy.mockRestore();
        // Idle for twice the window, then the same socket serves again.
        await sleep(2 * WINDOW_MS);
        const second = await getWhole('/kept', oneSocket);
        expect(second).toMatchObject({ status: 200, complete: true, reusedSocket: true });
        expect(second.body.equals(body)).toBe(true);
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
        oneSocket.destroy();
      }
    }, 30_000);

    it('a socket gone before the final write is client-gone at once, not a stall', async () => {
      // Node 24: with the socket destroyed but `res.destroyed` still false,
      // `res.write(chunk, cb)` never calls `cb` and `end()` never fires
      // 'finish'. Only the 'close' listener settles that wait, so without it
      // this would sit out the whole window and say client-stalled.
      const realWrite = http.ServerResponse.prototype.write;
      const spy = vi
        .spyOn(http.ServerResponse.prototype, 'write')
        .mockImplementation(function (this: http.ServerResponse, ...args: unknown[]) {
          if (typeof args[args.length - 1] === 'function') this.socket?.destroy();
          return (realWrite as (...a: unknown[]) => boolean).apply(this, args);
        });
      try {
        const { source } = probedSource([randomBytes(1024)]);
        const { outcome } = await serveBody('/gone-before-final', source, 1024);
        void rawGet('/gone-before-final');
        expect(await outcome).toMatchObject({ code: 'client-gone' });
      } finally {
        spy.mockRestore();
      }
    });

    it("a synchronous throw from the final write rejects with Node's error, reported incomplete", async () => {
      // Defensive: no input reaches this on Node 24, so a spy forces it. The
      // wait must settle (no idle timer left armed) and the teardown run.
      const events = responsesSent();
      const boom = Object.assign(new Error('write refused'), { code: 'ERR_TEST_WRITE' });
      const spy = vi
        .spyOn(http.ServerResponse.prototype, 'write')
        .mockImplementation(function (this: http.ServerResponse, ...args: unknown[]) {
          if (typeof args[args.length - 1] === 'function') throw boom;
          return true;
        });
      try {
        const { source } = probedSource([randomBytes(1024)]);
        const { outcome } = await serveBody('/final-write-throws', source, 1024);
        void rawGet('/final-write-throws');
        expect(await outcome).toBe(boom);
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events[0]).toMatchObject({ status: 200, incomplete: true });
      } finally {
        spy.mockRestore();
      }
    });

    // 2 ** 31 is a positive safe integer, but setTimeout() would run it after 1 ms.
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
      'refuses a bodyStreamIdleTimeoutMs that is not a positive safe integer a timer can hold: %s',
      (v) => {
        expect(() =>
          createHttpServerPlugin({
            host: '127.0.0.1',
            port: 0,
            cookieKey: COOKIE_KEY,
            allowedOrigins: [],
            bodyStreamIdleTimeoutMs: v,
          }),
        ).toThrow(TypeError);
      },
    );
  });
});
