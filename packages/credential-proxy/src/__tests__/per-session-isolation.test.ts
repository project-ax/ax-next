/**
 * TASK-158 — per-session egress isolation at the credential proxy.
 *
 * Production runs ONE shared proxy for every user. Before this card the
 * allow/deny gate was "some registered session's allowlist has this host", so
 * user A's allowlisted host (a private connector, a remembered site) was
 * reachable by user B's prompt-injected agent. The gate is now: authenticate
 * the caller by its per-session `Proxy-Authorization` token, then check THAT
 * session's own allowlist / allowedIPs / bypassMITM. No token, a malformed
 * token, or an unknown token is refused (407) before anything else runs.
 *
 * These tests drive the REAL listener over real sockets, on BOTH paths that
 * reach the allow decision: plain-HTTP forward and CONNECT (raw tunnel and
 * MITM). Every "denied" case also asserts the upstream saw NOTHING — a 403 that
 * still let bytes through would be the bug, wearing a status code.
 *
 * Each test is written to fail against the pre-TASK-158 listener (one that ORs
 * allowlists across sessions and treats the token as attribution-only):
 * the cross-session cases would get 200 instead of 403, the no-token / bad-
 * token cases would get 200/403 instead of 407, and the allowedIPs case would
 * get 200 instead of 403.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer as httpCreate, type Server } from 'node:http';
import { createServer as tlsCreate, type Server as TLSServer } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';
import forgeModule from 'node-forge';
import {
  startProxyListener,
  type ProxyAuditEntry,
  type ProxyListener,
  type SessionConfig,
} from '../listener.js';
import { SharedCredentialRegistry } from '../registry.js';
import type { CAKeyPair } from '../ca.js';
import { basicAuth, rawConnect, tokenFor, viaHttpProxy } from './proxy-auth-helpers.js';

const forge = forgeModule as typeof forgeModule;

// ── Fixtures ─────────────────────────────────────────────────────────

function mintCA(commonName: string): CAKeyPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: 'commonName', value: commonName }];
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

/** A leaf for `domain` signed by `ca` with a FRESH keypair (no per-domain cache). */
function mintLeaf(domain: string, ca: CAKeyPair): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = 'a1b2';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject([{ name: 'commonName', value: domain }]);
  cert.setIssuer(forge.pki.certificateFromPem(ca.cert).subject.attributes);
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(ca.key), forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

/** Every "hostname" resolves to loopback; each session's allowedIPs decides if that's permitted. */
const loopbackResolver = async (): Promise<{ address: string; family: number }> => ({
  address: '127.0.0.1',
  family: 4,
});

interface Upstream {
  port: number;
  /** Requests the upstream actually received (HTTP upstreams only). */
  hits: Array<{ host: string | undefined; proxyAuthorization: string | undefined }>;
  /** TCP connections the upstream accepted (any protocol). */
  connections: () => number;
}

const closers: Array<() => Promise<void> | void> = [];
let listener: ProxyListener | undefined;

afterEach(async () => {
  if (listener) listener.stop();
  listener = undefined;
  for (const close of closers.splice(0)) await close();
});

async function startHttpUpstream(): Promise<Upstream> {
  const hits: Upstream['hits'] = [];
  let connections = 0;
  const server: Server = httpCreate((req, res) => {
    hits.push({
      host: req.headers.host,
      proxyAuthorization: req.headers['proxy-authorization'] as string | undefined,
    });
    res.end('upstream-ok');
  });
  server.on('connection', () => {
    connections++;
  });
  const port = await new Promise<number>((r) =>
    server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)),
  );
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { port, hits, connections: () => connections };
}

function session(label: string, over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    allowlist: new Set(),
    allowedIPs: new Set(['127.0.0.1']),
    sessionId: label,
    userId: `user-of-${label}`,
    proxyToken: tokenFor(label),
    ...over,
  };
}

/** A session with NO allowedIPs override: loopback (private) targets stay SSRF-blocked. */
function strictSession(label: string, over: Partial<SessionConfig> = {}): SessionConfig {
  const { allowedIPs: _drop, ...rest } = session(label, over);
  return rest;
}

async function startListener(
  sessions: SessionConfig[],
  ca: CAKeyPair = mintCA('isolation-proxy-ca'),
): Promise<{ audits: ProxyAuditEntry[]; port: number }> {
  const audits: ProxyAuditEntry[] = [];
  listener = await startProxyListener({
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    registry: new SharedCredentialRegistry(),
    ca,
    sessions: new Map(sessions.map((s) => [s.sessionId as string, s])),
    resolver: loopbackResolver,
    onAudit: (e) => audits.push(e),
  });
  return { audits, port: listener.port };
}

// ── CONNECT client ───────────────────────────────────────────────────

interface ConnectResult {
  /** Everything the proxy wrote back, up to and including the header block. */
  head: string;
  status: number;
  socket: net.Socket;
}

/** Send a raw CONNECT and read the proxy's reply header block. */
function connectVia(proxyPort: number, request: string): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(request));
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\r\n\r\n')) return;
      socket.removeListener('data', onData);
      const status = parseInt(buf.split(' ')[1] ?? '0', 10);
      resolve({ head: buf, status, socket });
    };
    socket.on('data', onData);
    socket.on('error', reject);
    // A refusal ends the socket; if no header block ever arrived, fail loudly.
    socket.on('close', () => reject(new Error(`socket closed before a reply header: ${JSON.stringify(buf)}`)));
    closers.push(() => {
      socket.destroy();
    });
  });
}

/** Read whatever else the proxy writes until it ends the socket (the 403/407 body). */
function drain(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    socket.on('data', (c: Buffer) => (out += c.toString('utf8')));
    socket.on('close', () => resolve(out));
    socket.on('error', () => resolve(out));
    socket.on('end', () => resolve(out));
  });
}

// ─────────────────────────────────────────────────────────────────────

const A = 'sess-a';
const B = 'sess-b';

describe('per-session egress isolation — plain HTTP forward', () => {
  it("lets each session reach its OWN host, and each upstream sees only its own session's traffic", async () => {
    const upA = await startHttpUpstream();
    const upB = await startHttpUpstream();
    const { port } = await startListener([
      session(A, { allowlist: new Set(['a.test']) }),
      session(B, { allowlist: new Set(['b.test']) }),
    ]);

    const a = await viaHttpProxy(port, `http://a.test:${upA.port}/`, basicAuth(tokenFor(A)));
    const b = await viaHttpProxy(port, `http://b.test:${upB.port}/`, basicAuth(tokenFor(B)));

    expect(a.status).toBe(200);
    expect(a.body).toBe('upstream-ok');
    expect(b.status).toBe(200);
    expect(upA.hits).toHaveLength(1);
    expect(upB.hits).toHaveLength(1);
  });

  it("refuses session A's token reaching host B, without contacting the upstream, attributed to A", async () => {
    const up = await startHttpUpstream();
    const { port, audits } = await startListener([
      session(A, { allowlist: new Set(['a.test']) }),
      session(B, { allowlist: new Set(['b.test']) }),
    ]);

    const res = await viaHttpProxy(port, `http://b.test:${up.port}/`, basicAuth(tokenFor(A)));

    expect(res.status).toBe(403);
    expect(res.body).toContain('b.test');
    expect(res.body).toContain("this session's allowlist");
    expect(up.hits).toHaveLength(0);
    expect(up.connections()).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      status: 403,
      blocked: 'domain_denied: b.test',
      sessionId: A,
      userId: `user-of-${A}`,
    });
  });

  it("refuses session B's token reaching host A (the reverse direction)", async () => {
    const up = await startHttpUpstream();
    const { port, audits } = await startListener([
      session(A, { allowlist: new Set(['a.test']) }),
      session(B, { allowlist: new Set(['b.test']) }),
    ]);

    const res = await viaHttpProxy(port, `http://a.test:${up.port}/`, basicAuth(tokenFor(B)));

    expect(res.status).toBe(403);
    expect(up.hits).toHaveLength(0);
    expect(audits[0]).toMatchObject({ sessionId: B, blocked: 'domain_denied: a.test' });
  });

  it('is not fooled by the ORDER sessions were registered in (last-registered owner of a host is not special)', async () => {
    const up = await startHttpUpstream();
    // B registered first and owns nothing; A registered last and owns a.test.
    const { port } = await startListener([
      session(B, { allowlist: new Set(['b.test']) }),
      session(A, { allowlist: new Set(['a.test']) }),
    ]);
    const res = await viaHttpProxy(port, `http://a.test:${up.port}/`, basicAuth(tokenFor(B)));
    expect(res.status).toBe(403);
    expect(up.hits).toHaveLength(0);
  });

  it('refuses a request with NO Proxy-Authorization (407), even for a host some session allows', async () => {
    const up = await startHttpUpstream();
    const { port, audits } = await startListener([session(A, { allowlist: new Set(['a.test']) })]);

    const res = await viaHttpProxy(port, `http://a.test:${up.port}/`, undefined);

    expect(res.status).toBe(407);
    expect(res.headers['proxy-authenticate']).toBe('Basic realm="ax-egress"');
    expect(res.body).not.toContain('a.test'); // echoes nothing about the target
    expect(up.hits).toHaveLength(0);
    expect(up.connections()).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: 407, blocked: 'proxy_auth_required' });
    expect(audits[0]?.sessionId).toBeUndefined();
    expect(audits[0]?.userId).toBeUndefined();
  });

  it.each([
    ['an unknown but well-formed token', basicAuth('f'.repeat(32))],
    ['a token that is too short', basicAuth('a1b2c3')],
    ['a token that is too long', basicAuth(tokenFor(A) + '00')],
    ['a token in UPPERCASE hex', basicAuth(tokenFor(A).toUpperCase())],
    ['a valid token with a trailing newline', basicAuth(tokenFor(A) + '\n')],
    ['a Bearer scheme carrying the valid token', `Bearer ${tokenFor(A)}`],
    ['a Basic header that is not base64', 'Basic !!!not-base64!!!'],
    ['a Basic header with no colon in the decoded value', `Basic ${Buffer.from('axtoken').toString('base64')}`],
    ['a Basic header with an empty token', basicAuth('')],
    ['an empty header', ''],
  ])('refuses %s (407) and never reaches the upstream', async (_name, header) => {
    const up = await startHttpUpstream();
    const { port, audits } = await startListener([session(A, { allowlist: new Set(['a.test']) })]);

    const res = await viaHttpProxy(port, `http://a.test:${up.port}/`, header);

    expect(res.status).toBe(407);
    expect(up.hits).toHaveLength(0);
    expect(audits[0]).toMatchObject({ status: 407, blocked: 'proxy_auth_required' });
    expect(audits[0]?.sessionId).toBeUndefined();
  });

  it('accepts the Basic scheme case-insensitively (RFC 9110) — a legitimate client is not locked out', async () => {
    const up = await startHttpUpstream();
    const { port } = await startListener([session(A, { allowlist: new Set(['a.test']) })]);
    const lower = basicAuth(tokenFor(A)).replace(/^Basic/, 'basic');
    const res = await viaHttpProxy(port, `http://a.test:${up.port}/`, lower);
    expect(res.status).toBe(200);
  });

  it("stops honouring a token the moment its session is removed (close-session revokes reach)", async () => {
    const up = await startHttpUpstream();
    const sessions = [session(A, { allowlist: new Set(['a.test']) })];
    const audits: ProxyAuditEntry[] = [];
    const map = new Map(sessions.map((s) => [s.sessionId as string, s]));
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry: new SharedCredentialRegistry(),
      ca: mintCA('isolation-proxy-ca'),
      sessions: map,
      resolver: loopbackResolver,
      onAudit: (e) => audits.push(e),
    });

    const before = await viaHttpProxy(listener.port, `http://a.test:${up.port}/`, basicAuth(tokenFor(A)));
    expect(before.status).toBe(200);

    map.delete(A); // what proxy:close-session does
    const after = await viaHttpProxy(listener.port, `http://a.test:${up.port}/`, basicAuth(tokenFor(A)));
    expect(after.status).toBe(407);
    expect(up.hits).toHaveLength(1);
  });

  it("takes allowedIPs from the CALLER, not from whichever session happens to allow the host", async () => {
    const up = await startHttpUpstream();
    // Both sessions allowlist shared.test, which resolves to loopback (a private IP).
    // Only A carries the allowedIPs override; B must still hit the SSRF block.
    const { port, audits } = await startListener([
      session(A, { allowlist: new Set(['shared.test']), allowedIPs: new Set(['127.0.0.1']) }),
      strictSession(B, { allowlist: new Set(['shared.test']) }),
    ]);

    const res = await viaHttpProxy(port, `http://shared.test:${up.port}/`, basicAuth(tokenFor(B)));

    expect(res.status).toBe(403);
    expect(up.hits).toHaveLength(0);
    expect(audits[0]).toMatchObject({ sessionId: B });
    expect(audits[0]?.blocked).toMatch(/^Blocked:/);
  });

  it('does NOT forward the session token upstream (Proxy-Authorization is hop-by-hop)', async () => {
    const up = await startHttpUpstream();
    const { port } = await startListener([session(A, { allowlist: new Set(['a.test']) })]);

    const res = await viaHttpProxy(port, `http://a.test:${up.port}/`, basicAuth(tokenFor(A)));

    expect(res.status).toBe(200);
    expect(up.hits).toHaveLength(1);
    expect(up.hits[0]?.proxyAuthorization).toBeUndefined();
  });

  it("widening one session's allowlist live does not widen anyone else's", async () => {
    const up = await startHttpUpstream();
    const a = session(A, { allowlist: new Set(['a.test']) });
    const b = session(B, { allowlist: new Set(['b.test']) });
    const { port } = await startListener([a, b]);

    // What proxy:add-host does: mutate the owner session's own Set, live.
    a.allowlist.add('b.test');

    const aToB = await viaHttpProxy(port, `http://b.test:${up.port}/`, basicAuth(tokenFor(A)));
    const bToA = await viaHttpProxy(port, `http://a.test:${up.port}/`, basicAuth(tokenFor(B)));
    expect(aToB.status).toBe(200);
    expect(bToA.status).toBe(403);
  });
});

describe('per-session egress isolation — HTTPS CONNECT', () => {
  /** Force the raw-tunnel branch so a plain HTTP upstream can answer through it. */
  const rawTunnel = (host: string): Partial<SessionConfig> => ({ bypassMITM: new Set([host]) });

  it("lets a session open a tunnel to its OWN host", async () => {
    const up = await startHttpUpstream();
    const { port, audits } = await startListener([
      session(A, { allowlist: new Set(['a.test']), ...rawTunnel('a.test') }),
      session(B, { allowlist: new Set(['b.test']) }),
    ]);

    const c = await connectVia(port, rawConnect(`a.test:${up.port}`, tokenFor(A)));
    expect(c.status).toBe(200);
    c.socket.write('GET / HTTP/1.0\r\nHost: a.test\r\n\r\n');
    const reply = await drain(c.socket);
    expect(reply).toContain('upstream-ok');
    expect(up.hits).toHaveLength(1);
    expect(audits.at(-1)).toMatchObject({ method: 'CONNECT', status: 200, sessionId: A });
  });

  it("refuses session A's token opening a tunnel to host B (403), with no upstream connection", async () => {
    const up = await startHttpUpstream();
    const { port, audits } = await startListener([
      session(A, { allowlist: new Set(['a.test']) }),
      session(B, { allowlist: new Set(['b.test']), ...rawTunnel('b.test') }),
    ]);

    const c = await connectVia(port, rawConnect(`b.test:${up.port}`, tokenFor(A)));
    const body = c.head + (await drain(c.socket));

    expect(c.status).toBe(403);
    expect(body).toContain('b.test');
    expect(body).toContain("this session's allowlist");
    expect(up.connections()).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      method: 'CONNECT',
      status: 403,
      blocked: 'domain_denied: b.test',
      sessionId: A,
    });
  });

  it("refuses session B's token opening a tunnel to host A (the reverse direction)", async () => {
    const up = await startHttpUpstream();
    const { port, audits } = await startListener([
      session(A, { allowlist: new Set(['a.test']), ...rawTunnel('a.test') }),
      session(B, { allowlist: new Set(['b.test']) }),
    ]);

    const c = await connectVia(port, rawConnect(`a.test:${up.port}`, tokenFor(B)));
    await drain(c.socket);

    expect(c.status).toBe(403);
    expect(up.connections()).toBe(0);
    expect(audits[0]).toMatchObject({ status: 403, sessionId: B });
  });

  it('refuses a CONNECT with NO Proxy-Authorization (407 + Proxy-Authenticate), no DNS, no upstream', async () => {
    const up = await startHttpUpstream();
    let lookups = 0;
    const audits: ProxyAuditEntry[] = [];
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry: new SharedCredentialRegistry(),
      ca: mintCA('isolation-proxy-ca'),
      sessions: new Map([[A, session(A, { allowlist: new Set(['a.test']), ...rawTunnel('a.test') })]]),
      resolver: async () => {
        lookups++;
        return { address: '127.0.0.1', family: 4 };
      },
      onAudit: (e) => audits.push(e),
    });

    const c = await connectVia(listener.port, rawConnect(`a.test:${up.port}`));
    const text = c.head + (await drain(c.socket));

    expect(c.status).toBe(407);
    expect(text).toMatch(/Proxy-Authenticate: Basic realm="ax-egress"/i);
    expect(text).not.toContain('a.test');
    expect(lookups).toBe(0);
    expect(up.connections()).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ method: 'CONNECT', status: 407, blocked: 'proxy_auth_required' });
    expect(audits[0]?.sessionId).toBeUndefined();
  });

  it.each([
    ['an unknown but well-formed token', 'f'.repeat(32)],
    ['a too-short token', 'abc123'],
    ['an UPPERCASE-hex copy of a valid token', tokenFor(A).toUpperCase()],
  ])('refuses a CONNECT carrying %s (407)', async (_name, token) => {
    const up = await startHttpUpstream();
    const { port, audits } = await startListener([
      session(A, { allowlist: new Set(['a.test']), ...rawTunnel('a.test') }),
    ]);

    const c = await connectVia(port, rawConnect(`a.test:${up.port}`, token));
    await drain(c.socket);

    expect(c.status).toBe(407);
    expect(up.connections()).toBe(0);
    expect(audits[0]).toMatchObject({ status: 407, blocked: 'proxy_auth_required' });
    expect(audits[0]?.sessionId).toBeUndefined();
  });

  it('refuses a CONNECT to a malformed target only AFTER authenticating (unauthenticated callers learn nothing)', async () => {
    const { port } = await startListener([session(A, { allowlist: new Set(['a.test']) })]);
    const anon = await connectVia(port, rawConnect(':::', undefined));
    await drain(anon.socket);
    expect(anon.status).toBe(407); // not 400 — no oracle for unauthenticated probing
  });

  it("takes allowedIPs from the CALLER for CONNECT too (B stays SSRF-blocked even though A's override would permit)", async () => {
    const up = await startHttpUpstream();
    const { port, audits } = await startListener([
      session(A, { allowlist: new Set(['shared.test']), allowedIPs: new Set(['127.0.0.1']), ...rawTunnel('shared.test') }),
      strictSession(B, { allowlist: new Set(['shared.test']), ...rawTunnel('shared.test') }),
    ]);

    const c = await connectVia(port, rawConnect(`shared.test:${up.port}`, tokenFor(B)));
    await drain(c.socket);

    expect(c.status).toBe(403);
    expect(up.connections()).toBe(0);
    expect(audits.at(-1)).toMatchObject({ sessionId: B });
    expect(audits.at(-1)?.blocked).toMatch(/^Blocked:/);
  });

  it("scopes bypassMITM to the caller: A's cert-pinning bypass never switches off inspection of B's tunnel", async () => {
    const proxyCA = mintCA('isolation-proxy-ca');
    // A real TLS upstream whose leaf is signed by the proxy CA (so the proxy's own
    // upstream leg verifies when it MITMs). Its fingerprint is how the client can
    // tell "I reached the upstream through a raw tunnel" from "the proxy terminated
    // my TLS with a certificate it minted".
    // (Minted by hand, NOT via generateDomainCert: that caches one leaf per
    // domain+CA, so it would hand the proxy's MITM the very same certificate and
    // the two cases would be indistinguishable.)
    const upstreamLeaf = mintLeaf('shared.test', proxyCA);
    const upstreamFingerprint = new X509Certificate(upstreamLeaf.cert).fingerprint256;
    let upstreamConnections = 0;
    const upstream: TLSServer = tlsCreate({ key: upstreamLeaf.key, cert: upstreamLeaf.cert }, (sock) => {
      sock.on('error', () => undefined);
      sock.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    });
    upstream.on('connection', () => {
      upstreamConnections++;
    });
    const upPort = await new Promise<number>((r) =>
      upstream.listen(0, '127.0.0.1', () => r((upstream.address() as net.AddressInfo).port)),
    );
    closers.push(() => new Promise<void>((r) => upstream.close(() => r())));

    const { port } = await startListener(
      [
        // A declares the bypass; B allowlists the same host but declares no bypass.
        session(A, { allowlist: new Set(['shared.test']), bypassMITM: new Set(['shared.test']) }),
        session(B, { allowlist: new Set(['shared.test']) }),
      ],
      proxyCA,
    );

    async function peerFingerprint(token: string): Promise<string> {
      const c = await connectVia(port, rawConnect(`shared.test:${upPort}`, token));
      expect(c.status).toBe(200);
      // Both the upstream's leaf and the proxy's minted leaf chain to proxyCA and
      // carry a shared.test SAN, so the handshake verifies normally either way.
      const secured = tls.connect({
        socket: c.socket,
        servername: 'shared.test',
        ca: proxyCA.cert,
      });
      const fp = await new Promise<string>((resolve, reject) => {
        secured.once('secureConnect', () => resolve(secured.getPeerCertificate().fingerprint256));
        secured.once('error', reject);
      });
      secured.destroy();
      return fp;
    }

    // A (declared the bypass): raw tunnel — the client sees the UPSTREAM's own certificate.
    expect(await peerFingerprint(tokenFor(A))).toBe(upstreamFingerprint);
    // B (declared nothing): MITM'd — the client sees a certificate the proxy minted.
    expect(await peerFingerprint(tokenFor(B))).not.toBe(upstreamFingerprint);
    expect(upstreamConnections).toBeGreaterThanOrEqual(1);
  });
});
