import { request } from 'node:http';

export interface RequestWithHost {
  method: 'GET' | 'POST';
  path: string;
  /** Sent verbatim as the Host header, `''` included. */
  host: string;
  headers?: Record<string, string>;
  /** POST only: serialized as the JSON body. */
  json?: unknown;
}

/**
 * One HTTP/1.1 exchange that puts an exact Host header on the wire.
 *
 * `fetch` silently replaces a custom `host` header, and a plain
 * `http.request` replaces an empty one (MEASURED, Node 24). `setHost: false`
 * is what lets a test send a malformed or empty Host at all.
 *
 * POSTs carry `x-requested-with: ax-admin`, http-server's CSRF pass for
 * non-browser clients: these tests are about the Host, not CSRF.
 */
export function requestWithHost(
  port: number,
  req: RequestWithHost,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...req.headers, host: req.host };
    let payload: Buffer | undefined;
    if (req.method === 'POST') {
      payload = Buffer.from(JSON.stringify(req.json ?? {}), 'utf8');
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
      headers['x-requested-with'] = 'ax-admin';
    }
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        method: req.method,
        path: req.path,
        headers,
        setHost: false,
        // A fresh connection per request: nothing pooled outlives the test.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}
