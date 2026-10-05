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
  vi.restoreAllMocks();
  vi.useRealTimers();
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
      upstreamConnectTimeoutMs: CONNECT_TIMEOUT_MS,
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

  it('an out-of-range port (host:99999) is refused at parse — 400, not a 502', async () => {
    // Before TASK-862 this reached `net.connect`, which throws
    // ERR_SOCKET_BAD_PORT synchronously — the reason the connect timer is armed
    // LAST (a timer armed ahead of that throw fired into an uninitialized
    // `cleanup`). The port is now validated when the CONNECT is parsed, so the
    // client gets a 400 instead of a 502 and the dial is never reached. (The
    // armed-last ordering stays as defense in depth; CONNECT input can no longer
    // exercise it.)
    const CONNECT_TIMEOUT_MS = 50;
    const audits: ProxyAuditEntry[] = [];
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry: new SharedCredentialRegistry(),
      ca: { key: 'unused-key', cert: 'unused-cert' },
      sessions: bypassSession('127.0.0.1'),
      upstreamConnectTimeoutMs: CONNECT_TIMEOUT_MS,
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
    expect(response).toMatch(/^HTTP\/1\.1 400\b/);

    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe(400);
    expect(audits[0]!.blocked).toBe('invalid_target');
  });

  it('leaves an established tunnel alone after the connect timeout has elapsed', async () => {
    // TASK-870: this test owns the clock. It used to race the real one: the
    // proxy's upstream TCP connect had to complete inside a 100ms wall-clock
    // window, and an event-loop stall longer than that between the dial and
    // the connect let the timers phase run the connect timer before the poll
    // phase delivered the connect — a correct 502 on a tunnel that was never
    // established from Node's view. Reproduced 5/5 with a 300ms busy-wait
    // scheduled right after the dial. With setTimeout/clearTimeout faked (and
    // only those — socket I/O, setImmediate and Date stay real), the connect
    // window cannot elapse until the test says so, and it says so only after
    // the tunnel is provably established.
    const CONNECT_TIMEOUT_MS = 100;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const armed = vi.spyOn(globalThis, 'setTimeout');
    // The upstream answers only once asked AND only once the test has moved the
    // clock past the connect window — so the reply proves the tunnel outlived it.
    let answer: (() => void) | undefined;
    let markRequestSeen!: () => void;
    const upstreamGotRequest = new Promise<void>((r) => {
      markRequestSeen = r;
    });
    const plain = net.createServer((socket) => {
      socket.on('error', () => {
        /* teardown resets are fine */
      });
      socket.once('data', () => {
        answer = () => socket.end('late-reply');
        markRequestSeen();
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
      upstreamConnectTimeoutMs: CONNECT_TIMEOUT_MS,
      onAudit: (e) => audits.push(e),
    });

    const received = new Promise<string>((resolve, reject) => {
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
    // Awaited below, after the clock has moved; until then an early error must
    // not surface as an unhandled rejection (it still fails the `await`).
    received.catch(() => {
      /* observed by the await below */
    });
    // The upstream holding the client's bytes means the proxy's upstream
    // connect completed and the pipe is up: the tunnel is established.
    await upstreamGotRequest;

    // Guard against a vacuous pass: the listener's connect timer really was
    // armed on OUR clock (were it on a real one, advancing below would prove
    // nothing) — and the completed connect has already cleared it.
    expect(armed.mock.calls.filter(([, ms]) => ms === CONNECT_TIMEOUT_MS)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    // Now let the connect window elapse — four times over — with the tunnel open.
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS * 4);
    // Only after that does the upstream answer.
    answer!();

    const reply = await received;
    expect(reply).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    expect(reply).toContain('late-reply');

    // Poll with setImmediate: `pollUntil` sleeps on setTimeout, which is fake here.
    await new Promise<void>((resolve) => {
      const check = () => (audits.length >= 1 ? resolve() : setImmediate(check));
      check();
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe(200);
    expect(audits[0]!.requestBytes).toBeGreaterThan(0);
    expect(audits[0]!.responseBytes).toBeGreaterThan(0);
  });
});
