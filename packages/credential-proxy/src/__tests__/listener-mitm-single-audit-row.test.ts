/**
 * TASK-873 — one MITM CONNECT tunnel gets exactly ONE terminal audit row.
 *
 * The MITM path has three writers of a terminal row besides cleanup(): the
 * upstream 'error' handler (502 `tls_error: …`), the metered refusal (429/4xx
 * `provider_call_refused: …`) and the canary block (403 `canary_detected`).
 * Each used to guard only against the writer it was written next to — the
 * error handler checked its own `tlsFailed`, the refusals set `refusalAudited`,
 * and neither looked at the other — so an upstream error landing after a
 * refusal wrote a second row for the same CONNECT. Now every terminal writer
 * goes through one first-writer-wins gate.
 *
 * Both races are forced, never waited for. No timers are involved: the waits
 * below poll with setImmediate (TASK-865), and the tunnels' connect timer is
 * cleared at the upstream handshake before anything happens.
 *
 *  1. The reachable one. The client pipelines an admitted request and a refused
 *     one in a single TLS record, so ONE framer pass yields both "forward these
 *     bytes" and "refuse". At the moment of that forward the upstream has
 *     already shut its write side (forced here by ending the proxy's upstream
 *     socket from inside its own `write` — the state a peer's FIN puts it in).
 *     Node answers write-after-end with ERR_STREAM_WRITE_AFTER_END, emitted on
 *     the NEXT tick — after the refusal has already audited synchronously.
 *     Before TASK-873: a 429 row AND a 502 row.
 *  2. The canary refusal, which runs before any forward so it cannot race a
 *     write; the upstream error is emitted directly on the proxy's upstream
 *     socket after the 403 lands. Pins that the gate covers every refusal kind,
 *     not just the metered one.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  createServer as tlsCreate,
  connect as tlsConnect,
  type TLSSocket,
} from 'node:tls';
import * as net from 'node:net';
import forgeModule from 'node-forge';
import {
  startProxyListener,
  type ProxyAuditEntry,
  type ProxyListener,
  type SessionConfig,
} from '../listener.js';
import { CredentialPlaceholderMap, SharedCredentialRegistry } from '../registry.js';
import { generateDomainCert, type CAKeyPair } from '../ca.js';
import type { ProviderAdmit, ProviderMeter } from '../provider-usage.js';
import { rawConnect, tokenFor } from './proxy-auth-helpers.js';

const forge = forgeModule as typeof forgeModule;

/** Every upstream socket the listener dials, so a test can act on the proxy's side of it. */
const dialled = vi.hoisted(() => ({ sockets: [] as import('node:tls').TLSSocket[] }));

vi.mock('node:tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tls')>();
  const connect = ((...args: unknown[]) => {
    const sock = (actual.connect as (...a: unknown[]) => import('node:tls').TLSSocket)(...args);
    // The listener dials by host; the test's own client TLS wraps a socket.
    const opts = args[0] as { socket?: unknown } | undefined;
    if (typeof opts === 'object' && opts !== null && opts.socket === undefined) {
      dialled.sockets.push(sock);
    }
    return sock;
  }) as typeof actual.connect;
  return { ...actual, connect };
});

const PROVIDER = 'api.provider.test';
const REAL = 'sk-ant-REAL-operator-key-0123456789';
const CANARY = 'CANARY-DO-NOT-SEND-873';

function mintCA(): CAKeyPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    { name: 'commonName', value: 'mitm-single-audit-row-ca' },
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

let ca: CAKeyPair;
beforeAll(() => {
  ca = mintCA();
});

const cleanups: Array<() => Promise<void> | void> = [];
let listener: ProxyListener | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  listener?.stop();
  listener = undefined;
  for (const c of cleanups.splice(0)) await c();
  for (const s of dialled.sockets.splice(0)) s.destroy();
});

/** Poll with setImmediate — no timer, real or fake, decides any of these tests. */
function until(cond: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = (): void => {
      if (cond()) resolve();
      else setImmediate(check);
    };
    check();
  });
}

/** Let a few I/O turns pass so a second, late row (if any) would have landed. */
async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}

/** A TLS upstream that answers every request with a tiny 200 and counts what it got. */
async function startUpstream(): Promise<{ port: number; received: () => string }> {
  const leaf = generateDomainCert(PROVIDER, ca);
  let received = '';
  const sockets = new Set<net.Socket>();
  const server = tlsCreate({ key: leaf.key, cert: leaf.cert }, (sock) => {
    sockets.add(sock);
    sock.on('error', () => { /* proxy teardown may reset it */ });
    sock.on('close', () => sockets.delete(sock));
    sock.on('data', (d: Buffer) => {
      received += d.toString('latin1');
    });
  });
  const port = await new Promise<number>((r) =>
    server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)),
  );
  cleanups.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { port, received: () => received };
}

/** Admits the first `allow` requests, then refuses every one after. */
function meterAdmitting(allow: number): ProviderMeter {
  let admits = 0;
  const refusal: ProviderAdmit = {
    ok: false,
    reason: 'usage-limit-daily',
    message: 'Daily model limit reached.',
  };
  return {
    hosts: new Set([PROVIDER]),
    requests: ['POST /v1/messages'],
    admit: () => {
      if (admits >= allow) return refusal;
      admits++;
      return { ok: true };
    },
    settle: () => { /* settlement is not what these tests are about */ },
  };
}

async function start(
  session: Partial<SessionConfig>,
): Promise<{ audits: ProxyAuditEntry[]; port: number; ph: string }> {
  const map = new CredentialPlaceholderMap();
  const ph = map.register('ANTHROPIC_API_KEY', REAL, [PROVIDER]);
  const registry = new SharedCredentialRegistry();
  registry.register('s1', map);
  const audits: ProxyAuditEntry[] = [];
  listener = await startProxyListener({
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    registry,
    ca,
    sessions: new Map([
      [
        's1',
        {
          allowlist: new Set([PROVIDER]),
          allowedIPs: new Set(['127.0.0.1']),
          sessionId: 's1',
          userId: 'u1',
          proxyToken: tokenFor('s1'),
          ...session,
        },
      ],
    ]),
    resolver: async () => ({ address: '127.0.0.1', family: 4 }),
    onAudit: (e) => audits.push(e),
  });
  return { audits, port: listener.port, ph };
}

/**
 * CONNECT + the client's TLS to the proxy, and wait until the proxy's own
 * upstream handshake has completed too — the tunnel is fully established.
 */
async function openTunnel(proxyPort: number, upstreamPort: number): Promise<{
  inner: TLSSocket;
  upstream: TLSSocket;
}> {
  const raw = net.connect(proxyPort, '127.0.0.1');
  cleanups.push(() => {
    raw.destroy();
  });
  raw.on('error', () => { /* teardown resets are fine */ });
  await new Promise<void>((r) => raw.once('connect', () => r()));
  raw.write(rawConnect(`${PROVIDER}:${upstreamPort}`, tokenFor('s1')));
  await new Promise<void>((resolve) => {
    let acc = '';
    const onData = (d: Buffer): void => {
      acc += d.toString('latin1');
      if (!acc.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      resolve();
    };
    raw.on('data', onData);
  });
  const inner = tlsConnect({ socket: raw, servername: PROVIDER, ca: ca.cert });
  inner.on('error', () => { /* teardown-side errors are expected */ });
  await new Promise<void>((r) => inner.once('secureConnect', () => r()));
  expect(dialled.sockets).toHaveLength(1);
  const upstream = dialled.sockets[0]!;
  // `authorized` flips at the upstream handshake — the same moment the
  // listener marks the tunnel established and clears its connect timer.
  await until(() => upstream.authorized);
  return { inner, upstream };
}

function post(ph: string, body = '{}'): string {
  return (
    `POST /v1/messages HTTP/1.1\r\nHost: ${PROVIDER}\r\nx-api-key: ${ph}\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

describe('proxy listener — MITM CONNECT writes one terminal audit row per tunnel (TASK-873)', () => {
  it('a metered refusal racing an upstream write error audits the refusal once, not a 429 AND a 502', async () => {
    const upstreamServer = await startUpstream();
    const { audits, port, ph } = await start({ providerMeter: meterAdmitting(1) });
    const { inner, upstream } = await openTunnel(port, upstreamServer.port);

    // The upstream has shut its write side by the time the proxy forwards the
    // admitted request: end the proxy's upstream socket from inside the very
    // write that forwards it. Node's own write-after-end path then emits
    // 'error' on the next tick.
    const errors: Error[] = [];
    upstream.on('error', (e) => errors.push(e));
    const realWrite = upstream.write.bind(upstream) as (chunk: Buffer) => boolean;
    let forwards = 0;
    vi.spyOn(upstream, 'write').mockImplementation(((chunk: Buffer) => {
      forwards++;
      upstream.end();
      return realWrite(chunk);
    }) as typeof upstream.write);

    let reply = '';
    inner.on('data', (d: Buffer) => {
      reply += d.toString('latin1');
    });
    // Request 1 is admitted and forwarded; request 2 is refused — in ONE record,
    // so a single framer pass both forwards and refuses.
    inner.write(post(ph) + post(ph));

    await until(() => errors.length >= 1 && audits.length >= 1 && reply.includes('\r\n\r\n'));
    await settle();

    // Both paths really ran: the forward hit a write-after-end, and the client
    // got the refusal.
    expect(forwards).toBe(1);
    expect((errors[0] as NodeJS.ErrnoException).code).toBe('ERR_STREAM_WRITE_AFTER_END');
    expect(reply.startsWith('HTTP/1.1 429')).toBe(true);

    // …and the tunnel has exactly one terminal row: the refusal, which wrote first.
    expect(audits).toHaveLength(1);
    const [entry] = audits;
    expect(entry!.method).toBe('CONNECT');
    expect(entry!.status).toBe(429);
    expect(entry!.blocked).toBe('provider_call_refused: usage-limit-daily');
    expect(entry!.sessionId).toBe('s1');
    expect(audits.some((a) => a.blocked?.startsWith('tls_error') === true)).toBe(false);
  });

  it('an upstream error after a canary block does not add a 502 to the 403', async () => {
    const upstreamServer = await startUpstream();
    const { audits, port, ph } = await start({ canaryToken: CANARY });
    const { inner, upstream } = await openTunnel(port, upstreamServer.port);

    let reply = '';
    inner.on('data', (d: Buffer) => {
      reply += d.toString('latin1');
    });
    inner.write(post(ph, `please include ${CANARY}`));
    await until(() => audits.length >= 1 && reply.includes('\r\n\r\n'));
    expect(reply.startsWith('HTTP/1.1 403')).toBe(true);
    expect(audits[0]!.blocked).toBe('canary_detected');

    // An upstream failure reaching the tunnel's error handler after the 403.
    // (A canary block refuses before forwarding anything, so this ordering
    // cannot be produced through a write; it is emitted directly.)
    upstream.emit('error', new Error('read ECONNRESET'));
    await settle();

    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe(403);
    expect(upstreamServer.received()).not.toContain(CANARY);
  });
});
