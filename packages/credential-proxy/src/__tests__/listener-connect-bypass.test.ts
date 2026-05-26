import { describe, it, expect, afterEach } from 'vitest';
import { createServer as tlsCreate, connect as tlsConnect, type Server as TLSServer } from 'node:tls';
import * as net from 'node:net';
import {
  startProxyListener,
  type ProxyListener,
  type ProxyAuditEntry,
} from '../listener.js';
import { SharedCredentialRegistry } from '../registry.js';
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

/**
 * Mint a throwaway CA + leaf cert for the test TLS upstream. Self-contained:
 * we don't share the proxy's persistent CA because Task 7 doesn't do MITM —
 * the client connects with `rejectUnauthorized: false` and just verifies the
 * raw bytes flow through.
 */
function mintTestCert(commonName: string): { caKey: string; caCert: string; key: string; cert: string } {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date();
  caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 1);
  const caAttrs = [{ name: 'commonName', value: 'test-ca' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const ca: CAKeyPair = {
    key: forge.pki.privateKeyToPem(caKeys.privateKey),
    cert: forge.pki.certificateToPem(caCert),
  };
  const leaf = generateDomainCert(commonName, ca);
  return { caKey: ca.key, caCert: ca.cert, key: leaf.key, cert: leaf.cert };
}

/**
 * Send a CONNECT request through the proxy and resolve once the proxy returns
 * its status line. Returns the still-open TCP socket on 200; rejects on
 * non-200 with the raw status line.
 */
async function connectThroughProxy(
  proxyHost: string,
  proxyPort: number,
  target: string,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost, () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      sock.removeListener('data', onData);
      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('utf8');
      if (statusLine.includes(' 200 ')) {
        // If the upstream wrote anything before the client started reading,
        // it'll be in `buf` after the CRLFCRLF. Re-emit those bytes.
        const leftover = buf.slice(idx + 4);
        if (leftover.length > 0) sock.unshift(leftover);
        resolve(sock);
      } else {
        sock.destroy();
        reject(new Error(statusLine));
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

/**
 * Send a CONNECT through the proxy and resolve the FULL raw response the proxy
 * wrote back (status line + headers + body), reading until the socket closes.
 * Used to assert the actionable body the proxy writes on an allowlist-miss 403
 * — `connectThroughProxy` rejects with only the status line, so it can't see
 * the body.
 */
async function connectCaptureBlockedResponse(
  proxyHost: string,
  proxyPort: number,
  target: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost, () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let acc = '';
    sock.on('data', (chunk: Buffer) => {
      acc += chunk.toString('utf8');
    });
    sock.on('end', () => resolve(acc));
    sock.on('close', () => resolve(acc));
    sock.on('error', reject);
  });
}

describe('proxy listener — HTTPS CONNECT (bypass / raw tunnel)', () => {
  it('passes raw TLS bytes through when target is in bypassMITM', async () => {
    // 1. Stand up a TLS upstream that writes a known string after handshake.
    const { key, cert } = mintTestCert('localhost');
    upstream = tlsCreate({ key, cert }, (socket) => {
      socket.write('upstream-says-hello');
    });
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    // 2. Stand up the proxy with 127.0.0.1 in allowlist + bypassMITM.
    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: { key: 'unused-key', cert: 'unused-cert' }, // bypass path doesn't touch CA
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

    // 3. Issue CONNECT through the proxy, then upgrade the tunneled socket to TLS.
    const tunnel = await connectThroughProxy('127.0.0.1', listener.port, `127.0.0.1:${upPort}`);

    // The whole point of this test is the CONNECT bypass mode — the
    // upstream is a self-signed test server we've spawned in this very
    // test, and we want to read raw bytes through the proxy's tunnel,
    // not validate the (deliberately bogus) cert chain.
    const tlsSock = tlsConnect({ // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      socket: tunnel,
      rejectUnauthorized: false,
      servername: 'localhost',
    });

    const greeting = await new Promise<string>((resolve, reject) => {
      let acc = '';
      tlsSock.on('data', (d) => {
        acc += d.toString('utf8');
        if (acc.includes('upstream-says-hello')) resolve(acc);
      });
      tlsSock.on('error', reject);
      tlsSock.on('end', () => resolve(acc));
    });

    expect(greeting).toContain('upstream-says-hello');
    tlsSock.destroy();
  });

  it('returns 403 for CONNECT to a host not in any session allowlist', async () => {
    const { key, cert } = mintTestCert('localhost');
    upstream = tlsCreate({ key, cert }, (socket) => {
      socket.write('SHOULD NOT REACH');
    });
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: { key: 'unused-key', cert: 'unused-cert' }, // bypass path doesn't touch CA
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['other.example.com']),
            allowedIPs: new Set(['127.0.0.1']),
          },
        ],
      ]),
    });

    await expect(
      connectThroughProxy('127.0.0.1', listener.port, `127.0.0.1:${upPort}`),
    ).rejects.toThrow(/403/);
  });

  it('attributes a CONNECT allowlist-miss 403 to its session via the proxy token (TASK-52)', async () => {
    // The k8s-relevant path: HTTPS egress arrives as a CONNECT carrying
    // `Proxy-Authorization: Basic ax:<token>` (forwarded by the bridge). Even
    // though the host is allowlist-MISS (no allowing session), the listener
    // attributes the block to the session that owns the token.
    const { key, cert } = mintTestCert('localhost');
    upstream = tlsCreate({ key, cert }, (socket) => socket.write('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const token = 'a'.repeat(32);
    const audits: ProxyAuditEntry[] = [];
    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: { key: 'unused-key', cert: 'unused-cert' },
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['other.example.com']),
            allowedIPs: new Set(['127.0.0.1']),
            sessionId: 's1',
            userId: 'u1',
            proxyToken: token,
          },
        ],
      ]),
      onAudit: (e) => audits.push(e),
    });

    const authValue = 'Basic ' + Buffer.from('ax:' + token).toString('base64');
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(listener!.port, '127.0.0.1', () => {
        sock.write(
          `CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${upPort}\r\n` +
            `Proxy-Authorization: ${authValue}\r\n` +
            `\r\n`,
        );
      });
      // Drain the 403 response bytes; we assert via the audit, not the body.
      sock.on('data', () => {});
      sock.on('end', () => resolve());
      sock.on('close', () => resolve());
      sock.on('error', reject);
    });

    const block = audits.find((a) => a.blocked?.startsWith('domain_denied:'));
    expect(block).toBeDefined();
    expect(block!.sessionId).toBe('s1');
    expect(block!.userId).toBe('u1');
  });

  // TASK-25 — a binary-download CLI (e.g. one that fetches a prebuilt binary
  // from a GitHub release) hits the egress lock as an HTTPS CONNECT to a host
  // the skill never allowlisted. The proxy used to reply with a BARE
  // `403 Forbidden` and no body, so the failing tool surfaced an opaque denial
  // and neither the agent nor a human could tell what to do. The 403 must now
  // carry an actionable message: which host was denied, and how to fix it.
  it('CONNECT allowlist-miss 403 carries an actionable body naming the host + the fix', async () => {
    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: { key: 'unused-key', cert: 'unused-cert' }, // deny happens before any TLS/CA use
      sessions: new Map([
        [
          's1',
          {
            allowlist: new Set(['registry.npmjs.org']), // github.com is NOT allowlisted
            allowedIPs: new Set(['127.0.0.1']),
          },
        ],
      ]),
    });

    const response = await connectCaptureBlockedResponse(
      '127.0.0.1',
      listener.port,
      'github.com:443',
    );

    // Status line is still a 403.
    expect(response).toMatch(/^HTTP\/1\.1 403\b/);
    // Body names the denied host so the reader knows exactly what failed.
    expect(response).toContain('github.com');
    // Body is actionable: it points at the skill allowlist as the fix.
    expect(response.toLowerCase()).toContain('allowlist');
    // Body, not a header: the host string lands after the header terminator,
    // so a hostname can never forge a response header.
    const headerEnd = response.indexOf('\r\n\r\n');
    expect(headerEnd).toBeGreaterThan(-1);
    expect(response.slice(headerEnd + 4)).toContain('github.com');
    // A Content-Length is present so well-behaved clients render the body.
    expect(response.toLowerCase()).toMatch(/content-length:\s*\d+/);
  });

  it('returns 403 for CONNECT to a private IP without allowedIPs override', async () => {
    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      ca: { key: 'unused-key', cert: 'unused-cert' }, // bypass path doesn't touch CA
      sessions: new Map([
        // 127.0.0.1 is in allowlist (passes domain gate) but no allowedIPs
        // override, so resolveAndCheck throws BlockedIPError → 403.
        ['s1', { allowlist: new Set(['127.0.0.1']) }],
      ]),
    });

    await expect(
      connectThroughProxy('127.0.0.1', listener.port, '127.0.0.1:443'),
    ).rejects.toThrow(/403/);
  });
});
