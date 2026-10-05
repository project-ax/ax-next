/**
 * TASK-823 — the MITM (default HTTPS) CONNECT path bounds its upstream connect.
 *
 * Before this, the MITM path's upstream `tls.connect` was bounded only by the
 * 15-minute tunnel idle timeout: an allowlisted host that black-holes SYNs — or
 * accepts TCP and then never answers the TLS ClientHello — held the client's
 * tunnel and the half-open upstream socket for up to 15 minutes. TASK-786 (#915)
 * bounded the bypassMITM raw tunnel only; this is the same timer on the MITM
 * path, covering TCP connect AND the upstream TLS handshake.
 *
 * A real black hole is not a reliable fixture — TEST-NET-1 (192.0.2.1) hangs on
 * most hosts but fails fast on some, which would let a test pass on the error
 * path without touching the timer. So this file swaps `tls.connect` for the one
 * sentinel address below and hands the listener a real `net.Socket` that simply
 * never connects. Every other dial goes through untouched.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import { createServer as tlsCreate, connect as tlsConnect, type Server as TLSServer } from 'node:tls';
import forgeModule from 'node-forge';
import {
  startProxyListener,
  type ProxyListener,
  type ProxyAuditEntry,
  type SessionConfig,
} from '../listener.js';
import { SharedCredentialRegistry } from '../registry.js';
import { generateDomainCert, type CAKeyPair } from '../ca.js';
import { rawConnect, tokenFor } from './proxy-auth-helpers.js';

const forge = forgeModule as typeof forgeModule;

/** Upstream dials to this address never complete — see the vi.mock below. */
const BLACK_HOLE = '192.0.2.1';

const blackHoled = vi.hoisted(() => ({ sockets: [] as import('node:net').Socket[] }));

vi.mock('node:tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tls')>();
  const actualNet = await vi.importActual<typeof import('node:net')>('node:net');
  const connect = ((...args: unknown[]) => {
    const opts = args[0] as { host?: unknown } | undefined;
    if (typeof opts === 'object' && opts !== null && opts.host === '192.0.2.1') {
      // A real Socket that was never told to connect: no 'connect', no
      // 'secureConnect', no 'error', no 'close' until someone destroys it.
      const sock = new actualNet.Socket();
      blackHoled.sockets.push(sock);
      return sock;
    }
    return (actual.connect as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.connect;
  return { ...actual, connect };
});

let listener: ProxyListener | undefined;
const servers: Array<net.Server | TLSServer> = [];
const clients: net.Socket[] = [];
/** Upstream-side sockets a test server accepted; destroyed so close() can finish. */
const upstreamSockets: net.Socket[] = [];

afterEach(async () => {
  listener?.stop();
  listener = undefined;
  for (const c of clients.splice(0)) c.destroy();
  for (const u of upstreamSockets.splice(0)) u.destroy();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const s of blackHoled.sockets.splice(0)) s.destroy();
});

function mintCA(): CAKeyPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    { name: 'commonName', value: 'mitm-connect-timeout-ca' },
    { name: 'organizationName', value: 'AX Test' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

// One CA for the file — minting RSA keys is the slow part of these tests.
const ca = mintCA();

/** A MITM session (no bypassMITM) that may reach `host`. */
function mitmSession(host: string): Map<string, SessionConfig> {
  return new Map([
    [
      's1',
      {
        allowlist: new Set([host]),
        allowedIPs: new Set([host]),
        sessionId: 's1',
        userId: 'u1',
        proxyToken: tokenFor('s1'),
      },
    ],
  ]);
}

async function startListener(
  host: string,
  upstreamConnectTimeoutMs: number,
  audits: ProxyAuditEntry[],
): Promise<ProxyListener> {
  listener = await startProxyListener({
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    registry: new SharedCredentialRegistry(),
    ca,
    sessions: mitmSession(host),
    upstreamConnectTimeoutMs,
    onAudit: (e) => audits.push(e),
  });
  return listener;
}

/**
 * CONNECT through the proxy and wait, patiently, for the proxy to hang up. The
 * client never closes on its own, so on a stalled upstream the only thing that
 * can end this exchange is the proxy's connect timer. Rejects (rather than
 * letting the test hit vitest's own timeout) if nothing ends it in `limitMs`.
 */
function connectAndAwaitClose(proxyPort: number, target: string, limitMs = 3_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(rawConnect(target, tokenFor('s1')));
    });
    clients.push(sock);
    const guard = setTimeout(
      () => reject(new Error(`the proxy never released the client within ${limitMs}ms`)),
      limitMs,
    );
    let acc = '';
    sock.on('data', (c: Buffer) => {
      acc += c.toString('latin1');
    });
    sock.on('error', () => { /* a reset is a valid way for the proxy to hang up */ });
    sock.on('close', () => {
      clearTimeout(guard);
      resolve(acc);
    });
  });
}

describe('proxy listener — MITM CONNECT upstream connect-phase timeout (TASK-823)', () => {
  it('tears the tunnel down + audits one 502 when the upstream never completes the TCP connect', async () => {
    const CONNECT_TIMEOUT_MS = 150;
    const audits: ProxyAuditEntry[] = [];
    const l = await startListener(BLACK_HOLE, CONNECT_TIMEOUT_MS, audits);

    const started = Date.now();
    const response = await connectAndAwaitClose(l.port, `${BLACK_HOLE}:443`);
    const elapsed = Date.now() - started;

    // The listener really dialled the black hole on the MITM path.
    expect(blackHoled.sockets).toHaveLength(1);
    expect(response).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    // It came from the timer, not from something faster.
    expect(elapsed).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS - 20);
    // No leaked half-open upstream.
    expect(blackHoled.sockets[0]!.destroyed).toBe(true);

    await vi.waitFor(() => expect(audits.length).toBeGreaterThanOrEqual(1));
    expect(audits).toHaveLength(1);
    const [entry] = audits;
    expect(entry!.status).toBe(502);
    expect(entry!.method).toBe('CONNECT');
    expect(entry!.url).toBe(`${BLACK_HOLE}:443`);
    expect(entry!.blocked).toMatch(/^tls_error: upstream connect timed out/);
    expect(entry!.sessionId).toBe('s1');
    expect(entry!.userId).toBe('u1');
  });

  it('also bounds the upstream TLS handshake: TCP accepted, ClientHello never answered', async () => {
    const CONNECT_TIMEOUT_MS = 150;
    // A real upstream that accepts TCP and then says nothing, ever.
    const upstreamClosed: net.Socket[] = [];
    const silent = net.createServer((s) => {
      upstreamSockets.push(s);
      s.on('error', () => { /* proxy teardown may reset it */ });
      s.once('close', () => upstreamClosed.push(s));
      // Drain (and ignore) the ClientHello so the proxy's FIN is observed.
      s.resume();
    });
    servers.push(silent);
    const upPort = await new Promise<number>((r) =>
      silent.listen(0, '127.0.0.1', () => r((silent.address() as { port: number }).port)),
    );

    const audits: ProxyAuditEntry[] = [];
    const l = await startListener('127.0.0.1', CONNECT_TIMEOUT_MS, audits);

    const started = Date.now();
    const response = await connectAndAwaitClose(l.port, `127.0.0.1:${upPort}`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS - 20);
    expect(response).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);

    // The proxy's upstream connection was really opened — and then closed by
    // the proxy, not left half-open on the upstream.
    expect(upstreamSockets).toHaveLength(1);
    await vi.waitFor(() => expect(upstreamClosed).toHaveLength(1));

    await vi.waitFor(() => expect(audits.length).toBeGreaterThanOrEqual(1));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe(502);
    expect(audits[0]!.blocked).toMatch(/^tls_error: upstream connect timed out/);
  });

  it('an out-of-range port (host:99999) is refused at parse — 400 before any 200', async () => {
    // Before TASK-862 this reached `tls.connect` AFTER the 200 was written; it
    // threw ERR_SOCKET_BAD_PORT synchronously and the catch wrote a raw 502 into
    // the "established" tunnel. That throw is why the connect timer is armed
    // LAST. The port is now validated when the CONNECT is parsed, so the client
    // gets one clean 400 — no 200 ahead of it — and the dial is never reached.
    // (The armed-last ordering stays as defense in depth; CONNECT input can no
    // longer exercise it.)
    const CONNECT_TIMEOUT_MS = 50;
    const audits: ProxyAuditEntry[] = [];
    const l = await startListener('127.0.0.1', CONNECT_TIMEOUT_MS, audits);

    const response = await connectAndAwaitClose(l.port, '127.0.0.1:99999');
    expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(response).not.toContain('200 Connection Established');

    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe(400);
    expect(audits[0]!.blocked).toBe('invalid_target');
  });

  it('leaves an established MITM tunnel alone after the connect timeout has elapsed', async () => {
    const CONNECT_TIMEOUT_MS = 150;
    const leaf = generateDomainCert('127.0.0.1', ca);
    // The upstream answers only long after the connect window, and only once
    // asked — so the reply proves the tunnel outlived the window.
    const slow = tlsCreate({ key: leaf.key, cert: leaf.cert }, (sock) => {
      sock.on('error', () => { /* teardown resets are fine */ });
      sock.once('data', () => {
        setTimeout(
          () => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nlate-reply'),
          CONNECT_TIMEOUT_MS * 4,
        );
      });
    });
    servers.push(slow);
    const upPort = await new Promise<number>((r) =>
      slow.listen(0, '127.0.0.1', () => r((slow.address() as { port: number }).port)),
    );

    const audits: ProxyAuditEntry[] = [];
    const l = await startListener('127.0.0.1', CONNECT_TIMEOUT_MS, audits);

    const raw = net.connect(l.port, '127.0.0.1');
    clients.push(raw);
    await new Promise<void>((resolve, reject) => {
      raw.once('error', reject);
      raw.once('connect', () => resolve());
    });
    raw.write(rawConnect(`127.0.0.1:${upPort}`, tokenFor('s1')));
    await new Promise<void>((resolve) => {
      let acc = '';
      const onData = (d: Buffer) => {
        acc += d.toString('latin1');
        if (acc.includes('\r\n\r\n')) {
          raw.removeListener('data', onData);
          resolve();
        }
      };
      raw.on('data', onData);
    });

    const started = Date.now();
    const inner = tlsConnect({ socket: raw, servername: '127.0.0.1', ca: ca.cert });
    const received = await new Promise<string>((resolve, reject) => {
      let acc = '';
      inner.on('secureConnect', () => {
        inner.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      });
      inner.on('data', (c: Buffer) => {
        acc += c.toString('utf8');
      });
      inner.on('end', () => resolve(acc));
      inner.on('error', reject);
    });
    inner.destroy();

    expect(received).toContain('late-reply');
    expect(Date.now() - started).toBeGreaterThan(CONNECT_TIMEOUT_MS * 2);

    await vi.waitFor(() => expect(audits.length).toBeGreaterThanOrEqual(1));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe(200);
    expect(audits[0]!.blocked).toBeUndefined();
  });
});
