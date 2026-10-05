/**
 * TASK-715 — the operator's model-provider key is METERED and GATED at the proxy.
 *
 * The runner's own model calls and a `curl` in the sandbox are the same thing at
 * the proxy: same session token, same placeholder, same host. Before this card
 * nothing counted either. These tests drive the REAL listener over real sockets
 * against real TLS upstreams (see listener-credential-binding.test.ts for the
 * harness idea) with a scripted `ProviderMeter` on the session, and assert on the
 * bytes the upstream actually received and the bytes the client actually got.
 *
 * The first describe block is the measurement the card asked for, kept as a
 * regression test: it fails on the pre-TASK-715 listener, where a raw tunnel
 * carrying the placeholder reached the provider with the real key, unmetered, and
 * where bytes written after the CONNECT reached it around the framer entirely.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  createServer as tlsCreate,
  connect as tlsConnect,
  TLSSocket as TLSSocketClass,
  type TLSSocket,
} from 'node:tls';
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
import type { ProviderAdmit, ProviderCallSettlement, ProviderMeter } from '../provider-usage.js';
import { basicAuth, rawConnect, tokenFor } from './proxy-auth-helpers.js';

const forge = forgeModule as typeof forgeModule;

const PROVIDER = 'api.provider.test';
const OTHER = 'other.test';
const REAL = 'sk-ant-REAL-operator-key-0123456789';
const INFERENCE = [
  'POST /v1/messages',
  'POST /v1/messages/count_tokens',
  'GET /v1/models',
  'GET /v1/models/*',
];

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
    { name: 'commonName', value: 'metering-test-ca' },
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

const loopbackResolver = async (): Promise<{ address: string; family: number }> => ({
  address: '127.0.0.1',
  family: 4,
});

interface UpstreamRequest {
  requestLine: string;
  headers: Record<string, string>;
  /** The request's exact bytes (head + body), latin1-decoded. */
  raw: string;
}

/** What the scripted upstream does with request number `n` (1-based). */
type Reply = string | Buffer | 'hangup' | 'silence';

interface Upstream {
  port: number;
  requests: UpstreamRequest[];
  /** EVERY byte this upstream received on any connection. */
  received: () => string;
  /** Hang up every open connection (a dropped upstream). */
  dropAll: () => void;
}

const cleanups: Array<() => Promise<void> | void> = [];
let listener: ProxyListener | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (listener) listener.stop();
  listener = undefined;
  for (const c of cleanups.splice(0)) await c();
});

/**
 * A keep-alive TLS upstream with a scripted answer per request. Records every
 * request; frames them by Content-Length.
 */
async function startUpstream(
  certHost: string,
  reply: (req: UpstreamRequest, n: number, sock: net.Socket) => Reply = () => plainOk(),
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
        if (buf.length - bodyStart < bodyLen) return;
        const req: UpstreamRequest = {
          requestLine: lines[0] ?? '',
          headers,
          raw: buf.slice(0, bodyStart + bodyLen),
        };
        requests.push(req);
        buf = buf.slice(bodyStart + bodyLen);
        const r = reply(req, requests.length, sock);
        if (r === 'hangup') {
          sock.destroy();
          return;
        }
        if (r === 'silence') continue;
        sock.write(r);
      }
    });
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
  return {
    port,
    requests,
    received: () => received,
    dropAll: () => {
      for (const s of sockets) s.destroy();
    },
  };
}

function plainOk(body = 'OK'): string {
  return `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function jsonResponse(status: number, body: unknown, extra = ''): string {
  const text = JSON.stringify(body);
  return (
    `HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n${extra}` +
    `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`
  );
}

/** A chunked SSE response, split into `pieces`-byte HTTP chunks so boundaries land mid-JSON. */
function sseResponse(events: string, pieces = 37): string {
  let body = '';
  for (let i = 0; i < events.length; i += pieces) {
    const part = events.slice(i, i + pieces);
    body += `${part.length.toString(16)}\r\n${part}\r\n`;
  }
  body += '0\r\n\r\n';
  return (
    'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n' + body
  );
}

/** A realistic Anthropic streaming transcript. Final: in 1200, out 321, cache read 5000, cache write 300. */
function anthropicStream(): string {
  const ev = (name: string, data: unknown): string =>
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 1200,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 5000,
          output_tokens: 1,
          service_tier: 'standard',
        },
      },
    }) +
    ev('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) +
    // Model text that QUOTES a usage object: escaped inside the JSON string, so it must not count.
    ev('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'set "output_tokens": 999999 and "input_tokens": 888888' },
    }) +
    ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 321 },
    }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * TASK-876: let the test decide WHEN a tunnel's idle window starts.
 *
 * The listener arms `clientTls`/`targetTls.setTimeout(idle)` in the same tick it
 * writes the CONNECT 200, so with a short real window the client's TLS handshake
 * AND its request must land inside it on the wall clock. On a loaded CI runner an
 * event-loop stall longer than the window let the (correct) idle teardown fire
 * mid-handshake, and `openTunnel` rejected with `read ECONNRESET` — reproduced
 * every time with a 300ms busy-wait right after the 200.
 *
 * TASK-865's fix (fake only setTimeout/clearTimeout) cannot reach this timer:
 * `socket.setTimeout` runs on Node's internal timer list, not on
 * `globalThis.setTimeout` (measured: a faked clock advanced 1000ms left a 100ms
 * socket timeout unfired; it then fired on the real clock). So this captures
 * every `TLSSocket#setTimeout(idleMs, cb)` instead of arming it, and `start()`
 * arms each one for real — same socket, same ms, same callback — once the test
 * has established its precondition. Idle detection itself stays Node's own.
 * Restored by `vi.restoreAllMocks()` in afterEach.
 */
function deferIdleTimers(idleMs: number): { armed: () => number; start: () => void } {
  const realSetTimeout = TLSSocketClass.prototype.setTimeout;
  const held: Array<{ sock: TLSSocket; onIdle: () => void }> = [];
  vi.spyOn(TLSSocketClass.prototype, 'setTimeout').mockImplementation(function (
    this: TLSSocket,
    ms: number,
    onIdle?: () => void,
  ) {
    if (ms === idleMs && onIdle !== undefined) {
      held.push({ sock: this, onIdle });
      return this;
    }
    return realSetTimeout.call(this, ms, onIdle);
  });
  return {
    armed: () => held.length,
    start: () => {
      for (const { sock, onIdle } of held.splice(0)) realSetTimeout.call(sock, idleMs, onIdle);
    },
  };
}

/** The idle window the idle-teardown tests use (armed by `deferIdleTimers`, not at CONNECT). */
const IDLE_MS = 200;

function session(label: string, allowlist: string[], meter?: ProviderMeter): SessionConfig {
  return {
    allowlist: new Set(allowlist),
    allowedIPs: new Set(['127.0.0.1']),
    sessionId: label,
    userId: `user-of-${label}`,
    classification: 'llm',
    proxyToken: tokenFor(label),
    ...(meter !== undefined ? { providerMeter: meter } : {}),
  };
}

/** A scripted meter. Counts admits and settles so a leaked or double-settled slot shows up. */
function fakeMeter(opts: { hosts?: string[]; requests?: string[] } = {}) {
  const settled: ProviderCallSettlement[] = [];
  let admits = 0;
  let refusal: ProviderAdmit | undefined;
  const meter: ProviderMeter = {
    hosts: new Set(opts.hosts ?? [PROVIDER]),
    requests: opts.requests ?? INFERENCE,
    admit: () => {
      if (refusal !== undefined) return refusal;
      admits++;
      return { ok: true };
    },
    settle: (s) => {
      settled.push(s);
    },
  };
  return {
    meter,
    settled,
    admits: () => admits,
    /** Slots still held: every `ok` admit must be settled exactly once. */
    open: () => admits - settled.length,
    refuseWith: (r: ProviderAdmit) => {
      refusal = r;
    },
    allow: () => {
      refusal = undefined;
    },
  };
}

function registerSession(
  registry: SharedCredentialRegistry,
  label: string,
  hosts: string[] = [PROVIDER],
): string {
  const map = new CredentialPlaceholderMap();
  const ph = map.register('ANTHROPIC_API_KEY', REAL, hosts);
  registry.register(label, map);
  return ph;
}

async function start(
  registry: SharedCredentialRegistry,
  sessions: SessionConfig[],
  extra: { meteredTunnelIdleMs?: number } = {},
): Promise<{ audits: ProxyAuditEntry[]; port: number }> {
  const audits: ProxyAuditEntry[] = [];
  listener = await startProxyListener({
    ...extra,
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    registry,
    ca,
    sessions: new Map(sessions.map((s) => [s.sessionId as string, s])),
    resolver: loopbackResolver,
    onAudit: (e) => audits.push(e),
  });
  return { audits, port: listener.port };
}

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
  // Destroying a TLS socket that wraps another does not close the wrapped one, so a
  // test's "client hangs up" would never reach the proxy. A real client's close does.
  inner.on('close', () => raw.destroy());
  await new Promise<void>((resolve, reject) => {
    inner.once('secureConnect', () => resolve());
    inner.once('error', reject);
  });
  return inner;
}

/** Everything the client receives on `inner`, so far. */
function collect(inner: TLSSocket): () => string {
  let acc = '';
  inner.on('data', (d: Buffer) => {
    acc += d.toString('latin1');
  });
  return () => acc;
}

function send(
  inner: TLSSocket,
  opts: {
    host?: string;
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): void {
  const body = opts.body ?? '';
  const method = opts.method ?? 'POST';
  const head = [
    `${method} ${opts.path ?? '/v1/messages'} HTTP/1.1`,
    `Host: ${opts.host ?? PROVIDER}`,
    ...Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    ...(method === 'GET' ? [] : [`Content-Length: ${Buffer.byteLength(body)}`]),
  ].join('\r\n');
  inner.write(`${head}\r\n\r\n${body}`);
}

const MODEL_BODY = JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [] });

// ─────────────────────────────────────────────────────────────────────

describe('THE MEASUREMENT: a sandbox request carrying the placeholder spends the key (TASK-715)', () => {
  it('25 direct calls down one keep-alive tunnel reach the provider with the REAL key, and every one is counted', async () => {
    const provider = await startUpstream(PROVIDER, () => sseResponse(anthropicStream()));
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);

    // The "sandbox curl": the same session token and placeholder the runner has.
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    for (let i = 0; i < 25; i++) {
      send(inner, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
      await waitFor(() => m.settled.length >= i + 1, `call ${i + 1} to be counted`);
    }

    expect(provider.requests).toHaveLength(25);
    expect(provider.requests.every((r) => r.headers['x-api-key'] === REAL)).toBe(true);
    // Before this card: nothing was counted. Now every call is, from the response.
    expect(m.settled).toHaveLength(25);
    expect(m.settled[0]).toEqual({
      billable: true,
      model: 'claude-sonnet-4-5',
      usage: { inputTokens: 1200, outputTokens: 321, cacheReadTokens: 5000, cacheWriteTokens: 300 },
      requestBytes: Buffer.byteLength(MODEL_BODY),
    });
    expect(m.open()).toBe(0);
    // The client still received every response byte (the tap is passive).
    expect(got().split('HTTP/1.1 200 OK').length - 1).toBe(25);
    inner.destroy();
  });

  it('a request sent in the SAME segment as the CONNECT is refused; it never reaches the provider with the key', async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { audits, port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);

    const raw = net.connect(port, '127.0.0.1');
    cleanups.push(() => {
      raw.destroy();
    });
    await new Promise<void>((r) => raw.once('connect', () => r()));
    let reply = '';
    raw.on('data', (d: Buffer) => {
      reply += d.toString('latin1');
    });
    raw.write(
      rawConnect(`${PROVIDER}:${provider.port}`, tokenFor('s1')) +
        `POST /v1/messages HTTP/1.1\r\nHost: ${PROVIDER}\r\nx-api-key: ${ph}\r\nContent-Length: 2\r\n\r\n{}`,
    );
    await waitFor(() => reply.includes('\r\n\r\n'), 'the refusal');

    expect(reply.startsWith('HTTP/1.1 400')).toBe(true);
    expect(reply).not.toContain('200 Connection Established');
    await new Promise((r) => setTimeout(r, 150));
    expect(provider.requests).toHaveLength(0);
    expect(provider.received()).not.toContain(REAL);
    expect(m.admits()).toBe(0);
    expect(audits.some((a) => a.blocked === 'unexpected_bytes_after_connect')).toBe(true);
  });

  it('the same-segment refusal applies to EVERY MITM tunnel, not just metered hosts', async () => {
    const other = await startUpstream(OTHER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1', [OTHER]); // a connector-style credential
    const { port } = await start(registry, [session('s1', [OTHER])]);

    const raw = net.connect(port, '127.0.0.1');
    cleanups.push(() => {
      raw.destroy();
    });
    await new Promise<void>((r) => raw.once('connect', () => r()));
    raw.write(
      rawConnect(`${OTHER}:${other.port}`, tokenFor('s1')) +
        `GET / HTTP/1.1\r\nHost: ${OTHER}\r\nx-api-key: ${ph}\r\n\r\n`,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(other.requests).toHaveLength(0);
    expect(other.received()).not.toContain(REAL);
  });
});

describe('the gate: a refused request never carries the key', () => {
  it('answers a JSON 429 in the provider error shape, forwards nothing, and closes the tunnel', async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    m.refuseWith({ ok: false, reason: 'usage-limit-daily', message: 'Daily model limit reached.' });
    const { audits, port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);

    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    let closed = false;
    inner.on('close', () => {
      closed = true;
    });
    send(inner, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
    await waitFor(() => closed, 'the tunnel to close');

    const reply = got();
    expect(reply.startsWith('HTTP/1.1 429')).toBe(true);
    expect(reply).toContain('Retry-After: 5');
    const body = JSON.parse(reply.slice(reply.indexOf('\r\n\r\n') + 4)) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(body).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Daily model limit reached.' },
    });
    expect(provider.requests).toHaveLength(0);
    expect(provider.received()).toBe('');
    expect(m.settled).toHaveLength(0);
    expect(audits.find((a) => a.blocked === 'provider_call_refused: usage-limit-daily')?.status).toBe(429);
    // …and the close did not ALSO log a 200 for the same tunnel.
    await new Promise((r) => setTimeout(r, 100));
    expect(audits.filter((a) => a.method === 'CONNECT' && a.status === 200)).toHaveLength(0);
  });

  it('is per request: once the meter allows again, a fresh tunnel is served normally', async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);

    m.refuseWith({ ok: false, reason: 'busy', message: 'Too many at once.' });
    const blocked = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    collect(blocked);
    send(blocked, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
    await waitFor(() => blocked.destroyed, 'the refused tunnel to close');
    expect(provider.requests).toHaveLength(0);

    m.allow();
    const ok = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(ok);
    send(ok, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
    await waitFor(() => got().includes('OK'), 'the served response');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.headers['x-api-key']).toBe(REAL);
    ok.destroy();
  });

  it('on a keep-alive tunnel, requests before the refusal are served and the refused one is not', async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);

    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    send(inner, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
    await waitFor(() => got().includes('OK'), 'the first response');
    m.refuseWith({ ok: false, reason: 'usage-suspended', message: 'Paused.' });
    send(inner, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
    await waitFor(() => got().includes('429'), 'the refusal');

    expect(provider.requests).toHaveLength(1);
    expect(m.open()).toBe(0);
  });
});

describe('the endpoint allowlist: the key is spliced into model calls and nothing else', () => {
  async function runAndReadUpstream(
    reqs: Array<{ method?: string; path: string; body?: string }>,
  ): Promise<{ provider: Upstream; m: ReturnType<typeof fakeMeter>; ph: string }> {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    for (const [i, r] of reqs.entries()) {
      send(inner, {
        headers: { 'x-api-key': ph },
        ...(r.method !== undefined ? { method: r.method } : {}),
        path: r.path,
        body: r.body ?? '{}',
      });
      await waitFor(() => (got().match(/HTTP\/1\.1 200/g) ?? []).length >= i + 1, `response ${i + 1}`);
    }
    inner.destroy();
    return { provider, m, ph };
  }

  it.each([
    'POST /v1/messages/batches',
    'GET /v1/messages/batches',
    'POST /v1/files',
    'GET /v1/files',
    'POST /v1/agents',
    'POST /v1/sessions',
    'POST /v1/skills',
    'GET /v1/organizations/me',
    'POST /v1/complete',
    'POST /v1/messages/count_tokens/x',
  ])('%s is forwarded with the placeholder INERT, and is neither gated nor counted', async (line) => {
    const [method, path] = line.split(' ') as [string, string];
    const { provider, m, ph } = await runAndReadUpstream([{ method, path }]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.headers['x-api-key']).toBe(ph);
    expect(provider.received()).not.toContain(REAL);
    expect(m.admits()).toBe(0);
    expect(m.settled).toHaveLength(0);
  });

  it.each([
    '/v1/messages/../messages/batches',
    '/v1/messages/',
    '//v1/messages',
    '/v1/messages;x=1',
    '/v1/Messages',
    '/v1/messages%2Fbatches',
    '/v1/models/%2e%2e%2fmessages',
    '/v1/models/a/b',
    '/v1/models/',
    '/v1/models/..',
  ])('a path that only LOOKS like a model call (%s) gets no key', async (path) => {
    const method = path.startsWith('/v1/models') ? 'GET' : 'POST';
    const { provider } = await runAndReadUpstream([{ method, path }]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.received()).not.toContain(REAL);
  });

  it('a request with an obsolete folded header is never spliced (it cannot be forced to an unencoded response)', async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    // The fold hides the client's Accept-Encoding from a rewrite that must not guess.
    inner.write(
      `POST /v1/messages HTTP/1.1\r\nHost: ${PROVIDER}\r\nx-api-key: ${ph}\r\n` +
        `Accept-Encoding: gzip,\r\n br\r\nContent-Length: 2\r\n\r\n{}`,
    );
    await waitFor(() => got().includes('OK'), 'response');
    expect(provider.received()).not.toContain(REAL);
    expect(provider.requests[0]!.headers['x-api-key']).toBe(ph);
    expect(m.admits()).toBe(0);
    inner.destroy();
  });

  it('an absolute-form request target is never spliced', async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    send(inner, { path: `https://${PROVIDER}/v1/messages`, headers: { 'x-api-key': ph }, body: '{}' });
    await waitFor(() => got().includes('OK'), 'response');
    expect(provider.received()).not.toContain(REAL);
    expect(m.admits()).toBe(0);
    inner.destroy();
  });

  it.each([
    ['POST', '/v1/messages'],
    ['POST', '/v1/messages?beta=true'],
    ['POST', '/v1/messages/count_tokens'],
    ['GET', '/v1/models'],
    ['GET', '/v1/models/claude-sonnet-4-5'],
  ])('%s %s IS spliced, gated and settled', async (method, path) => {
    const { provider, m } = await runAndReadUpstream([{ method, path }]);
    expect(provider.requests[0]!.headers['x-api-key']).toBe(REAL);
    expect(m.admits()).toBe(1);
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(m.open()).toBe(0);
  });

  it('a non-allowed request in the middle of a keep-alive run does not shift which response settles which request', async () => {
    const replies: Record<string, string> = {
      '/v1/messages': jsonResponse(200, {
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
      '/v1/files': jsonResponse(200, { usage: { input_tokens: 777, output_tokens: 777 } }),
    };
    const provider = await startUpstream(PROVIDER, (req) => replies[req.requestLine.split(' ')[1]!] ?? plainOk());
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    for (const [i, path] of ['/v1/messages', '/v1/files', '/v1/messages'].entries()) {
      send(inner, { path, headers: { 'x-api-key': ph }, body: '{}' });
      await waitFor(() => (got().match(/HTTP\/1\.1 200/g) ?? []).length >= i + 1, `response ${i + 1}`);
    }
    await waitFor(() => m.settled.length === 2, 'both metered calls settled');
    // The /v1/files answer (777s) is never charged to anything.
    expect(m.settled.map((s) => s.usage?.inputTokens)).toEqual([10, 10]);
    inner.destroy();
  });
});

describe('what a settled call is worth', () => {
  async function one(
    reply: string | Buffer | 'hangup' | 'silence',
    opts: { path?: string; method?: string; body?: string } = {},
  ): Promise<{ m: ReturnType<typeof fakeMeter>; provider: Upstream; inner: TLSSocket }> {
    const provider = await startUpstream(PROVIDER, () => reply);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    send(inner, {
      headers: { 'x-api-key': ph },
      ...(opts.path !== undefined ? { path: opts.path } : {}),
      ...(opts.method !== undefined ? { method: opts.method } : {}),
      body: opts.body ?? MODEL_BODY,
    });
    return { m, provider, inner };
  }

  it('a plain JSON response (Content-Length) is read', async () => {
    const { m, inner } = await one(
      jsonResponse(200, {
        model: 'claude-opus-4-1',
        usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      }),
    );
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(m.settled[0]).toMatchObject({
      billable: true,
      model: 'claude-opus-4-1',
      usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 3, cacheWriteTokens: 4 },
    });
    inner.destroy();
  });

  it('an OpenAI-compatible stream with usage only in the last chunk is read', async () => {
    const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
    const events =
      chunk({ id: 'c1', model: 'anthropic/claude-3.5-sonnet', choices: [{ delta: { content: 'hi' } }] }) +
      chunk({
        id: 'c1',
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
        },
      }) +
      'data: [DONE]\n\n';
    const { m, inner } = await one(sseResponse(events), { path: '/v1/messages' });
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(m.settled[0]!.usage).toEqual({
      inputTokens: 500, // prompt 1000 minus cached 400 minus cache-write 100
      outputTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    });
    inner.destroy();
  });

  it.each([
    [429, 'rate limited'],
    [401, 'bad key'],
    [400, 'bad request'],
    [500, 'oops'],
    [529, 'overloaded'],
  ])('a %i answer costs nothing (%s)', async (status) => {
    const { m, inner } = await one(jsonResponse(status, { type: 'error', error: { type: 'x', message: 'y' } }));
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(m.settled[0]).toMatchObject({ billable: false });
    inner.destroy();
  });

  it('token counting costs nothing even though it returns an input_tokens figure', async () => {
    const { m, inner } = await one(jsonResponse(200, { input_tokens: 190_000 }), {
      path: '/v1/messages/count_tokens',
    });
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(m.settled[0]).toMatchObject({ billable: false });
    inner.destroy();
  });

  it('a 200 with no readable usage is billable with usage null, so the meter estimates from the request size', async () => {
    const { m, inner } = await one(jsonResponse(200, { id: 'x', content: [] }));
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(m.settled[0]).toEqual({
      billable: true,
      usage: null,
      requestBytes: Buffer.byteLength(MODEL_BODY),
      // …and floors the output at what arrived (see the two COMPLETE-but-unreadable tests below).
      partial: { bytes: Buffer.byteLength(JSON.stringify({ id: 'x', content: [] })), streamed: false },
    });
    inner.destroy();
  });

  it('a response the upstream encoded anyway is billable with usage null (never scanned, never free)', async () => {
    const body = 'not-really-gzip';
    const { m, inner } = await one(
      `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(m.settled[0]).toMatchObject({ billable: true, usage: null });
    inner.destroy();
  });

  it('a COMPLETE response the meter could not read is still charged for the bytes that arrived, not a flat guess', async () => {
    // Encoded despite the request for identity (or in a shape no counter matches): the response is
    // complete, so `usage` is null and there is no early ending to trigger the floor. The body
    // size is the only evidence of how much was generated, and it must be used.
    const body = 'z'.repeat(300_000);
    const { m, inner } = await one(
      `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(m.settled[0]).toMatchObject({ billable: true, usage: null });
    // Compressed bytes stand for roughly 4x as many raw ones.
    expect(m.settled[0]!.partial).toEqual({ bytes: 1_200_000, streamed: false });
    inner.destroy();
  });

  it('a complete plain response with no counters is floored by its size too (an unknown wire format is not free)', async () => {
    const payload = { id: 'x', content: 'y'.repeat(9_000) };
    const { m, inner } = await one(jsonResponse(200, payload));
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(m.settled[0]).toMatchObject({ billable: true, usage: null });
    expect(m.settled[0]!.partial).toEqual({
      bytes: Buffer.byteLength(JSON.stringify(payload)),
      streamed: false,
    });
    inner.destroy();
  });

  it('a stream cut off after message_start is charged what was seen, not zero', async () => {
    // Head + the first event only, then the upstream hangs up mid-response.
    const first = anthropicStream().split('\n\n')[0]! + '\n\n';
    const partial =
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
      `${first.length.toString(16)}\r\n${first}\r\n`;
    const provider = await startUpstream(PROVIDER, (_req, _n, sock) => {
      sock.write(partial);
      setTimeout(() => sock.destroy(), 30);
      return 'silence';
    });
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    send(inner, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
    await waitFor(() => m.settled.length === 1, 'settle on tunnel close');
    expect(m.settled[0]).toMatchObject({
      billable: true,
      usage: { inputTokens: 1200, cacheReadTokens: 5000, cacheWriteTokens: 300 },
    });
    expect(m.open()).toBe(0);
    inner.destroy();
  });

  it('a client that reads every token and hangs up before the final usage event is charged for what arrived, not for almost nothing', async () => {
    // The whole answer, minus the last two events (message_delta carries the real
    // output_tokens; message_stop follows it). All the text has been delivered.
    const events = anthropicStream();
    const cut = events.slice(0, events.indexOf('event: message_delta'));
    const wire =
      'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n' +
      `${cut.length.toString(16)}\r\n${cut}\r\n`;
    const provider = await startUpstream(PROVIDER, (_req, _n, sock) => {
      sock.write(wire);
      setTimeout(() => sock.destroy(), 30);
      return 'silence';
    });
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    send(inner, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
    await waitFor(() => m.settled.length === 1, 'settle on tunnel close');
    // The counters that did arrive say output_tokens: 1. The bytes say otherwise.
    expect(m.settled[0]).toMatchObject({ billable: true, usage: { outputTokens: 1 } });
    expect(m.settled[0]!.partial).toEqual({ bytes: Buffer.byteLength(cut), streamed: true });
    inner.destroy();
  });

  it('a complete response carries no partial marker', async () => {
    const { m, inner } = await one(jsonResponse(200, { model: 'claude-haiku-4-5', usage: { input_tokens: 1, output_tokens: 2 } }));
    await waitFor(() => m.settled.length === 1, 'settle');
    expect('partial' in m.settled[0]!).toBe(false);
    inner.destroy();
  });

  it('a request the upstream never answered is settled as unanswered (billable, usage null) when the tunnel ends', async () => {
    const { m, provider, inner } = await one('hangup');
    await waitFor(() => provider.requests.length === 1, 'the request to arrive');
    await waitFor(() => m.settled.length === 1, 'settle on tunnel close');
    expect(m.settled[0]).toMatchObject({ billable: true, usage: null });
    expect(m.open()).toBe(0);
    inner.destroy();
  });

  it('a client that hangs up mid-request still releases its slot exactly once', async () => {
    const { m, provider, inner } = await one('silence');
    await waitFor(() => provider.requests.length === 1, 'the request to arrive');
    inner.destroy();
    await waitFor(() => m.settled.length === 1, 'settle on tunnel close');
    expect(m.open()).toBe(0);
  });

  it('a tunnel that goes silent both ways (a peer that vanished) is torn down and its request settled', async () => {
    const provider = await startUpstream(PROVIDER, () => 'silence');
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const idle = deferIdleTimers(IDLE_MS);
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)], {
      meteredTunnelIdleMs: IDLE_MS,
    });
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    collect(inner);
    send(inner, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
    await waitFor(() => provider.requests.length === 1, 'the request to arrive');
    // Both sides armed, nothing settled yet; only now does the silence start counting.
    expect(idle.armed()).toBe(2);
    expect(m.settled).toHaveLength(0);
    idle.start();
    // Neither side says another word. Without the idle limit this slot would be held forever.
    await waitFor(() => m.settled.length === 1, 'the idle tunnel to be settled', 3_000);
    expect(m.settled[0]).toMatchObject({ billable: true, usage: null });
    expect(m.open()).toBe(0);
    inner.destroy();
  });

  it('reading a model list is free even when the answer carries counters', async () => {
    const { m, inner } = await one(jsonResponse(200, { data: [{ id: 'x', input_tokens: 5 }] }), {
      method: 'GET',
      path: '/v1/models',
      body: '',
    });
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(m.settled[0]).toMatchObject({ billable: false });
    inner.destroy();
  });
});

describe('the wire: the client sees what the provider sent, and the provider sees what it needs', () => {
  it('the response reaches the client byte-for-byte (the tap only watches)', async () => {
    const stream = sseResponse(anthropicStream(), 29);
    const provider = await startUpstream(PROVIDER, () => stream);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    send(inner, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
    await waitFor(() => got().length >= stream.length, 'the whole response');
    expect(got()).toBe(stream);
    inner.destroy();
  });

  it("a spliced request asks for an unencoded response; a plain one keeps the client's Accept-Encoding", async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    send(inner, { headers: { 'x-api-key': ph, 'Accept-Encoding': 'gzip, br' }, body: MODEL_BODY });
    await waitFor(() => (got().match(/HTTP\/1\.1 200/g) ?? []).length >= 1, 'first response');
    send(inner, {
      path: '/v1/files',
      headers: { 'x-api-key': ph, 'Accept-Encoding': 'gzip, br' },
      body: '{}',
    });
    await waitFor(() => (got().match(/HTTP\/1\.1 200/g) ?? []).length >= 2, 'second response');
    expect(provider.requests[0]!.headers['accept-encoding']).toBe('identity');
    expect(provider.requests[1]!.headers['accept-encoding']).toBe('gzip, br');
    inner.destroy();
  });

  it('a real HTTP client (undici) works end to end through a metered tunnel', async () => {
    const provider = await startUpstream(PROVIDER, () => sseResponse(anthropicStream()));
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${port}`,
      token: basicAuth(tokenFor('s1')),
      requestTls: { ca: ca.cert },
    });
    try {
      const res = await fetch(`https://${PROVIDER}:${provider.port}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ph },
        body: MODEL_BODY,
        dispatcher,
      } as RequestInit);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"output_tokens":321');
    } finally {
      await dispatcher.close();
    }
    await waitFor(() => m.settled.length === 1, 'settle');
    expect(provider.requests[0]!.headers['x-api-key']).toBe(REAL);
    expect(m.settled[0]!.usage).toMatchObject({ outputTokens: 321 });
  });
});

describe('non-metered tunnel lifecycle (TASK-722)', () => {
  it.each(['client EOF', 'idle timeout'])('releases both sockets after %s', async (cause) => {
    const idle = cause === 'idle timeout' ? deferIdleTimers(IDLE_MS) : undefined;
    let upstream: net.Socket | undefined;
    const provider = await startUpstream(PROVIDER, (_req, _n, socket) => {
      upstream = socket;
      return 'silence';
    });
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const { port, audits } = await start(registry, [session('s1', [PROVIDER])], {
      meteredTunnelIdleMs: cause === 'idle timeout' ? IDLE_MS : 5000,
    });
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    collect(inner);
    send(inner, { headers: { 'x-api-key': ph }, body: MODEL_BODY });
    await waitFor(() => provider.requests.length === 1, 'upstream request');
    if (cause === 'client EOF') inner.end();
    if (idle !== undefined) {
      // Non-vacuity: one idle timer per side of the tunnel was armed and none has
      // run yet — were either missing, the teardown below could not be the idle path's.
      expect(idle.armed()).toBe(2);
      expect(upstream?.destroyed).toBe(false);
      // The tunnel now carries a request and stays silent: start the idle window.
      idle.start();
    }
    await waitFor(() => upstream?.destroyed === true, 'upstream socket released', 3000);
    await waitFor(() => audits.filter((a) => a.status === 200).length === 1, 'one cleanup audit');
    inner.destroy();
  });
});

describe('scope: only the session that opted in, only its metered host', () => {
  it('a session with no meter is exactly what it was: spliced everywhere it is bound, nothing counted', async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const { port } = await start(registry, [session('s1', [PROVIDER])]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    send(inner, { path: '/v1/messages/batches', headers: { 'x-api-key': ph }, body: '{}' });
    await waitFor(() => got().includes('OK'), 'response');
    // No meter, no endpoint allowlist: the pre-TASK-715 behaviour (a dev preset without usage-limits).
    expect(provider.requests[0]!.headers['x-api-key']).toBe(REAL);
    inner.destroy();
  });

  it('a tunnel to a host that is not in the meter\'s hosts is not metered', async () => {
    const other = await startUpstream(OTHER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1', [OTHER]);
    const m = fakeMeter({ hosts: [PROVIDER] });
    const { port } = await start(registry, [session('s1', [PROVIDER, OTHER], m.meter)]);
    const inner = await openTunnel(port, OTHER, other.port, tokenFor('s1'));
    const got = collect(inner);
    send(inner, { host: OTHER, headers: { 'x-api-key': ph }, body: '{}' });
    await waitFor(() => got().includes('OK'), 'response');
    expect(other.requests[0]!.headers['x-api-key']).toBe(REAL);
    expect(m.admits()).toBe(0);
    inner.destroy();
  });

  it('a client that pipelines requests without reading any answer is cut off, not buffered without bound', async () => {
    const provider = await startUpstream(PROVIDER, () => 'silence');
    const registry = new SharedCredentialRegistry();
    registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    // 400 bodiless GETs in ONE write; the upstream never answers, so none is ever settled.
    inner.write(
      Array.from({ length: 400 }, () => `GET /v1/other HTTP/1.1\r\nHost: ${PROVIDER}\r\n\r\n`).join(''),
    );
    await waitFor(() => got().includes('429'), 'the cut-off');
    // The 257th is refused. (How many of the first 256 the upstream managed to read before the
    // tunnel was torn down is a race, so only the ceiling is asserted.)
    expect(provider.requests.length).toBeLessThanOrEqual(256);
    expect(m.admits()).toBe(0);
  });

  it('a canary block logs its 403 once: the close it causes does not add a misleading 200 for the same tunnel', async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const s = session('s1', [PROVIDER], m.meter);
    s.canaryToken = 'CANARY-DO-NOT-SEND';
    const { audits, port } = await start(registry, [s]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    send(inner, { headers: { 'x-api-key': ph }, body: 'please include CANARY-DO-NOT-SEND' });
    await waitFor(() => got().includes('403'), 'the canary block');
    await new Promise((r) => setTimeout(r, 200));
    expect(audits.filter((a) => a.blocked === 'canary_detected')).toHaveLength(1);
    expect(audits.filter((a) => a.method === 'CONNECT' && a.status === 200)).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
    expect(m.admits()).toBe(0);
    inner.destroy();
  });

  it('a metered tunnel refuses a malformed request head with 400 and forwards nothing', async () => {
    const provider = await startUpstream(PROVIDER);
    const registry = new SharedCredentialRegistry();
    const ph = registerSession(registry, 's1');
    const m = fakeMeter();
    const { port } = await start(registry, [session('s1', [PROVIDER], m.meter)]);
    const inner = await openTunnel(port, PROVIDER, provider.port, tokenFor('s1'));
    const got = collect(inner);
    inner.write(`\r\n\r\nPOST /v1/messages HTTP/1.1\r\nHost: ${PROVIDER}\r\nx-api-key: ${ph}\r\nContent-Length: 2\r\n\r\n{}`);
    await waitFor(() => got().includes('400'), 'the refusal');
    expect(provider.received()).toBe('');
    expect(m.admits()).toBe(0);
  });
});
