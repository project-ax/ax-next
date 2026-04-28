import { describe, it, expect, afterEach } from 'vitest';
import { createServer as tlsCreate, connect as tlsConnect, type Server as TLSServer } from 'node:tls';
import * as net from 'node:net';
import { startProxyListener, type ProxyListener } from '../listener.js';
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
