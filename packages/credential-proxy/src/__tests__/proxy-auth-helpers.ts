import { request as httpRequest } from 'node:http';
import * as net from 'node:net';

/**
 * Shared test helpers for the per-session proxy token (TASK-52 / TASK-158).
 *
 * Since TASK-158 the listener AUTHENTICATES every request by its
 * `Proxy-Authorization: Basic base64("ax:<token>")` header and gates it on the
 * allowlist of the session that token belongs to. A test that builds a
 * `SessionConfig` directly must therefore (a) give it a `proxyToken` and
 * (b) make its client send that token. These helpers keep that one line each.
 */

/**
 * A deterministic 32-lowercase-hex token derived from a label, so a test can
 * write `proxyToken: tokenFor('s1')` in the session config and
 * `basicAuth(tokenFor('s1'))` on the client and get a matching pair. Distinct
 * labels give distinct tokens.
 */
export function tokenFor(label: string): string {
  let out = '';
  // FNV-1a-style mix, expanded to 32 hex chars. Not secret, just deterministic.
  let h = 0x811c9dc5;
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < label.length; i++) {
      h ^= label.charCodeAt(i) + round;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0').slice(0, 4);
  }
  return out;
}

/** `Basic base64("ax:<token>")` — the value of the Proxy-Authorization header. */
export function basicAuth(token: string): string {
  return `Basic ${Buffer.from(`ax:${token}`).toString('base64')}`;
}

/**
 * The header block for a raw `CONNECT` request written straight to a socket.
 * `CONNECT host:port HTTP/1.1` + Host + (when a token is given)
 * Proxy-Authorization, ready to `socket.write(...)`.
 */
export function rawConnect(target: string, token?: string): string {
  return (
    `CONNECT ${target} HTTP/1.1\r\n` +
    `Host: ${target}\r\n` +
    (token !== undefined ? `Proxy-Authorization: ${basicAuth(token)}\r\n` : '') +
    `\r\n`
  );
}

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** An absolute-URL proxy request with an explicit Proxy-Authorization (or none). */
export function viaHttpProxy(
  proxyPort: number,
  targetUrl: string,
  proxyAuthorization: string | undefined,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: targetUrl,
        headers: {
          Host: target.host,
          ...(proxyAuthorization !== undefined ? { 'Proxy-Authorization': proxyAuthorization } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Write a raw CONNECT to the proxy and return its status + the reply text seen
 * so far (through the header block, plus anything already in the same chunk),
 * then drop the socket. Enough to tell `200` (tunnel granted) from `403`/`407`.
 */
export function connectStatus(
  proxyPort: number,
  request: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(request));
    let text = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ status: parseInt(text.split(' ')[1] ?? '0', 10), text });
    };
    socket.on('data', (c: Buffer) => {
      text += c.toString('utf8');
      if (text.includes('\r\n\r\n')) finish();
    });
    socket.on('close', finish);
    socket.on('error', (err) => {
      if (!done) reject(err);
    });
  });
}
