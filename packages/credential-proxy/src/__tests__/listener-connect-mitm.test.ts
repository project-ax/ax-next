/**
 * MITM CONNECT path tests — Task 8.
 *
 * Three behaviors:
 *  (a) credential placeholders in client request bodies/headers are replaced
 *      with real values before the upstream sees them;
 *  (b) a canary token in the decrypted body trips a 403 and the upstream
 *      never receives the request;
 *  (c) hostnames in `bypassMITM` skip the MITM path entirely and fall through
 *      to Task 7's raw tunnel — the upstream sees the placeholder verbatim.
 *
 * The TLS upstream is signed by the SAME CA we hand the proxy. The proxy
 * extends its trust store with that CA (`tls.connect({ ca: [...rootCertificates,
 * options.ca.cert] })`) so the test upstream chains cleanly without
 * `rejectUnauthorized: false`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  createServer as tlsCreate,
  connect as tlsConnect,
  type Server as TLSServer,
  type TLSSocket,
} from 'node:tls';
import * as net from 'node:net';
import { ProxyAgent } from 'undici';
import { startProxyListener, type ProxyListener } from '../listener.js';
import {
  CredentialPlaceholderMap,
  SharedCredentialRegistry,
} from '../registry.js';
import { generateDomainCert, type CAKeyPair } from '../ca.js';
import forgeModule from 'node-forge';

const forge = forgeModule as typeof forgeModule;

let upstream: TLSServer | undefined;
let listener: ProxyListener | undefined;

afterEach(async () => {
  if (listener) listener.stop();
  if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  upstream = listener = undefined;
});

/** Mint a fresh CA for each test — keeps test isolation tidy. */
function mintCA(): CAKeyPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    { name: 'commonName', value: 'mitm-test-ca' },
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

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

/**
 * Stand up a TLS upstream that captures the first HTTP request line/headers/body
 * it sees. Resolves with `{ port, captured, gotRequest }` — `gotRequest` resolves
 * once a full request lands, so tests can `await` ordering.
 */
async function startCapturingUpstream(
  ca: CAKeyPair,
): Promise<{
  port: number;
  captured: CapturedRequest;
  gotRequest: Promise<void>;
}> {
  const leaf = generateDomainCert('127.0.0.1', ca);
  const captured: CapturedRequest = {
    method: undefined,
    url: undefined,
    authorization: undefined,
    body: '',
  };
  let resolveReq!: () => void;
  const gotRequest = new Promise<void>((resolve) => {
    resolveReq = resolve;
  });

  upstream = tlsCreate({ key: leaf.key, cert: leaf.cert }, (sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buf.slice(0, headerEnd);
      const lines = header.split('\r\n');
      const reqLine = lines[0]?.split(' ');
      captured.method = reqLine?.[0];
      captured.url = reqLine?.[1];
      let contentLength = 0;
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        if (k === 'authorization') captured.authorization = v;
        if (k === 'content-length') contentLength = parseInt(v, 10);
      }
      const bodyStart = headerEnd + 4;
      if (buf.length - bodyStart >= contentLength) {
        captured.body = buf.slice(bodyStart, bodyStart + contentLength);
        // Reply with a tiny 200 so the client doesn't hang.
        sock.write(
          'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK',
        );
        sock.end();
        resolveReq();
      }
    });
    // Swallow ECONNRESET — when the proxy aborts mid-stream (canary block,
    // client drop), the upstream's socket emits an unhandled 'error' that
    // would crash the test runner. We don't care about post-abort errors.
    sock.on('error', () => { /* ignored — abort-side errors are expected */ });
  });

  const port = await new Promise<number>((r) =>
    upstream!.listen(0, '127.0.0.1', () =>
      r((upstream!.address() as { port: number }).port),
    ),
  );
  return { port, captured, gotRequest };
}

/**
 * Stand up a TLS upstream that captures EVERY request's Authorization header on
 * a single keep-alive connection. Mirrors `startCapturingUpstream` but loops over
 * pipelined requests (git sends GET /info/refs then POST /git-upload-pack on one
 * tunnel) so we can assert the credential was substituted on BOTH heads.
 */
async function startMultiCapturingUpstream(
  ca: CAKeyPair,
  expectRequests: number,
): Promise<{
  port: number;
  authorizations: string[];
  gotAll: Promise<void>;
}> {
  const leaf = generateDomainCert('127.0.0.1', ca);
  const authorizations: string[] = [];
  let resolveAll!: () => void;
  const gotAll = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });

  upstream = tlsCreate({ key: leaf.key, cert: leaf.cert }, (sock) => {
    let buf = '';
    const drain = () => {
      // Pull as many complete requests out of `buf` as are present.
      for (;;) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = buf.slice(0, headerEnd);
        const lines = header.split('\r\n');
        let contentLength = 0;
        let authorization: string | undefined;
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          const k = line.slice(0, idx).trim().toLowerCase();
          const v = line.slice(idx + 1).trim();
          if (k === 'authorization') authorization = v;
          if (k === 'content-length') contentLength = parseInt(v, 10);
        }
        const bodyStart = headerEnd + 4;
        if (buf.length - bodyStart < contentLength) return; // body still arriving
        authorizations.push(authorization ?? '');
        buf = buf.slice(bodyStart + contentLength);
        // Reply per request so a real HTTP client would advance; the raw test
        // client ignores these, but harmless.
        sock.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
        if (authorizations.length >= expectRequests) {
          resolveAll();
        }
      }
    };
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      drain();
    });
    sock.on('error', () => { /* ignored — abort-side errors are expected */ });
  });

  const port = await new Promise<number>((r) =>
    upstream!.listen(0, '127.0.0.1', () =>
      r((upstream!.address() as { port: number }).port),
    ),
  );
  return { port, authorizations, gotAll };
}

/**
 * Open a raw MITM tunnel to the proxy and hand back the inner TLS socket so a
 * test can write hand-crafted HTTP/1.1 request heads (git-clone shape) over it.
 * Reuses the proxy's listening port + the test CA the proxy mints leaf certs
 * from. Resolves once the inner TLS handshake (to our minted leaf) completes.
 */
async function openMitmTunnel(
  proxyPort: number,
  upstreamHost: string,
  upstreamPort: number,
  ca: CAKeyPair,
): Promise<TLSSocket> {
  const raw = net.connect(proxyPort, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    raw.once('error', reject);
    raw.once('connect', () => resolve());
  });
  // CONNECT, wait for "200 Connection Established".
  raw.write(`CONNECT ${upstreamHost}:${upstreamPort} HTTP/1.1\r\nHost: ${upstreamHost}:${upstreamPort}\r\n\r\n`);
  await new Promise<void>((resolve, reject) => {
    const onData = (d: Buffer) => {
      if (d.toString('latin1').includes('200')) {
        raw.removeListener('data', onData);
        resolve();
      }
    };
    raw.on('data', onData);
    raw.once('error', reject);
  });
  // Wrap the tunnel in TLS; trust the test CA (the proxy mints a leaf from it).
  // `servername` doubles as the cert-validation hostname for a socket-wrapped
  // connection; the proxy's minted leaf has CN `127.0.0.1`, so it must match.
  // (Node logs an RFC-6066 SNI-for-IP deprecation notice; harmless in tests.)
  const inner = tlsConnect({ socket: raw, servername: upstreamHost, ca: ca.cert });
  inner.on('error', () => { /* abort-side errors during teardown are expected */ });
  await new Promise<void>((resolve, reject) => {
    inner.once('secureConnect', () => resolve());
    inner.once('error', reject);
  });
  return inner;
}

describe('proxy listener — HTTPS CONNECT (MITM)', () => {
  it('substitutes credential placeholders with real values before reaching upstream', async () => {
    const ca = mintCA();
    const upInfo = await startCapturingUpstream(ca);

    // Register a credential, get its placeholder.
    const credMap = new CredentialPlaceholderMap();
    const placeholder = credMap.register('ANTHROPIC_API_KEY', 'sk-real-secret-xyz');

    const registry = new SharedCredentialRegistry();
    registry.register('s1', credMap);

    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca,
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['127.0.0.1']),
            allowedIPs: new Set(['127.0.0.1']),
            // No bypassMITM → MITM path.
          },
        ],
      ]),
    });

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      requestTls: { ca: ca.cert },
    });

    // POST with the placeholder in the Authorization header.
    const res = await fetch(`https://127.0.0.1:${upInfo.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${placeholder}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
      dispatcher,
    } as RequestInit);
    expect(res.status).toBe(200);

    await upInfo.gotRequest;
    expect(upInfo.captured.method).toBe('POST');
    expect(upInfo.captured.url).toBe('/v1/messages');
    // The upstream MUST see the substituted real value, not the placeholder.
    expect(upInfo.captured.authorization).toBe('Bearer sk-real-secret-xyz');
    expect(upInfo.captured.authorization).not.toContain('ax-cred:');
  });

  it('blocks request with 403 and never forwards to upstream when canary token present', async () => {
    const ca = mintCA();
    const upInfo = await startCapturingUpstream(ca);
    // If the upstream sees this request, the test fails — capture & flip a flag.
    let upstreamSawRequest = false;
    upInfo.gotRequest.then(() => {
      upstreamSawRequest = true;
    });

    const canary = 'CANARY_TOKEN_XYZ_123';
    const registry = new SharedCredentialRegistry();

    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca,
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['127.0.0.1']),
            allowedIPs: new Set(['127.0.0.1']),
            canaryToken: canary,
          },
        ],
      ]),
    });

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      requestTls: { ca: ca.cert },
    });

    // POST with canary in body.
    let caught: Error | undefined;
    try {
      await fetch(`https://127.0.0.1:${upInfo.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: `payload containing ${canary} please leak`,
        dispatcher,
      } as RequestInit);
    } catch (err) {
      caught = err as Error;
    }

    // Either fetch rejects (most undici versions do — TLS write after end)
    // or it returns the 403 the proxy wrote into the TLS channel. Both are
    // acceptable signals that the proxy aborted the tunnel. The non-negotiable
    // invariant is that the upstream never saw the body.
    if (!caught) {
      // Tiny grace window for an in-flight upstream write — but if the proxy
      // worked, none is coming. Don't sleep more than necessary.
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(upstreamSawRequest).toBe(false);
  });

  it('bypasses MITM and passes raw bytes through when host is in bypassMITM', async () => {
    const ca = mintCA();
    // For the bypass test, the upstream cert isn't validated by the client
    // (we'll use rejectUnauthorized: false), so we can sign with the same CA
    // for convenience. The point of this test is that the proxy doesn't
    // touch bytes — so the placeholder stays raw in the Authorization header.
    const upInfo = await startCapturingUpstream(ca);

    const credMap = new CredentialPlaceholderMap();
    const placeholder = credMap.register('ANTHROPIC_API_KEY', 'sk-real-secret-xyz');
    const registry = new SharedCredentialRegistry();
    registry.register('s1', credMap);

    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca,
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['127.0.0.1']),
            allowedIPs: new Set(['127.0.0.1']),
            bypassMITM: new Set(['127.0.0.1']),
          },
        ],
      ]),
    });

    // We hand the client the same CA. Because bypass = raw tunnel, the
    // upstream cert chain (signed by `ca`) reaches the client unchanged
    // and validates against `ca.cert` in the trust store.
    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      requestTls: { ca: ca.cert },
    });

    const res = await fetch(`https://127.0.0.1:${upInfo.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${placeholder}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
      dispatcher,
    } as RequestInit);
    expect(res.status).toBe(200);

    await upInfo.gotRequest;
    // Bypass path means NO substitution: the upstream sees the placeholder.
    expect(upInfo.captured.authorization).toBe(`Bearer ${placeholder}`);
    expect(upInfo.captured.authorization).toContain('ax-cred:');
  });

  it('git-clone-shaped GET+POST: upstream sees the real credential in the Basic header (B)', async () => {
    const ca = mintCA();
    const upInfo = await startMultiCapturingUpstream(ca, 2);

    // Resolve a placeholder for a git token, mirroring how a session would carry it.
    const credMap = new CredentialPlaceholderMap();
    const placeholder = credMap.register('GITLAB_TOKEN', 'glpat-REALSECRET');
    const registry = new SharedCredentialRegistry();
    registry.register('s1', credMap);

    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca,
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['127.0.0.1']),
            allowedIPs: new Set(['127.0.0.1']),
            // No bypassMITM → MITM path.
          },
        ],
      ]),
    });

    const inner = await openMitmTunnel(listener.port, '127.0.0.1', upInfo.port, ca);

    // git uses Basic auth with the credential as the password (oauth2:<token>).
    const basic = Buffer.from(`oauth2:${placeholder}`).toString('base64');
    const get =
      `GET /info/refs?service=git-upload-pack HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${upInfo.port}\r\n` +
      `Authorization: Basic ${basic}\r\n\r\n`;
    const body = '0011want abcd\n0000';
    const post =
      `POST /git-upload-pack HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${upInfo.port}\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Authorization: Basic ${basic}\r\n\r\n` +
      body;

    // Same keep-alive tunnel: the GET (bodyless → re-arm) then the POST.
    inner.write(get);
    inner.write(post);

    await upInfo.gotAll;
    inner.destroy();

    // Both heads must decode to the REAL credential (placeholder substituted
    // inside the base64 Basic blob), not the ax-cred placeholder.
    expect(upInfo.authorizations).toHaveLength(2);
    for (const auth of upInfo.authorizations) {
      const m = auth.match(/^Basic (\S+)$/);
      expect(m).not.toBeNull();
      const decoded = Buffer.from(m![1]!, 'base64').toString('utf8');
      expect(decoded).toBe('oauth2:glpat-REALSECRET');
      expect(decoded).not.toContain('ax-cred:');
    }
  });

  it('blocks a canary token hidden inside a Basic blob (B canary parity)', async () => {
    const ca = mintCA();
    const upInfo = await startMultiCapturingUpstream(ca, 1);
    let upstreamSawRequest = false;
    upInfo.gotAll.then(() => {
      upstreamSawRequest = true;
    });

    const canary = 'CANARY_TOKEN_XYZ_123';
    const registry = new SharedCredentialRegistry();

    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca,
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['127.0.0.1']),
            allowedIPs: new Set(['127.0.0.1']),
            canaryToken: canary,
          },
        ],
      ]),
    });

    const inner = await openMitmTunnel(listener.port, '127.0.0.1', upInfo.port, ca);

    // The canary is base64-buried in a Basic blob — a raw `chunk.includes`
    // scan would be blinded; the framer must decode → scan → block.
    const basic = Buffer.from(`oauth2:${canary}`).toString('base64');
    const get =
      `GET /info/refs HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${upInfo.port}\r\n` +
      `Authorization: Basic ${basic}\r\n\r\n`;

    // Expect the proxy to reply 403 over the TLS channel and tear down.
    let sawForbidden = false;
    inner.on('data', (d: Buffer) => {
      if (d.toString('latin1').includes('403')) sawForbidden = true;
    });
    inner.write(get);

    // Give the proxy a moment to respond + the (would-be) upstream to (not) see it.
    await new Promise((r) => setTimeout(r, 100));
    inner.destroy();

    expect(upstreamSawRequest).toBe(false);
    expect(sawForbidden).toBe(true);
  });
});
