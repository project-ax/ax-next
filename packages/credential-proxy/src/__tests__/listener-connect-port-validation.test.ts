/**
 * TASK-862 — a CONNECT target's port is validated when the request is parsed.
 *
 * Before this, the listener took the port with `parseInt`, which only refused
 * a port with no leading digit. `host:99999` and `host:0` sailed through to the
 * dial, and so did `host:-1` and `host:443abc` (parsed as 443). On the MITM
 * path that is a malformed response stream: the proxy writes
 * `200 Connection Established`, then `tls.connect` throws ERR_SOCKET_BAD_PORT
 * and the catch writes a raw `502 Bad Gateway` onto the same socket. On the
 * bypass path `net.connect` threw the same way and the client got a 502 for
 * what is really a malformed request.
 *
 * Now the port must be 1–5 ASCII digits naming 1–65535, or the client gets a
 * clean 400 (one `invalid_target` audit row) — before any 200, before the
 * allowlist check, before DNS. An injected resolver that counts its calls is
 * the proof that nothing past the parse ran.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import {
  startProxyListener,
  type ProxyListener,
  type ProxyAuditEntry,
  type SessionConfig,
} from '../listener.js';
import { SharedCredentialRegistry } from '../registry.js';
import { rawConnect, tokenFor } from './proxy-auth-helpers.js';

/** An allowlisted hostname that only the injected resolver knows. */
const HOST = 'api.port-check.test';

let listener: ProxyListener | undefined;
const clients: net.Socket[] = [];

afterEach(() => {
  listener?.stop();
  listener = undefined;
  for (const c of clients.splice(0)) c.destroy();
});

function session(mode: 'mitm' | 'bypass'): Map<string, SessionConfig> {
  return new Map([
    [
      's1',
      {
        allowlist: new Set([HOST]),
        ...(mode === 'bypass' ? { bypassMITM: new Set([HOST]) } : {}),
        sessionId: 's1',
        userId: 'u1',
        proxyToken: tokenFor('s1'),
      },
    ],
  ]);
}

/**
 * Start a listener whose resolver records each lookup and then FAILS it, so a
 * target that gets past the parse ends in a deterministic 502 (DNS failure)
 * without any upstream dial — and one that does not get past it never calls
 * the resolver at all.
 */
async function start(mode: 'mitm' | 'bypass') {
  const audits: ProxyAuditEntry[] = [];
  const lookups: string[] = [];
  listener = await startProxyListener({
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    registry: new SharedCredentialRegistry(),
    // Never reached: every case here ends before a leaf cert is minted.
    ca: { key: 'unused-key', cert: 'unused-cert' },
    sessions: session(mode),
    resolver: async (host) => {
      lookups.push(host);
      throw new Error(`no such host: ${host}`);
    },
    onAudit: (e) => audits.push(e),
  });
  return { audits, lookups, port: listener.port };
}

/** Write one raw CONNECT and collect everything the proxy sends until it closes. */
function connect(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(rawConnect(target, tokenFor('s1')));
    });
    clients.push(sock);
    let acc = '';
    sock.on('data', (c: Buffer) => {
      acc += c.toString('latin1');
    });
    sock.on('end', () => {
      sock.end();
      resolve(acc);
    });
    sock.on('error', reject);
  });
}

const BAD_PORTS: Array<[string, string]> = [
  ['zero', '0'],
  ['one past the top', '65536'],
  ['far out of range', '99999'],
  ['non-numeric', 'https'],
  ['trailing garbage after digits', '443abc'],
  ['negative', '-1'],
  ['signed', '+443'],
  ['fractional', '443.5'],
  ['too many digits', '000443'],
  ['empty', ''],
];

for (const mode of ['mitm', 'bypass'] as const) {
  describe(`CONNECT port validation — ${mode} path`, () => {
    for (const [label, portStr] of BAD_PORTS) {
      it(`refuses ${label} (${HOST}:${portStr}) with a clean 400 before any 200`, async () => {
        const { audits, lookups, port } = await start(mode);
        const target = `${HOST}:${portStr}`;

        const response = await connect(port, target);

        // One status line, and it is the 400 — no 200 ahead of it, no 502 after.
        expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
        expect(response).not.toContain('200 Connection Established');
        expect(response.match(/HTTP\/1\.1 /g)).toHaveLength(1);

        // Refused at the parse: the allowlisted host was never even looked up.
        expect(lookups).toEqual([]);

        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 400,
          requestBytes: 0,
          responseBytes: 0,
          blocked: 'invalid_target',
          sessionId: 's1',
          userId: 'u1',
        });
      });
    }

    for (const portStr of ['1', '443', '65535']) {
      it(`lets a valid port (${portStr}) past the parse`, async () => {
        const { audits, lookups, port } = await start(mode);
        const target = `${HOST}:${portStr}`;

        const response = await connect(port, target);

        // Past the parse and the allowlist: the resolver ran, failed, and the
        // proxy answered the DNS failure the way it always has — a 502.
        expect(lookups).toEqual([HOST]);
        expect(response).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
        expect(audits).toHaveLength(1);
        expect(audits[0]!.status).toBe(502);
        expect(audits[0]!.url).toBe(target);
      });
    }

    it('an unauthenticated CONNECT with a bad port still gets 407, not 400', async () => {
      // Auth runs before the target is parsed, so a bad port is no oracle for an
      // unauthenticated prober.
      const { audits, lookups, port } = await start(mode);

      const response = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(rawConnect(`${HOST}:99999`));
        });
        clients.push(sock);
        let acc = '';
        sock.on('data', (c: Buffer) => {
          acc += c.toString('latin1');
        });
        sock.on('end', () => {
          sock.end();
          resolve(acc);
        });
        sock.on('error', reject);
      });

      expect(response).toMatch(/^HTTP\/1\.1 407 /);
      expect(lookups).toEqual([]);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ status: 407, blocked: 'proxy_auth_required' });
    });

    it('still defaults a target with no port to 443 (unchanged)', async () => {
      const { audits, lookups, port } = await start(mode);

      const response = await connect(port, HOST);

      expect(lookups).toEqual([HOST]);
      expect(response).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.status).toBe(502);
    });
  });
}
