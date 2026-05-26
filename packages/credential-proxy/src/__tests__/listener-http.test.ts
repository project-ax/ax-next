import { describe, it, expect, afterEach } from 'vitest';
import { createServer as httpCreate, type Server } from 'node:http';
import { ProxyAgent } from 'undici';
import {
  startProxyListener,
  type ProxyListener,
  type ProxyAuditEntry,
  type SessionConfig,
} from '../listener.js';
import { SharedCredentialRegistry } from '../registry.js';
import type { CAKeyPair } from '../ca.js';
import forgeModule from 'node-forge';

const forge = forgeModule as typeof forgeModule;

/**
 * Mint a throwaway CA. The HTTP path doesn't terminate TLS, so this CA is
 * never actually exercised — it's just here because `startProxyListener`
 * requires one (MITM is the default for HTTPS).
 */
function mintCA(): CAKeyPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: 'commonName', value: 'http-test-ca' }];
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

let upstream: Server | undefined;
let listener: ProxyListener | undefined;

afterEach(async () => {
  if (listener) listener.stop();
  if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  upstream = listener = undefined;
});

describe('proxy listener — HTTP forwarding', () => {
  it('forwards GET to allowlisted upstream and returns body', async () => {
    upstream = httpCreate((_req, res) => {
      res.end('OK from upstream');
    });
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: mintCA(),
      sessions: new Map([
        ['s1', { allowlist: new Set(['127.0.0.1']), allowedIPs: new Set(['127.0.0.1']) }],
      ]),
    });

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false, // HTTP path: send absolute-URL request, not CONNECT
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK from upstream');
  });

  it('returns 403 when host not in any session allowlist', async () => {
    upstream = httpCreate((_req, res) => res.end('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: mintCA(),
      sessions: new Map([
        [
          's1',
          { allowlist: new Set(['other.example.com']), allowedIPs: new Set(['127.0.0.1']) },
        ],
      ]),
    });

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false, // HTTP path: send absolute-URL request, not CONNECT
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    expect(res.status).toBe(403);
  });

  it('attributes an allowlist-miss 403 to its session when the request carries the proxy token (TASK-52)', async () => {
    upstream = httpCreate((_req, res) => res.end('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const token = 'a'.repeat(32);
    const audits: ProxyAuditEntry[] = [];
    const registry = new SharedCredentialRegistry();
    const sessions = new Map<string, SessionConfig>([
      [
        's1',
        {
          // 'other.example.com' is allowed; the request targets 127.0.0.1 →
          // allowlist MISS → 403, which matches NO session via findAllowing-
          // Session. Attribution must come from the token instead.
          allowlist: new Set(['other.example.com']),
          sessionId: 's1',
          userId: 'u1',
          proxyToken: token,
        },
      ],
    ]);
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: mintCA(),
      sessions,
      onAudit: (e) => audits.push(e),
    });

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false,
      // undici sets Proxy-Authorization to this token string verbatim.
      token: 'Basic ' + Buffer.from('ax:' + token).toString('base64'),
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/x`, { dispatcher } as RequestInit);
    expect(res.status).toBe(403);

    const block = audits.find((a) => a.blocked?.startsWith('domain_denied:'));
    expect(block).toBeDefined();
    expect(block!.sessionId).toBe('s1');
    expect(block!.userId).toBe('u1');
  });

  it('leaves the session unattributed on a blocked request with no token (no widening, just no attribution) (TASK-52)', async () => {
    upstream = httpCreate((_req, res) => res.end('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const audits: ProxyAuditEntry[] = [];
    const registry = new SharedCredentialRegistry();
    const sessions = new Map<string, SessionConfig>([
      [
        's1',
        {
          allowlist: new Set(['other.example.com']),
          sessionId: 's1',
          userId: 'u1',
          proxyToken: 'a'.repeat(32),
        },
      ],
    ]);
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: mintCA(),
      sessions,
      onAudit: (e) => audits.push(e),
    });

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false,
      // No token at all.
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/x`, { dispatcher } as RequestInit);
    // Still blocked — the missing token never widens egress.
    expect(res.status).toBe(403);

    const block = audits.find((a) => a.blocked?.startsWith('domain_denied:'));
    expect(block).toBeDefined();
    expect(block!.sessionId).toBeUndefined();
    expect(block!.userId).toBeUndefined();
  });

  it('leaves the session unattributed on a blocked request with an unknown/forged token (TASK-52)', async () => {
    upstream = httpCreate((_req, res) => res.end('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const audits: ProxyAuditEntry[] = [];
    const registry = new SharedCredentialRegistry();
    const sessions = new Map<string, SessionConfig>([
      [
        's1',
        {
          allowlist: new Set(['other.example.com']),
          sessionId: 's1',
          userId: 'u1',
          proxyToken: 'a'.repeat(32),
        },
      ],
    ]);
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: mintCA(),
      sessions,
      onAudit: (e) => audits.push(e),
    });

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false,
      // A well-formed but UNREGISTERED token — matches no session.
      token: 'Basic ' + Buffer.from('ax:' + 'f'.repeat(32)).toString('base64'),
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/x`, { dispatcher } as RequestInit);
    expect(res.status).toBe(403);

    const block = audits.find((a) => a.blocked?.startsWith('domain_denied:'));
    expect(block).toBeDefined();
    expect(block!.sessionId).toBeUndefined();
  });

  it('returns 413 when a plain-HTTP request body exceeds the cap (does not buffer it all)', async () => {
    // A large upload through the HTTP-forward path used to be read into one
    // unbounded Buffer.concat — an OOM vector on a memory-tight host (TASK-24).
    // The cap returns 413 and the upstream never sees the body. We use a small
    // cap so the test stays fast.
    let upstreamSawBytes = 0;
    upstream = httpCreate((req, res) => {
      req.on('data', (c: Buffer) => {
        upstreamSawBytes += c.length;
      });
      req.on('end', () => res.end('OK'));
    });
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: mintCA(),
      maxHttpRequestBodyBytes: 1024, // tiny cap for the test
      sessions: new Map([
        ['s1', { allowlist: new Set(['127.0.0.1']), allowedIPs: new Set(['127.0.0.1']) }],
      ]),
    });

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false,
    });
    const big = Buffer.alloc(1024 * 8, 0x61); // 8 KiB > 1 KiB cap
    const res = await fetch(`http://127.0.0.1:${upPort}/up`, {
      method: 'POST',
      body: big,
      dispatcher,
    } as RequestInit);
    expect(res.status).toBe(413);
    // The upstream must NOT have received the oversized body.
    expect(upstreamSawBytes).toBe(0);
  });

  it('returns 413 for a CHUNKED streaming upload over the cap (no destroyed-stream reset; Codex P2)', async () => {
    // A chunked (no Content-Length) upload that keeps sending past the cap. The
    // earlier `break` out of the async iterator destroyed the IncomingMessage,
    // so the 413 could race a socket reset and the client saw a connection
    // error instead. The fix keeps draining the body without destroying it, so
    // the 413 lands cleanly.
    upstream = httpCreate((_req, res) => res.end('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );
    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: mintCA(),
      maxHttpRequestBodyBytes: 4096,
      sessions: new Map([
        ['s1', { allowlist: new Set(['127.0.0.1']), allowedIPs: new Set(['127.0.0.1']) }],
      ]),
    });
    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false,
    });
    // A chunked body that emits 16 x 1 KiB chunks with small gaps so the cap
    // (4 KiB) trips well before the stream ends — exercises the mid-stream path.
    let emitted = 0;
    const chunked = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (emitted >= 16) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x62));
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/stream-up`, {
      method: 'POST',
      body: chunked,
      duplex: 'half',
      dispatcher,
    } as RequestInit);
    // The key assertion: a clean 413, not a thrown connection error.
    expect(res.status).toBe(413);
  });

  it('forwards a plain-HTTP request body that is under the cap', async () => {
    let received = '';
    upstream = httpCreate((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received = Buffer.concat(chunks).toString('utf8');
        res.end('OK');
      });
    });
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: mintCA(),
      maxHttpRequestBodyBytes: 1024,
      sessions: new Map([
        ['s1', { allowlist: new Set(['127.0.0.1']), allowedIPs: new Set(['127.0.0.1']) }],
      ]),
    });
    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false,
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/up`, {
      method: 'POST',
      body: 'small body',
      dispatcher,
    } as RequestInit);
    expect(res.status).toBe(200);
    expect(received).toBe('small body');
  });

  it('settles cleanly when the client aborts a streaming upload mid-flight (no hung handler; Codex P2)', async () => {
    // A client that disconnects mid-upload fires 'close'/'aborted' WITHOUT
    // 'end'. The body-drain promise must settle on those (not only on 'end'),
    // or the handler hangs and retains buffers until process teardown. We can't
    // easily assert "the handler returned" from outside, so we assert the
    // listener stays HEALTHY: a second normal request through it still succeeds
    // after an aborted one (a wedged handler/leaked socket would degrade it).
    let upstreamHits = 0;
    upstream = httpCreate((_req, res) => {
      upstreamHits += 1;
      res.end('OK');
    });
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );
    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: mintCA(),
      maxHttpRequestBodyBytes: 4096,
      sessions: new Map([
        ['s1', { allowlist: new Set(['127.0.0.1']), allowedIPs: new Set(['127.0.0.1']) }],
      ]),
    });
    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false,
    });

    // Abort the upload after the first chunk (mid-stream, before end).
    const ac = new AbortController();
    let emitted = 0;
    const aborting = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (emitted >= 1) {
          ac.abort();
          controller.error(new DOMException('aborted', 'AbortError'));
          return;
        }
        emitted += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x63));
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    await expect(
      fetch(`http://127.0.0.1:${upPort}/abort-up`, {
        method: 'POST',
        body: aborting,
        duplex: 'half',
        signal: ac.signal,
        dispatcher,
      } as RequestInit),
    ).rejects.toThrow(); // the abort surfaces as a client-side rejection

    // The aborted upload must NOT have reached the upstream.
    expect(upstreamHits).toBe(0);

    // The listener is still healthy: a fresh normal GET succeeds.
    const ok = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    expect(ok.status).toBe(200);
    expect(upstreamHits).toBe(1);
  });

  it('returns 403 for private-IP target without allowedIPs override', async () => {
    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: mintCA(),
      sessions: new Map([
        ['s1', { allowlist: new Set(['127.0.0.1']) /* no allowedIPs */ }],
      ]),
    });
    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false, // HTTP path: send absolute-URL request, not CONNECT
    });
    // We're testing the proxy's private-IP block. Requesting
    // `http://127.0.0.1/` (the metadata-style bare-loopback target) is
    // the exact SSRF surface the listener must reject; switching to
    // HTTPS here would change the path under test and bypass the rule
    // that's being verified.
    const res = await fetch(`http://127.0.0.1/`, { dispatcher } as RequestInit); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
    expect(res.status).toBe(403);
  });
});
