import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { startWebProxyBridge, type WebProxyBridge } from '../bridge.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bridge-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'proxy.sock');
}

/**
 * Stand up a test "host proxy" — an HTTP server bound to a Unix socket.
 * It echoes back the requested URL plus a fixed body, so we can prove the
 * bridge forwarded the request through the socket.
 */
async function startHostProxyOnSocket(
  socketPath: string,
  handler: (req: Parameters<HttpServer['emit']>[1] extends infer R ? R : never) => void,
): Promise<HttpServer> {
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c.toString();
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`url=${req.url} method=${req.method} body=${body}`);
      handler?.(req as never);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return server;
}

describe('startWebProxyBridge — HTTP forwarding', () => {
  it('forwards a GET through the Unix socket and returns the upstream body', async () => {
    const socketPath = tmpSocketPath();
    await startHostProxyOnSocket(socketPath, () => {});

    const bridge: WebProxyBridge = await startWebProxyBridge(socketPath);
    cleanups.push(() => bridge.stop());

    expect(bridge.port).toBeGreaterThan(0);

    const proxyAgent = new ProxyAgent({
      uri: `http://127.0.0.1:${bridge.port}`,
      proxyTunnel: false, // send absolute-URL request, not CONNECT
    });
    const res = await undiciFetch('http://example.test/foo?bar=baz', { dispatcher: proxyAgent });
    const text = await res.text();

    expect(res.status).toBe(200);
    // The bridge prepends http://localhost to the URL it received from undici,
    // so the host proxy sees the original target reflected in the path.
    expect(text).toContain('example.test/foo?bar=baz');
    expect(text).toContain('method=GET');
  });

  it('forwards a POST body verbatim', async () => {
    const socketPath = tmpSocketPath();
    await startHostProxyOnSocket(socketPath, () => {});

    const bridge = await startWebProxyBridge(socketPath);
    cleanups.push(() => bridge.stop());

    const proxyAgent = new ProxyAgent({
      uri: `http://127.0.0.1:${bridge.port}`,
      proxyTunnel: false,
    });
    const res = await undiciFetch('http://example.test/post', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
      dispatcher: proxyAgent,
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('method=POST');
    expect(text).toContain('body={"hello":"world"}');
  });

  it('returns 502 when the Unix socket is unavailable', async () => {
    const socketPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bridge-')),
      'no-proxy.sock',
    );
    cleanups.push(() => fs.rmSync(path.dirname(socketPath), { recursive: true, force: true }));

    const bridge = await startWebProxyBridge(socketPath);
    cleanups.push(() => bridge.stop());

    const proxyAgent = new ProxyAgent({
      uri: `http://127.0.0.1:${bridge.port}`,
      proxyTunnel: false,
    });
    const res = await undiciFetch('http://example.test/x', { dispatcher: proxyAgent });

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('Bridge error');
  });
});
