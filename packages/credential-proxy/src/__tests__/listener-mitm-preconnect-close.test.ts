/**
 * TASK-861 — the MITM CONNECT path must not audit a 200 for a tunnel that never
 * existed.
 *
 * The MITM path answers `200 Connection Established` BEFORE it dials the
 * upstream (it has to: it terminates the client's TLS itself). If the client
 * then hangs up while the upstream TCP connect or TLS handshake is still
 * pending, cleanup() used to write the same `status: 200` row a completed
 * tunnel gets — the audit log claimed a connection to the upstream that never
 * happened. The bypass path has tracked this with an `established` flag since
 * TASK-705; the MITM path now does too, and audits the bypass path's
 * not-established outcome: a 502 with no `blocked` reason and no response
 * bytes.
 *
 * The clock is the test's (TASK-865 pattern): only setTimeout/clearTimeout are
 * faked, so the connect timer cannot fire and produce the 502 on our behalf —
 * the row below can only come from the client's close.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import forgeModule from 'node-forge';
import {
  startProxyListener,
  type ProxyListener,
  type ProxyAuditEntry,
} from '../listener.js';
import { CredentialPlaceholderMap, SharedCredentialRegistry } from '../registry.js';
import { RequestFramer } from '../request-framer.js';
import type { CAKeyPair } from '../ca.js';
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

const CONNECT_TIMEOUT_MS = 150;

let listener: ProxyListener | undefined;
const servers: net.Server[] = [];
const clients: net.Socket[] = [];
const upstreamSockets: net.Socket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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
    { name: 'commonName', value: 'mitm-preconnect-close-ca' },
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

async function startListener(
  host: string,
  audits: ProxyAuditEntry[],
  registry = new SharedCredentialRegistry(),
): Promise<ProxyListener> {
  listener = await startProxyListener({
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    registry,
    ca,
    sessions: new Map([
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
    ]),
    upstreamConnectTimeoutMs: CONNECT_TIMEOUT_MS,
    onAudit: (e) => audits.push(e),
  });
  return listener;
}

/** CONNECT through the proxy; resolves with the raw socket once the 200 is read. */
async function openTunnel(proxyPort: number, target: string): Promise<net.Socket> {
  const raw = net.connect(proxyPort, '127.0.0.1');
  clients.push(raw);
  raw.on('error', () => { /* teardown resets are fine */ });
  await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
  raw.write(rawConnect(target, tokenFor('s1')));
  const head = await new Promise<string>((resolve) => {
    let acc = '';
    const onData = (d: Buffer) => {
      acc += d.toString('latin1');
      if (acc.includes('\r\n\r\n')) {
        raw.removeListener('data', onData);
        resolve(acc);
      }
    };
    raw.on('data', onData);
  });
  expect(head).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
  return raw;
}

/** Poll with setImmediate — vi.waitFor would advance the faked clock. */
function untilAudited(audits: ProxyAuditEntry[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = () => (audits.length >= 1 ? resolve() : setImmediate(check));
    check();
  });
}

/**
 * Settle a few I/O turns so a second, late row (if any) would have landed.
 * Real-timer-free: setImmediate is not faked.
 */
async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}

describe('proxy listener — MITM CONNECT client closes before the upstream connects (TASK-861)', () => {
  it('audits one 502, not a 200, when the client hangs up while the upstream TCP connect is pending', async () => {
    const audits: ProxyAuditEntry[] = [];
    const l = await startListener(BLACK_HOLE, audits);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const armed = vi.spyOn(globalThis, 'setTimeout');

    const raw = await openTunnel(l.port, `${BLACK_HOLE}:443`);
    // The listener really dialled the black hole, on OUR clock — so the connect
    // timer cannot be what ends this exchange.
    expect(blackHoled.sockets).toHaveLength(1);
    expect(armed.mock.calls.filter(([, ms]) => ms === CONNECT_TIMEOUT_MS)).toHaveLength(1);
    expect(audits).toHaveLength(0);

    // An abortive close (RST). A plain FIN only half-closes the proxy's
    // client socket, and before the upstream exists that FIN has nowhere to
    // go, so the exchange would wait for the connect timer instead (tracked
    // separately) — the RST makes the proxy see the client's close now.
    raw.resetAndDestroy();
    await untilAudited(audits);

    expect(audits).toHaveLength(1);
    const [entry] = audits;
    expect(entry!.status).not.toBe(200);
    expect(entry!.status).toBe(502);
    expect(entry!.method).toBe('CONNECT');
    expect(entry!.url).toBe(`${BLACK_HOLE}:443`);
    expect(entry!.responseBytes).toBe(0);
    expect(entry!.requestBytes).toBe(0);
    // Same shape as the bypass path's not-established row: no policy reason.
    expect(entry!.blocked).toBeUndefined();
    expect('credentialInjected' in entry!).toBe(false);
    expect(entry!.sessionId).toBe('s1');
    expect(entry!.userId).toBe('u1');

    // The half-open upstream was torn down and the connect timer cleared:
    // letting the window elapse adds no second row.
    expect(blackHoled.sockets[0]!.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS * 4);
    await settle();
    expect(audits).toHaveLength(1);
  });

  it('does not claim a credential reached an upstream whose TLS handshake never finished', async () => {
    // A real upstream that accepts TCP and never answers the ClientHello: the
    // proxy's upstream TLS handshake is pending for as long as the test likes.
    const silent = net.createServer((s) => {
      upstreamSockets.push(s);
      s.on('error', () => { /* proxy teardown may reset it */ });
      s.resume();
    });
    servers.push(silent);
    const upPort = await new Promise<number>((r) =>
      silent.listen(0, '127.0.0.1', () => r((silent.address() as { port: number }).port)),
    );

    const credMap = new CredentialPlaceholderMap();
    const placeholder = credMap.register('ANTHROPIC_API_KEY', 'sk-real-secret-xyz', ['127.0.0.1']);
    const registry = new SharedCredentialRegistry();
    registry.register('s1', credMap);

    const audits: ProxyAuditEntry[] = [];
    const l = await startListener('127.0.0.1', audits, registry);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const processed = vi.spyOn(RequestFramer.prototype, 'process');

    const raw = await openTunnel(l.port, `127.0.0.1:${upPort}`);
    // The client's TLS to the PROXY completes (the proxy terminates it with its
    // own leaf); only the proxy's upstream handshake is stalled.
    const inner = tlsConnect({ socket: raw, servername: '127.0.0.1', ca: ca.cert });
    inner.on('error', () => { /* teardown resets are fine */ });
    await new Promise<void>((resolve) => inner.once('secureConnect', () => resolve()));
    inner.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${placeholder}\r\n\r\n`,
    );

    // Wait until the proxy has framed the request AND substituted the
    // credential into it — the state that used to yield `credentialInjected:
    // true` on a 200 row.
    await new Promise<void>((resolve) => {
      const check = () =>
        processed.mock.results.some(
          (r) => r.type === 'return' && (r.value as { injected?: boolean }).injected === true,
        )
          ? resolve()
          : setImmediate(check);
      check();
    });
    expect(upstreamSockets).toHaveLength(1);
    expect(audits).toHaveLength(0);

    // No explicit RST needed here (unlike the test above): tearing down an
    // active inner TLS session aborts the proxy's client side, which reaches
    // cleanup() through 'error'/'close'. Were it a bare half-close, this test
    // would hang rather than pass — it cannot pass vacuously.
    inner.destroy();
    raw.destroy();
    await untilAudited(audits);
    await settle();

    expect(audits).toHaveLength(1);
    const [entry] = audits;
    expect(entry!.status).toBe(502);
    expect(entry!.blocked).toBeUndefined();
    expect(entry!.responseBytes).toBe(0);
    // Bytes the client really sent the proxy are still counted …
    expect(entry!.requestBytes).toBeGreaterThan(0);
    // … but nothing reached the upstream, so no credential was delivered.
    expect('credentialInjected' in entry!).toBe(false);
  });
});

/**
 * TASK-872 — a plain client FIN (not an RST) before the upstream is established
 * must tear the exchange down now, the way the bypass path has since TASK-786.
 *
 * The proxy's client socket is half-open, so a FIN surfaces as 'end', never
 * 'close'. It used to be forwarded as `targetTls.end()` to an upstream that did
 * not exist yet, which emits nothing — so the exchange sat out the whole
 * connect window and was then audited `502 tls_error: upstream connect timed
 * out`, a timeout that never happened. Once the upstream TCP connect had
 * landed, ending it mid-handshake instead failed it with `tls_error: Client
 * network socket disconnected …` — prompt, but blaming the upstream for the
 * client's close. Both tests keep the clock faked and never advance it before
 * the row lands, so the connect timer cannot produce it for them: on the
 * unfixed code the first hangs and the second sees a `tls_error` reason.
 */
describe('proxy listener — MITM CONNECT client FIN before the upstream connects (TASK-872)', () => {
  it('tears down on a client FIN while the upstream TCP connect is pending, without waiting out the connect timer', async () => {
    const audits: ProxyAuditEntry[] = [];
    const l = await startListener(BLACK_HOLE, audits);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const armed = vi.spyOn(globalThis, 'setTimeout');

    const raw = await openTunnel(l.port, `${BLACK_HOLE}:443`);
    expect(blackHoled.sockets).toHaveLength(1);
    expect(armed.mock.calls.filter(([, ms]) => ms === CONNECT_TIMEOUT_MS)).toHaveLength(1);
    expect(audits).toHaveLength(0);

    // A clean half-close: FIN, no RST.
    raw.end();
    await untilAudited(audits);

    expect(audits).toHaveLength(1);
    const [entry] = audits;
    expect(entry!.status).toBe(502);
    // The client closed — this is not a timeout, nor any other upstream error.
    expect(entry!.blocked).toBeUndefined();
    expect(entry!.responseBytes).toBe(0);
    expect(entry!.requestBytes).toBe(0);
    expect('credentialInjected' in entry!).toBe(false);
    expect(entry!.sessionId).toBe('s1');

    // The upstream dial was aborted and the connect timer cleared, so letting
    // the window elapse adds no second (timeout) row.
    expect(blackHoled.sockets[0]!.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS * 4);
    await settle();
    expect(audits).toHaveLength(1);
  });

  it('tears down on a client FIN after the client TLS handshake while the upstream TLS handshake is pending', async () => {
    // Accepts TCP, never answers the ClientHello.
    const silent = net.createServer((s) => {
      upstreamSockets.push(s);
      s.on('error', () => { /* proxy teardown may reset it */ });
      s.resume();
    });
    servers.push(silent);
    const upPort = await new Promise<number>((r) =>
      silent.listen(0, '127.0.0.1', () => r((silent.address() as { port: number }).port)),
    );

    const audits: ProxyAuditEntry[] = [];
    const l = await startListener('127.0.0.1', audits);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const raw = await openTunnel(l.port, `127.0.0.1:${upPort}`);
    const inner = tlsConnect({ socket: raw, servername: '127.0.0.1', ca: ca.cert });
    inner.on('error', () => { /* teardown resets are fine */ });
    await new Promise<void>((resolve) => inner.once('secureConnect', () => resolve()));
    // The proxy's upstream TCP connect has landed; only its handshake is stalled.
    await new Promise<void>((resolve) => {
      const check = () => (upstreamSockets.length >= 1 ? resolve() : setImmediate(check));
      check();
    });
    expect(audits).toHaveLength(0);

    // close_notify + FIN — a clean close, not an abort.
    inner.end();
    await untilAudited(audits);
    await settle();

    expect(audits).toHaveLength(1);
    const [entry] = audits;
    expect(entry!.status).toBe(502);
    expect(entry!.blocked).toBeUndefined();
    expect(entry!.responseBytes).toBe(0);
    expect('credentialInjected' in entry!).toBe(false);
    // The upstream half-handshake was torn down, not left for the timer.
    await new Promise<void>((resolve) => {
      const check = () => (upstreamSockets[0]!.destroyed ? resolve() : setImmediate(check));
      check();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
