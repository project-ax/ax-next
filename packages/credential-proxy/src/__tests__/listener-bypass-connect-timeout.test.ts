/**
 * TASK-786 — the bypassMITM raw tunnel bounds its upstream CONNECT phase.
 *
 * Before this, `net.connect(port, resolvedIP, …)` on the raw-tunnel path had no
 * timeout of its own: an allowlisted host that black-holes SYNs held the client
 * and the half-open upstream socket until the OS gave up (~2 minutes on Linux).
 *
 * A real black hole is not a reliable fixture — TEST-NET-1 (192.0.2.1) hangs on
 * most hosts but fails fast on some, which would let a test pass on the error
 * path without ever touching the timer. So this file swaps `net.connect` for the
 * one sentinel address below and hands the listener a real `net.Socket` that
 * simply never connects. Every other dial (the test's own client, the real
 * upstream in the "connected tunnel" case) goes through untouched.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import {
  startProxyListener,
  type ProxyListener,
  type ProxyAuditEntry,
  type SessionConfig,
} from '../listener.js';
import { SharedCredentialRegistry } from '../registry.js';
import { rawConnect, tokenFor } from './proxy-auth-helpers.js';

/** Dials to this address never complete — see the vi.mock below. */
const BLACK_HOLE = '192.0.2.1';

const blackHoled = vi.hoisted(() => ({ sockets: [] as import('node:net').Socket[] }));

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  const connect = ((...args: unknown[]) => {
    if (args[1] === '192.0.2.1') {
      // A real Socket that was never told to connect: no 'connect', no
      // 'error', no 'close' until someone destroys it. That is a black hole.
      const sock = new actual.Socket();
      blackHoled.sockets.push(sock);
      return sock;
    }
    return (actual.connect as (...a: unknown[]) => net.Socket)(...args);
  }) as typeof actual.connect;
  return { ...actual, connect, createConnection: connect };
});

let listener: ProxyListener | undefined;
const servers: net.Server[] = [];

afterEach(async () => {
  listener?.stop();
  listener = undefined;
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const s of blackHoled.sockets.splice(0)) s.destroy();
});

function bypassSession(host: string): Map<string, SessionConfig> {
  return new Map([
    [
      's1',
      {
        allowlist: new Set([host]),
        allowedIPs: new Set([host]),
        bypassMITM: new Set([host]),
        sessionId: 's1',
        userId: 'u1',
        proxyToken: tokenFor('s1'),
      },
    ],
  ]);
}

/** Resolve once `predicate` holds; fail closed (throw) if it never does. */
async function pollUntil(predicate: () => boolean, what: string, limitMs = 10_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('proxy listener — bypassMITM raw tunnel connect-phase timeout (TASK-786)', () => {
  it('answers 502 + audits once when the upstream never completes the connect', async () => {
    const CONNECT_TIMEOUT_MS = 150;
    const audits: ProxyAuditEntry[] = [];
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry: new SharedCredentialRegistry(),
      ca: { key: 'unused-key', cert: 'unused-cert' }, // bypass path never touches the CA
      sessions: bypassSession(BLACK_HOLE),
      bypassConnectTimeoutMs: CONNECT_TIMEOUT_MS,
      onAudit: (e) => audits.push(e),
    });

    // The client waits patiently and never hangs up on its own — so the only
    // thing that can end this exchange is the proxy's own connect timer.
    const started = Date.now();
    const response = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(listener!.port, '127.0.0.1', () => {
        sock.write(rawConnect(`${BLACK_HOLE}:443`, tokenFor('s1')));
      });
      let acc = '';
      sock.on('data', (c: Buffer) => {
        acc += c.toString('utf8');
      });
      sock.on('end', () => {
        sock.end();
        resolve(acc);
      });
      sock.on('error', reject);
    });
    const elapsed = Date.now() - started;

    // The listener really did dial the black hole (not some earlier refusal).
    expect(blackHoled.sockets).toHaveLength(1);
    // The client is told the truth: a 502, never "200 Connection Established".
    expect(response).toMatch(/^HTTP\/1\.1 502\b/);
    expect(response).not.toContain('200 Connection Established');
    // It came from the timer, not from something faster.
    expect(elapsed).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS - 20);
    // No leaked half-open upstream: the pending socket was torn down.
    expect(blackHoled.sockets[0]!.destroyed).toBe(true);

    // Exactly one audit, the TASK-705 network-failure shape.
    await pollUntil(() => audits.length >= 1, 'the 502 audit row');
    expect(audits).toHaveLength(1);
    const [entry] = audits;
    expect(entry!.status).toBe(502);
    expect(entry!.method).toBe('CONNECT');
    expect(entry!.url).toBe(`${BLACK_HOLE}:443`);
    expect(entry!.requestBytes).toBe(0);
    expect(entry!.responseBytes).toBe(0);
    expect(entry!.sessionId).toBe('s1');
    expect(entry!.userId).toBe('u1');
    expect(entry!.blocked).toBeUndefined();
  });

  it('a dial that throws synchronously (bad port) answers 502 and leaves no timer behind', async () => {
    // `net.connect` throws ERR_SOCKET_BAD_PORT synchronously for CONNECT
    // host:99999 — before any cleanup exists. If the connect timer were armed
    // ahead of the dial it would still fire, into an uninitialized `cleanup`,
    // and throw an uncaught ReferenceError on the host. Vitest fails the run on
    // any uncaught exception, so outliving the timer window is the assertion.
    const CONNECT_TIMEOUT_MS = 50;
    const audits: ProxyAuditEntry[] = [];
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry: new SharedCredentialRegistry(),
      ca: { key: 'unused-key', cert: 'unused-cert' },
      sessions: bypassSession('127.0.0.1'),
      bypassConnectTimeoutMs: CONNECT_TIMEOUT_MS,
      onAudit: (e) => audits.push(e),
    });

    const response = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(listener!.port, '127.0.0.1', () => {
        sock.write(rawConnect('127.0.0.1:99999', tokenFor('s1')));
      });
      let acc = '';
      sock.on('data', (c: Buffer) => {
        acc += c.toString('utf8');
      });
      sock.on('end', () => {
        sock.end();
        resolve(acc);
      });
      sock.on('error', reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 502\b/);

    // A negative can only be shown by waiting. Node fires timers in expiry
    // order, so a connect timer armed earlier with a shorter delay always fires
    // before this one — load delays both, it cannot reorder them.
    await new Promise((r) => setTimeout(r, CONNECT_TIMEOUT_MS * 6));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe(502);
  });

  it('leaves an established tunnel alone after the connect timeout has elapsed', async () => {
    const CONNECT_TIMEOUT_MS = 100;
    // The upstream speaks only once the timer would long since have fired, and
    // only after the client has asked — so the reply proves the tunnel outlived
    // the connect window without the test sleeping on a guess.
    const plain = net.createServer((socket) => {
      socket.once('data', () => {
        setTimeout(() => socket.end('late-reply'), CONNECT_TIMEOUT_MS * 4);
      });
    });
    servers.push(plain);
    const upPort = await new Promise<number>((r) =>
      plain.listen(0, '127.0.0.1', () => r((plain.address() as { port: number }).port)),
    );

    const audits: ProxyAuditEntry[] = [];
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry: new SharedCredentialRegistry(),
      ca: { key: 'unused-key', cert: 'unused-cert' },
      sessions: bypassSession('127.0.0.1'),
      bypassConnectTimeoutMs: CONNECT_TIMEOUT_MS,
      onAudit: (e) => audits.push(e),
    });

    const started = Date.now();
    const received = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(listener!.port, '127.0.0.1', () => {
        sock.write(rawConnect(`127.0.0.1:${upPort}`, tokenFor('s1')));
      });
      let acc = '';
      let tunnelUp = false;
      sock.on('data', (c: Buffer) => {
        acc += c.toString('utf8');
        if (!tunnelUp && acc.includes('\r\n\r\n')) {
          tunnelUp = true;
          sock.write('ping');
        }
      });
      sock.on('close', () => resolve(acc));
      sock.on('error', reject);
    });

    expect(received).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    expect(received).toContain('late-reply');
    // The tunnel genuinely lived past the connect window.
    expect(Date.now() - started).toBeGreaterThan(CONNECT_TIMEOUT_MS * 2);

    await pollUntil(() => audits.length >= 1, 'the tunnel audit row');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe(200);
    expect(audits[0]!.requestBytes).toBeGreaterThan(0);
    expect(audits[0]!.responseBytes).toBeGreaterThan(0);
  });
});
