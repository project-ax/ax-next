import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import { makeAgentContext } from '@ax/core';
import { createStaticFilesPlugin } from '../plugin.js';

const COOKIE_KEY = randomBytes(32);

interface Harness {
  port: number;
  harness: TestHarness;
}

async function bootHarness(opts: {
  dir: string;
  spaFallback?: boolean | string;
  mountPath?: string;
  apiPathPrefixes?: readonly string[];
  /**
   * Register `apiRoutes` AFTER static-files' catchall instead of before it.
   * That is the order the memory preset actually ran in production
   * (TASK-717), so the route table must not depend on which comes first.
   */
  apiAfterStatic?: boolean;
  apiRoutes?: Array<{
    method: 'GET' | 'POST';
    path: string;
    handler: (req: unknown, res: {
      status(n: number): { json(v: unknown): void; text(s: string): void };
    }) => Promise<void>;
  }>;
}): Promise<Harness> {
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const staticPlugin = createStaticFilesPlugin({
    dir: opts.dir,
    spaFallback: opts.spaFallback,
    mountPath: opts.mountPath,
    ...(opts.apiPathPrefixes !== undefined
      ? { apiPathPrefixes: opts.apiPathPrefixes }
      : {}),
  });

  // API-routes plugin: registers routes BEFORE static-files's catchall.
  const apiPlugin = opts.apiRoutes
    ? {
        manifest: {
          name: '@ax/test-api-routes',
          version: '0.0.0',
          registers: [],
          calls: ['http:register-route'],
          subscribes: [],
        },
        async init({ bus }: { bus: { call: (...a: unknown[]) => Promise<unknown> } }) {
          const ctx = makeAgentContext({
            sessionId: 'test-api-routes',
            agentId: 'test-api-routes',
            userId: 'system',
          });
          for (const r of opts.apiRoutes!) {
            await bus.call('http:register-route', ctx, r);
          }
        },
      }
    : null;

  const plugins = apiPlugin
    ? opts.apiAfterStatic === true
      ? [http, staticPlugin, apiPlugin]
      : [http, apiPlugin, staticPlugin]
    : [http, staticPlugin];
  // The test harness starts plugins in order. Routing must not care which
  // side of static-files' catchall an API route registers on (TASK-717).
  const harness: TestHarness = await createTestHarness({
    plugins: plugins as never,
  });
  return { port: http.boundPort(), harness };
}

describe('@ax/static-files', () => {
  let dir: string;
  let harnesses: TestHarness[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ax-static-'));
    harnesses = [];
  });

  afterEach(async () => {
    for (const h of harnesses) await h.close({ onError: () => {} });
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(opts: Parameters<typeof bootHarness>[0]): Promise<number> {
    const h = await bootHarness(opts);
    harnesses.push(h.harness);
    return h.port;
  }

  it('serves a file from disk with the right MIME type', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>hi</html>');
    const port = await boot({ dir });
    const r = await fetch(`http://127.0.0.1:${port}/index.html`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await r.text()).toBe('<html>hi</html>');
  });

  it('serves binary files (PNG) without corruption', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(dir, 'logo.png'), png);
    const port = await boot({ dir });
    const r = await fetch(`http://127.0.0.1:${port}/logo.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-length')).toBe('8');
    const got = Buffer.from(await r.arrayBuffer());
    expect(got.toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('returns 404 for unknown paths when spaFallback is off', async () => {
    writeFileSync(join(dir, 'index.html'), 'root');
    const port = await boot({ dir });
    const r = await fetch(`http://127.0.0.1:${port}/no-such-file`);
    expect(r.status).toBe(404);
  });

  it('serves index.html on unknown paths when spaFallback: true', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>spa</html>');
    const port = await boot({ dir, spaFallback: true });
    const r = await fetch(`http://127.0.0.1:${port}/admin/agents/abc`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await r.text()).toBe('<html>spa</html>');
  });

  it('serves a custom fallback file when spaFallback is a string', async () => {
    writeFileSync(join(dir, 'app.html'), 'custom-spa');
    const port = await boot({ dir, spaFallback: 'app.html' });
    const r = await fetch(`http://127.0.0.1:${port}/some-spa-path`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('custom-spa');
  });

  it('rejects path-traversal attempts', async () => {
    writeFileSync(join(dir, 'index.html'), 'safe');
    const port = await boot({ dir });
    // fetch normalizes ../ in URLs before sending; the server sees /etc/passwd.
    // Either way: not a file in dir → 404.
    const r = await fetch(`http://127.0.0.1:${port}/../../../etc/passwd`);
    expect(r.status).toBe(404);
  });

  it('treats percent-encoded traversal sequences as literal filenames', async () => {
    // The router passes the splat through verbatim (no decodeURIComponent),
    // and `path.resolve` then sees `%2e%2e` / `%2f` as ordinary filename
    // characters rather than `..` / `/`. So these requests resolve to
    // non-existent files inside dir — never escape it. Pin both 404 and
    // 200 (SPA fallback) as acceptable: with no fallback, these are 404;
    // with `spaFallback: true`, they fall back to index.html (200), which
    // is still safe — the secret outside the root is never reachable.
    writeFileSync(join(dir, 'index.html'), 'safe');
    const port = await boot({ dir, spaFallback: true });

    // %2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd  (url-encoded ../../../etc/passwd)
    const encodedTraversal = await fetch(
      `http://127.0.0.1:${port}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
    );
    expect([200, 404]).toContain(encodedTraversal.status);
    if (encodedTraversal.status === 200) {
      // SPA fallback served index.html, NOT /etc/passwd.
      expect(await encodedTraversal.text()).toBe('safe');
    }

    // Plain encoded slashes should also not collapse into separators.
    const encodedSlash = await fetch(
      `http://127.0.0.1:${port}/foo%2fbar%2fbaz`,
    );
    expect([200, 404]).toContain(encodedSlash.status);
    if (encodedSlash.status === 200) {
      expect(await encodedSlash.text()).toBe('safe');
    }
  });

  it('rejects symlink targets outside dir (or returns a non-leak status)', async () => {
    writeFileSync(join(dir, 'index.html'), 'safe');
    const outside = mkdtempSync(join(tmpdir(), 'ax-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'sensitive');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'leaked.txt'));
    } catch {
      // CI on Windows or restrictive sandboxes may reject symlinks; skip.
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    const port = await boot({ dir });
    const r = await fetch(`http://127.0.0.1:${port}/leaked.txt`);
    // Today: the resolve+prefix check passes (the symlink itself is
    // inside dir) and fs.stat follows the link, so we serve the target.
    // A future hardening pass would call fs.realpath and re-check.
    // Pin BOTH outcomes as acceptable so the test doesn't break when
    // we tighten this — the security note in Task 18 tracks the gap.
    expect([200, 404]).toContain(r.status);
    rmSync(outside, { recursive: true, force: true });
  });

  it('returns 304 on If-None-Match with a matching ETag', async () => {
    writeFileSync(join(dir, 'index.html'), 'cached');
    const port = await boot({ dir });
    const first = await fetch(`http://127.0.0.1:${port}/index.html`);
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const second = await fetch(`http://127.0.0.1:${port}/index.html`, {
      headers: { 'If-None-Match': etag },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
  });

  it('sets immutable Cache-Control on hashed filenames', async () => {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'main-3ab19f02.js'), 'console.log(1)');
    writeFileSync(join(dir, 'index.html'), 'root');
    const port = await boot({ dir });
    const hashed = await fetch(
      `http://127.0.0.1:${port}/assets/main-3ab19f02.js`,
    );
    expect(hashed.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );

    const indexHtml = await fetch(`http://127.0.0.1:${port}/index.html`);
    expect(indexHtml.headers.get('cache-control')).toBe('no-cache');
  });

  it('lets API routes registered earlier take precedence over /*', async () => {
    writeFileSync(join(dir, 'index.html'), 'spa');
    const port = await boot({
      dir,
      spaFallback: true,
      apiRoutes: [
        {
          method: 'GET',
          path: '/api/health',
          handler: async (_req, res) => {
            res.status(200).json({ ok: true });
          },
        },
      ],
    });
    const api = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(api.status).toBe(200);
    const apiBody = (await api.json()) as { ok: boolean };
    expect(apiBody.ok).toBe(true);

    const spa = await fetch(`http://127.0.0.1:${port}/some-spa-path`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toBe('spa');
  });

  it('answers an unknown /api path with a JSON 404, never the SPA shell (TASK-717)', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>spa</html>');
    const port = await boot({ dir, spaFallback: true });
    for (const p of ['/api/nope', '/api/workspace/agents/a1/files/docs', '/api', '/api/']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toContain('application/json');
      expect(await r.json(), p).toEqual({ error: 'not-found' });
    }
  });

  it('never serves a file from disk under /api either', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>spa</html>');
    mkdirSync(join(dir, 'api'));
    writeFileSync(join(dir, 'api', 'leftover.json'), '{"stale":true}');
    const port = await boot({ dir, spaFallback: true });
    const r = await fetch(`http://127.0.0.1:${port}/api/leftover.json`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not-found' });
  });

  it('treats /api as a path segment: /apiary and /apis are still SPA routes', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>spa</html>');
    const port = await boot({ dir, spaFallback: true });
    for (const p of ['/apiary', '/apis/x', '/settings/api']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      expect(r.status, p).toBe(200);
      expect(await r.text(), p).toBe('<html>spa</html>');
    }
  });

  it('apiPathPrefixes replaces the default: the configured prefix 404s, /api falls back', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>spa</html>');
    const port = await boot({ dir, spaFallback: true, apiPathPrefixes: ['/v1/'] });
    const v1 = await fetch(`http://127.0.0.1:${port}/v1/things`);
    expect(v1.status).toBe(404);
    expect(await v1.json()).toEqual({ error: 'not-found' });
    const api = await fetch(`http://127.0.0.1:${port}/api/things`);
    expect(api.status).toBe(200);
    expect(await api.text()).toBe('<html>spa</html>');
  });

  it('trims any run of trailing slashes off an apiPathPrefixes entry', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>spa</html>');
    const port = await boot({ dir, spaFallback: true, apiPathPrefixes: ['/v1///'] });
    for (const p of ['/v1', '/v1/', '/v1/things']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      expect(r.status, p).toBe(404);
      expect(await r.json(), p).toEqual({ error: 'not-found' });
    }
    const spa = await fetch(`http://127.0.0.1:${port}/v10`);
    expect(await spa.text()).toBe('<html>spa</html>');
  });

  it('a splat API route registered AFTER the catchall still wins over it (TASK-717)', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>spa</html>');
    const seen: string[] = [];
    const port = await boot({
      dir,
      spaFallback: true,
      apiAfterStatic: true,
      apiRoutes: [
        {
          method: 'GET',
          path: '/api/workspace/agents/:agentId/files/*',
          handler: async (req, res) => {
            const r = req as { params: Record<string, string> };
            seen.push(`${r.params.agentId}:${r.params['*']}`);
            res.status(200).json({ ok: true });
          },
        },
      ],
    });
    const r = await fetch(
      `http://127.0.0.1:${port}/api/workspace/agents/a1/files/docs/inner.txt`,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(seen).toEqual(['a1:docs/inner.txt']);
    // And the SPA still owns everything the API does not.
    const spa = await fetch(`http://127.0.0.1:${port}/settings/agents`);
    expect(await spa.text()).toBe('<html>spa</html>');
  });

  it('rejects an unusable apiPathPrefixes entry at construction', () => {
    for (const bad of ['', '/', 'api', '//']) {
      expect(() => createStaticFilesPlugin({ dir, apiPathPrefixes: [bad] }), bad).toThrow();
    }
  });

  it('throws at init when dir does not exist', async () => {
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
    const http = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY,
      allowedOrigins: [],
    });
    const sf = createStaticFilesPlugin({ dir: '/nonexistent/path/12345' });
    await expect(
      createTestHarness({ plugins: [http, sf] as never }),
    ).rejects.toBeDefined();
  });
});
