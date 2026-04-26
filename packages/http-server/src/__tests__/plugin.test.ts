import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reject, type SubscriberHandler } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin, type HttpServerPlugin } from '../plugin.js';
import type {
  HttpMethod,
  HttpRegisterRouteOutput,
  HttpRouteHandler,
} from '../types.js';

const COOKIE_KEY = randomBytes(32);

// ---------------------------------------------------------------------------
// Tests for @ax/http-server.
//
// Covers the contract documented in plugin.ts:
//   - GET happy path (200)
//   - POST + JSON body parsing
//   - 413 on body > 1 MiB (mid-stream cap)
//   - 404 on unregistered path
//   - 405 on registered path with wrong method (Allow header populated)
//   - headers exposed lowercased on the request adapter
//   - cookies parsed from Cookie header
//   - unregister() drops the route
//   - http:request subscriber rejection → 4xx (csrf-prefix → 403, else 400)
//   - http:response-sent observer fires after a request completes
//   - shutdown() closes the listener cleanly
//   - boundPort() returns the OS-assigned port when port: 0
//   - concurrent requests don't crash
// ---------------------------------------------------------------------------

describe('@ax/http-server', () => {
  let harness: TestHarness;
  let plugin: HttpServerPlugin;
  let port: number;

  beforeEach(async () => {
    plugin = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY,
      // The CSRF guard fires for any state-changing method; tests below
      // that exercise other rejection reasons send X-Requested-With:
      // ax-admin to bypass it and let the test's subscriber run.
      allowedOrigins: [],
    });
    // Empty allowedOrigins logs a stderr warn unless the escape hatch is
    // set; pin it to keep test output quiet.
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
    harness = await createTestHarness({ plugins: [plugin] });
    port = plugin.boundPort();
  });

  afterEach(async () => {
    await harness.close({ onError: () => {} });
  });

  async function registerRoute(
    method: HttpMethod,
    path: string,
    handler: HttpRouteHandler,
  ): Promise<HttpRegisterRouteOutput> {
    return harness.bus.call('http:register-route', harness.ctx(), {
      method,
      path,
      handler,
    });
  }

  it('exposes the OS-assigned port via boundPort()', () => {
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it('manifest registers exactly http:register-route', () => {
    expect(plugin.manifest.registers).toEqual(['http:register-route']);
    expect(plugin.manifest.calls).toEqual([]);
    expect(plugin.manifest.subscribes).toEqual([]);
  });

  it('serves a registered GET route', async () => {
    await registerRoute('GET', '/health', async (_req, res) => {
      res.status(200).text('ok');
    });
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
  });

  it('parses a POST body', async () => {
    await registerRoute('POST', '/echo', async (req, res) => {
      const parsed = JSON.parse(req.body.toString('utf8')) as { msg: string };
      res.status(200).json({ got: parsed.msg, length: req.body.length });
    });
    const r = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ msg: 'hello' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { got: string; length: number };
    expect(body.got).toBe('hello');
    expect(body.length).toBeGreaterThan(0);
  });

  it('returns 413 when the body exceeds MAX_BODY_BYTES (declared content-length)', async () => {
    await registerRoute('POST', '/upload', async (_req, res) => {
      res.status(200).text('ok');
    });
    // 2 MiB Content-Length — caught pre-buffer.
    const oversized = 'x'.repeat(2 * 1024 * 1024);
    const r = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-requested-with': 'ax-admin',
      },
      body: oversized,
    });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'body-too-large' });
  });

  it('returns 413 when the body grows past MAX_BODY_BYTES mid-stream', async () => {
    await registerRoute('POST', '/upload', async (_req, res) => {
      res.status(200).text('ok');
    });
    // Send 1.5 MiB without a Content-Length pre-cap (chunked).
    const oversized = Buffer.alloc(1.5 * 1024 * 1024, 0x61);
    // Use a ReadableStream so fetch sends it chunked (no Content-Length).
    // Node's undici fetch sends a Content-Length anyway when given a Buffer;
    // streaming the body via a ReadableStream forces chunked transfer.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const r = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-requested-with': 'ax-admin',
      },
      body: stream,
      // duplex required for streaming bodies in newer Node fetch.
      // @ts-expect-error — duplex isn't in the lib types yet.
      duplex: 'half',
    });
    expect(r.status).toBe(413);
  });

  it('returns 404 on unregistered path', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not-found' });
  });

  it('returns 405 with Allow header when the path exists with a different method', async () => {
    await registerRoute('GET', '/x', async (_req, res) => {
      res.status(200).text('ok');
    });
    const r = await fetch(`http://127.0.0.1:${port}/x`, {
      method: 'POST',
      headers: { 'x-requested-with': 'ax-admin' },
    });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
  });

  it('exposes headers with lowercased keys', async () => {
    let capturedHeaders: Record<string, string> = {};
    await registerRoute('GET', '/h', async (req, res) => {
      capturedHeaders = req.headers;
      res.status(200).text('ok');
    });
    await fetch(`http://127.0.0.1:${port}/h`, {
      headers: { 'X-Custom-Header': 'value', 'X-Other': 'thing' },
    });
    expect(capturedHeaders['x-custom-header']).toBe('value');
    expect(capturedHeaders['x-other']).toBe('thing');
    // Spot-check that no UPPERCASE key snuck through.
    for (const k of Object.keys(capturedHeaders)) {
      expect(k).toBe(k.toLowerCase());
    }
  });

  it('parses query string into req.query (lowercased keys)', async () => {
    let captured: Record<string, string> = {};
    await registerRoute('GET', '/q', async (req, res) => {
      captured = req.query;
      res.status(200).text('ok');
    });
    await fetch(`http://127.0.0.1:${port}/q?Code=abc&State=xyz&empty=`);
    expect(captured.code).toBe('abc');
    expect(captured.state).toBe('xyz');
    expect(captured.empty).toBe('');
    // Path is exact-match; query string isn't part of the routing key.
    // (No request to /q?... is routed to a different handler than /q.)
  });

  it('req.query is empty object when URL has no querystring', async () => {
    let captured: unknown;
    await registerRoute('GET', '/noq', async (req, res) => {
      captured = req.query;
      res.status(200).text('ok');
    });
    await fetch(`http://127.0.0.1:${port}/noq`);
    expect(captured).toEqual({});
  });

  it('parses cookies into req.cookies', async () => {
    let capturedCookies: Record<string, string> = {};
    await registerRoute('GET', '/c', async (req, res) => {
      capturedCookies = req.cookies;
      res.status(200).text('ok');
    });
    await fetch(`http://127.0.0.1:${port}/c`, {
      headers: { cookie: 'session=abc123; theme=dark' },
    });
    expect(capturedCookies.session).toBe('abc123');
    expect(capturedCookies.theme).toBe('dark');
  });

  it('unregister() removes the route', async () => {
    const reg = await registerRoute('GET', '/temp', async (_req, res) => {
      res.status(200).text('still here');
    });
    const ok = await fetch(`http://127.0.0.1:${port}/temp`);
    expect(ok.status).toBe(200);
    reg.unregister();
    const gone = await fetch(`http://127.0.0.1:${port}/temp`);
    expect(gone.status).toBe(404);
  });

  it('rejects duplicate route registration', async () => {
    await registerRoute('GET', '/dup', async (_req, res) => {
      res.status(200).text('a');
    });
    await expect(
      registerRoute('GET', '/dup', async (_req, res) => {
        res.status(200).text('b');
      }),
    ).rejects.toMatchObject({ code: 'duplicate-route' });
  });

  it('http:request subscriber rejection with csrf reason → 403', async () => {
    await registerRoute('POST', '/protected', async (_req, res) => {
      res.status(200).text('handler ran — should not happen');
    });
    // Contract: http:request is veto-only. A subscriber that returned a
    // mutated payload (e.g., to rewrite the path) would NOT have its
    // changes honored — only `reject()` short-circuits.
    const csrfGuard: SubscriberHandler<{ method: string; path: string }> = async (
      _ctx,
      _payload,
    ) => reject({ reason: 'csrf-origin-mismatch' });
    harness.bus.subscribe('http:request', 'test-csrf', csrfGuard);
    const r = await fetch(`http://127.0.0.1:${port}/protected`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Bypass the plugin's built-in CSRF guard so the test's
        // subscriber gets to fire.
        'x-requested-with': 'ax-admin',
      },
      body: '{}',
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'csrf-origin-mismatch' });
  });

  it('http:request subscriber rejection with non-csrf reason → 400', async () => {
    await registerRoute('POST', '/x', async (_req, res) => {
      res.status(200).text('ok');
    });
    harness.bus.subscribe('http:request', 'test-bad', async () =>
      reject({ reason: 'invalid-content-type' }),
    );
    const r = await fetch(`http://127.0.0.1:${port}/x`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: '{}',
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid-content-type' });
  });

  it('http:response-sent observer fires with status + durationMs', async () => {
    await registerRoute('GET', '/observed', async (_req, res) => {
      res.status(204).end();
    });
    const observed: Array<{ status: number; durationMs: number }> = [];
    harness.bus.subscribe('http:response-sent', 'test-observer', async (_ctx, payload) => {
      observed.push(payload as { status: number; durationMs: number });
      return undefined;
    });
    await fetch(`http://127.0.0.1:${port}/observed`);
    // Give the bus.fire (after writeHead.end) a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(observed.length).toBe(1);
    expect(observed[0]!.status).toBe(204);
    expect(typeof observed[0]!.durationMs).toBe('number');
    expect(observed[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('http:response-sent fires for 404 too', async () => {
    const observed: number[] = [];
    harness.bus.subscribe('http:response-sent', 'test-404', async (_ctx, payload) => {
      observed.push((payload as { status: number }).status);
      return undefined;
    });
    await fetch(`http://127.0.0.1:${port}/missing`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(observed).toEqual([404]);
  });

  it('handles concurrent requests without crashing', async () => {
    let count = 0;
    await registerRoute('GET', '/conc', async (_req, res) => {
      count += 1;
      // Tiny delay so requests overlap.
      await new Promise((r) => setTimeout(r, 5));
      res.status(200).text('ok');
    });
    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, () => fetch(`http://127.0.0.1:${port}/conc`)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(count).toBe(N);
  });

  it('redirect() sets Location and a 3xx status', async () => {
    await registerRoute('GET', '/r', async (_req, res) => {
      res.redirect('/elsewhere', 307);
    });
    const r = await fetch(`http://127.0.0.1:${port}/r`, { redirect: 'manual' });
    expect(r.status).toBe(307);
    expect(r.headers.get('location')).toBe('/elsewhere');
  });

  it('json() sets application/json content-type', async () => {
    await registerRoute('GET', '/j', async (_req, res) => {
      res.status(200).json({ a: 1 });
    });
    const r = await fetch(`http://127.0.0.1:${port}/j`);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(await r.json()).toEqual({ a: 1 });
  });

  it('rejects an invalid path on registration', async () => {
    await expect(
      harness.bus.call('http:register-route', harness.ctx(), {
        method: 'GET',
        path: 'no-slash',
        handler: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects an unsupported method on registration', async () => {
    await expect(
      harness.bus.call('http:register-route', harness.ctx(), {
        method: 'OPTIONS',
        path: '/x',
        handler: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('handler that never finishes the response → 500 handler-did-not-respond', async () => {
    await registerRoute('GET', '/silent', async (_req, _res) => {
      // Intentionally returns without finishing. The plugin must close
      // the socket with a 500 so the client doesn't hang.
    });
    const r = await fetch(`http://127.0.0.1:${port}/silent`);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'handler-did-not-respond' });
  });

  it('shutdown() stops accepting new connections', async () => {
    await registerRoute('GET', '/up', async (_req, res) => {
      res.status(200).text('ok');
    });
    const before = await fetch(`http://127.0.0.1:${port}/up`);
    expect(before.status).toBe(200);
    await harness.close({ onError: () => {} });
    // Re-fetch should fail because the listener is gone. fetch typically
    // rejects (ECONNREFUSED) — assert that it does NOT resolve with 200.
    await expect(fetch(`http://127.0.0.1:${port}/up`)).rejects.toBeDefined();
  });

  it('res.body(buf) sends raw bytes with the given content-type', async () => {
    await registerRoute('GET', '/png', async (_req, res) => {
      // Tiny 1x1 PNG (89 50 4E 47 ...). Just enough to verify bytes
      // round-trip without any string encoding interference.
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      res.body(png, 'image/png');
    });
    const r = await fetch(`http://127.0.0.1:${port}/png`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-length')).toBe('8');
    const got = Buffer.from(await r.arrayBuffer());
    expect(got.toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('res.body() does NOT override an earlier explicit header(content-type)', async () => {
    // Pin the documented precedence: a prior `header('content-type', …)`
    // call wins; the `contentType` arg to body() is only applied when no
    // earlier header set it.
    await registerRoute('GET', '/typed', async (_req, res) => {
      res
        .header('content-type', 'application/x-custom')
        .body(Buffer.from([0x01, 0x02, 0x03]), 'application/octet-stream');
    });
    const r = await fetch(`http://127.0.0.1:${port}/typed`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/x-custom');
    expect(r.headers.get('content-length')).toBe('3');
  });

  it('routes /* splat patterns capture remaining path into params["*"]', async () => {
    let captured = '';
    await registerRoute('GET', '/*', async (req, res) => {
      captured = req.params['*'] ?? '';
      res.status(200).text(captured);
    });
    let r = await fetch(`http://127.0.0.1:${port}/foo/bar/baz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('foo/bar/baz');
    r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('');
    expect(captured).toBe('');
  });

  it('exact + param routes take precedence over /* splat', async () => {
    await registerRoute('GET', '/admin/agents', async (_req, res) => {
      res.status(200).text('exact');
    });
    await registerRoute('GET', '/admin/agents/:id', async (req, res) => {
      res.status(200).text(`agent:${req.params.id}`);
    });
    await registerRoute('GET', '/*', async (req, res) => {
      res.status(200).text(`splat:${req.params['*']}`);
    });
    let r = await fetch(`http://127.0.0.1:${port}/admin/agents`);
    expect(await r.text()).toBe('exact');
    r = await fetch(`http://127.0.0.1:${port}/admin/agents/abc123`);
    expect(await r.text()).toBe('agent:abc123');
    r = await fetch(`http://127.0.0.1:${port}/anything/else`);
    expect(await r.text()).toBe('splat:anything/else');
  });

  it('rejects /* in non-final position', async () => {
    await expect(
      registerRoute('GET', '/foo/*/bar', async () => {}),
    ).rejects.toBeDefined();
  });

  it('mid-path /static/* prefix splat matches only the prefix', async () => {
    await registerRoute('GET', '/static/*', async (req, res) => {
      res.status(200).text(`static:${req.params['*']}`);
    });
    let r = await fetch(`http://127.0.0.1:${port}/static/css/main.css`);
    expect(await r.text()).toBe('static:css/main.css');
    r = await fetch(`http://127.0.0.1:${port}/elsewhere`);
    expect(r.status).toBe(404);
  });

  it('res.stream() flushes headers, allows multiple writes, closes on demand', async () => {
    await registerRoute('GET', '/sse', async (_req, res) => {
      const s = res.status(200).stream();
      s.write('data: chunk-1\n\n');
      s.write('data: chunk-2\n\n');
      // Defer the close so we can prove headers flushed before close.
      setTimeout(() => {
        s.write('data: chunk-3\n\n');
        s.close();
      }, 5);
    });
    const r = await fetch(`http://127.0.0.1:${port}/sse`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(r.headers.get('cache-control')).toMatch(/no-cache/);
    const body = await r.text();
    expect(body).toBe(
      'data: chunk-1\n\ndata: chunk-2\n\ndata: chunk-3\n\n',
    );
  });

  it('res.stream() onClose fires when client disconnects', async () => {
    let firedResolve!: () => void;
    const fired = new Promise<void>((resolve) => {
      firedResolve = resolve;
    });
    await registerRoute('GET', '/sse-close', async (_req, res) => {
      const s = res.status(200).stream();
      s.write(': hello\n\n');
      s.onClose(() => {
        firedResolve();
      });
    });
    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${port}/sse-close`, {
      signal: ac.signal,
    });
    const reader = r.body!.getReader();
    await reader.read();
    ac.abort();
    try {
      await reader.cancel();
    } catch {
      // already aborted
    }
    await fired;
  });
});
