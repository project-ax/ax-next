import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reject, type SubscriberHandler } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin, type HttpServerPlugin } from '../plugin.js';
import type {
  HttpMethod,
  HttpRegisterRouteOutput,
  HttpRouteHandler,
} from '../types.js';

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
    plugin = createHttpServerPlugin({ host: '127.0.0.1', port: 0 });
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
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/octet-stream' },
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
      headers: { 'content-type': 'application/octet-stream' },
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
    const r = await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST' });
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
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
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
});
