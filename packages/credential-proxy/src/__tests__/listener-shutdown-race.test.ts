/**
 * Shutdown-race regression — credential-proxy crashed the host process
 * with `read ECONNRESET` when listener.stop() destroyed sockets that were
 * in transient lifecycle states without a user-side 'error' listener
 * attached.
 *
 * Production symptom (PR #104 walk, 2026-05-19): host died with
 * `Error: read ECONNRESET at TCP.onStreamRead` after the first Anthropic
 * request through the proxy. NODE_DEBUG trace showed the listener
 * entering `SERVER _emitCloseIfDrained` with 12 connections still alive,
 * a second MITM session mid-handshake, then an unhandled 'error' on a
 * raw Socket instance.
 *
 * The invariant these tests pin: every socket that ever enters
 * `activeSockets` must have a user-attached 'error' listener BEFORE any
 * code path could destroy it. Three windows that today are vulnerable
 * (and that the fix closes):
 *
 *  1. **Inbound socket during resolveAndCheck await.** `handleCONNECT`
 *     awaits `resolveAndCheck` before reaching the handler that attaches
 *     `clientSocket.on('error', …)`.
 *
 *  2. **MITM targetTls / clientTls mid-handshake.** `tls.connect()` to
 *     the upstream produces a TLSSocket that the cleanup-path can destroy
 *     while the handshake is in flight.
 *
 *  3. **Bypass-MITM targetSocket mid-connect.** `net.connect()` to the
 *     resolved IP returns a socket whose connect-success callback hasn't
 *     fired yet when stop runs.
 *
 * The tests do not try to perfectly reproduce the production trace
 * (the SDK's specific retry + stop ordering is hard to recreate without
 * the full sandbox stack). Instead they exercise each window directly:
 * a hanging Resolver pins (1), a TCP-accept-but-no-TLS-response upstream
 * pins (2), and a same-shape upstream with `bypassMITM` pins (3). In
 * each, the test then drives `listener.stop()` plus a client-side TCP
 * RST and asserts no uncaughtException fires.
 *
 * EventEmitter throws when 'error' is emitted with zero listeners. The
 * fix attaches a noop 'error' listener at the earliest socket-creation
 * point (server.on('connection')) plus a defense-in-depth attachment in
 * stopFn() — so any racing ECONNRESET lands on a listener instead of
 * the uncaughtException path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import { startProxyListener, type ProxyListener } from '../listener.js';
import { SharedCredentialRegistry } from '../registry.js';
import type { CAKeyPair } from '../ca.js';
import forgeModule from 'node-forge';

const forge = forgeModule as typeof forgeModule;

/** Mint a throwaway CA — kept self-contained to avoid CA-on-disk side effects. */
function mintCA(): CAKeyPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    { name: 'commonName', value: 'shutdown-race-test-ca' },
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

let listener: ProxyListener | undefined;
let upstreamServer: net.Server | undefined;
// Track server-side sockets the upstream accepts, so afterEach can force-
// close them. Without this, upstream.close() hangs waiting for drain.
let upstreamSockets: net.Socket[] = [];
let uncaughtErrors: Error[] = [];
const captureUncaught = (err: Error) => {
  uncaughtErrors.push(err);
};

beforeEach(() => {
  uncaughtErrors = [];
  upstreamSockets = [];
  process.on('uncaughtException', captureUncaught);
});

afterEach(async () => {
  process.off('uncaughtException', captureUncaught);
  if (listener) {
    try {
      listener.stop();
    } catch {
      // already stopped
    }
  }
  listener = undefined;
  if (upstreamServer) {
    // Force-close any hung sockets so server.close() can drain.
    for (const s of upstreamSockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((r) => upstreamServer!.close(() => r()));
  }
  upstreamServer = undefined;
  upstreamSockets = [];
});

function uncaughtSummary(): string[] {
  return uncaughtErrors.map((e) => {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    return `${code}:${e.message}`;
  });
}

/**
 * Start a TCP server that accepts connections but never speaks anything
 * back — used to keep the proxy's tls.connect()/net.connect() pinned in
 * a mid-handshake / mid-connect state for the duration of the test.
 */
async function startHangingUpstream(): Promise<number> {
  upstreamServer = net.createServer((sock) => {
    upstreamSockets.push(sock);
    sock.on('error', () => {
      /* upstream-side errors during forced teardown are expected */
    });
    // Hold the connection open without writing anything.
  });
  await new Promise<void>((r) => upstreamServer!.listen(0, '127.0.0.1', () => r()));
  return (upstreamServer.address() as net.AddressInfo).port;
}

describe('proxy listener — shutdown-race', () => {
  it('listener.stop() during handleCONNECT resolveAndCheck await does not crash on inbound socket', async () => {
    // Resolver that never resolves — pins handleCONNECT in the await window
    // after the allowlist gate and before handleMITMConnect can attach
    // clientSocket.on('error', …).
    const hangingResolver = (): Promise<{ address: string; family: number }> =>
      new Promise(() => {
        /* hang forever */
      });

    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry: new SharedCredentialRegistry(),
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['example.test']),
            sessionId: 's1',
            userId: 'u1',
          },
        ],
      ]),
      ca: mintCA(),
      resolver: hangingResolver,
    });

    // Drive multiple in-flight CONNECTs to widen the race surface.
    const clients: net.Socket[] = [];
    for (let i = 0; i < 4; i++) {
      const client = net.connect(listener.port as number, '127.0.0.1');
      client.on('error', () => {
        /* swallow client-side errors */
      });
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
      });
      client.write('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
      clients.push(client);
    }

    // Let the proxies receive their requests and enter the resolveAndCheck await.
    await new Promise((r) => setTimeout(r, 100));

    // Force a TCP RST from each client side so the proxy's inbound sockets
    // have read-side errors queued in the kernel.
    for (const c of clients) {
      const s = c as unknown as { resetAndDestroy?: () => void };
      s.resetAndDestroy?.();
    }

    // Stop the listener — destroys all activeSockets including inbound
    // sockets which (without the fix) have no user 'error' listener yet.
    listener.stop();

    // Wait for any pending nextTick error emissions to fire.
    await new Promise((r) => setTimeout(r, 200));

    expect(uncaughtSummary()).toEqual([]);
  });

  it('listener.stop() while targetTls is mid-handshake does not crash', async () => {
    const upPort = await startHangingUpstream();

    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry: new SharedCredentialRegistry(),
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['127.0.0.1']),
            allowedIPs: new Set(['127.0.0.1']),
            sessionId: 's1',
            userId: 'u1',
          },
        ],
      ]),
      ca: mintCA(),
    });

    const clients: net.Socket[] = [];
    for (let i = 0; i < 4; i++) {
      const client = net.connect(listener.port as number, '127.0.0.1');
      client.on('error', () => {
        /* swallow */
      });
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
      });
      client.write(
        `CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nHost: 127.0.0.1:${upPort}\r\n\r\n`,
      );
      clients.push(client);
    }

    // Wait for proxy → upstream tls.connect() to reach mid-handshake state.
    await new Promise((r) => setTimeout(r, 200));

    listener.stop();

    for (const c of clients) {
      const s = c as unknown as { resetAndDestroy?: () => void };
      s.resetAndDestroy?.();
    }

    await new Promise((r) => setTimeout(r, 300));

    expect(uncaughtSummary()).toEqual([]);
  });

  it('listener.stop() while bypass-MITM targetSocket is mid-connect does not crash', async () => {
    const upPort = await startHangingUpstream();

    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry: new SharedCredentialRegistry(),
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['127.0.0.1']),
            allowedIPs: new Set(['127.0.0.1']),
            bypassMITM: new Set(['127.0.0.1']),
            sessionId: 's1',
            userId: 'u1',
          },
        ],
      ]),
      ca: mintCA(),
    });

    const clients: net.Socket[] = [];
    for (let i = 0; i < 4; i++) {
      const client = net.connect(listener.port as number, '127.0.0.1');
      client.on('error', () => {
        /* swallow */
      });
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
      });
      client.write(
        `CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nHost: 127.0.0.1:${upPort}\r\n\r\n`,
      );
      clients.push(client);
    }

    await new Promise((r) => setTimeout(r, 150));

    listener.stop();

    for (const c of clients) {
      const s = c as unknown as { resetAndDestroy?: () => void };
      s.resetAndDestroy?.();
    }

    await new Promise((r) => setTimeout(r, 200));

    expect(uncaughtSummary()).toEqual([]);
  });

  it('socket.emit("error") on an in-flight inbound socket does not crash before any user handler attaches', async () => {
    // Targeted reproduction: open an inbound TCP connection but do NOT send
    // anything. The proxy's server.on('connection') handler runs (adding to
    // activeSockets); no HTTP request has been parsed, so no handleHTTPRequest
    // or handleCONNECT has been entered, and the inbound socket has no user
    // 'error' listener. We then force an error on the socket from outside —
    // simulating what happens when the kernel surfaces ECONNRESET to a
    // pending read on the inbound socket while the proxy is mid-shutdown.
    //
    // Without the fix, this lands on EventEmitter's "no listeners for
    // 'error'" path → process.uncaughtException → crash. With the fix, the
    // noop listener attached at server.on('connection') catches it.
    //
    // We achieve the external error injection via resetAndDestroy from the
    // client side, which causes the kernel to send TCP RST. Whether that
    // surfaces ECONNRESET to the proxy's userland depends on whether the
    // proxy's socket has flowing reads. Node's HTTP server keeps the socket
    // reading until the request is parsed, so an RST while no bytes have
    // been sent should surface ECONNRESET on the proxy's read.
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry: new SharedCredentialRegistry(),
      sessions: new Map(),
      ca: mintCA(),
    });

    const clients: net.Socket[] = [];
    for (let i = 0; i < 8; i++) {
      const client = net.connect(listener.port as number, '127.0.0.1');
      client.on('error', () => {
        /* swallow */
      });
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
      });
      clients.push(client);
    }

    // Let the proxy's HTTP server finish onconnection wiring.
    await new Promise((r) => setTimeout(r, 30));

    // RST every client. Kernel sends TCP RST to the proxy's inbound sockets.
    for (const c of clients) {
      const s = c as unknown as { resetAndDestroy?: () => void };
      s.resetAndDestroy?.();
    }

    // Wait for any racing error emissions to fire.
    await new Promise((r) => setTimeout(r, 200));

    expect(uncaughtSummary()).toEqual([]);
  });
});
