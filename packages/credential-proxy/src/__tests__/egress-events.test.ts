/**
 * Task 11 — `event.http-egress` emission tests.
 *
 * Asserts that the credential-proxy plugin fires an
 * `event.http-egress` payload on the bus for every audit-worthy proxy
 * event: success forwards, allowlist blocks, private-IP blocks, and
 * MITM successes that substituted credentials.
 *
 * The payload contract is the architecture spec's:
 *   { sessionId, userId, method, host, path, status,
 *     requestBytes, responseBytes, durationMs,
 *     credentialInjected, classification,
 *     blockedReason?, timestamp }
 *
 * What we DON'T test here (covered elsewhere):
 *  - Listener-internal `ProxyAuditEntry` shape (listener tests).
 *  - Substitution mechanics — only the resulting `credentialInjected`
 *    flag in the bus event.
 *  - Subscriber error isolation — that's a HookBus contract test, not
 *    a plugin-level test. We DO assert the proxy keeps working when a
 *    subscriber throws (the most direct way to verify integration).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as httpCreate, type Server as HTTPServer } from 'node:http';
import { createServer as tlsCreate, type Server as TLSServer } from 'node:tls';
import { ProxyAgent } from 'undici';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type Plugin,
  type KernelHandle,
} from '@ax/core';
import { generateDomainCert, type CAKeyPair, getOrCreateCA } from '../ca.js';
import { createCredentialProxyPlugin, type HttpEgressEvent } from '../plugin.js';

// ── Test helpers ─────────────────────────────────────────────────────

/**
 * In-memory `credentials:get` / `credentials:set` plugin (same shape as
 * plugin.test.ts). Matches the Phase 3 shape: `({ref, userId}) → string`.
 */
function memCredentialsPlugin(): Plugin {
  const store = new Map<string, string>();
  const k = (userId: string, ref: string): string => `${userId}:${ref}`;
  return {
    manifest: {
      name: '@test/mem-credentials',
      version: '0.0.0',
      registers: ['credentials:get', 'credentials:set'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<{ ref: string; userId: string; value: string }, void>(
        'credentials:set',
        '@test/mem-credentials',
        async (_ctx, { ref, userId, value }) => {
          store.set(k(userId, ref), value);
        },
      );
      bus.registerService<{ ref: string; userId: string }, string>(
        'credentials:get',
        '@test/mem-credentials',
        async (_ctx, { ref, userId }) => {
          const value = store.get(k(userId, ref));
          if (value === undefined) throw new Error(`no such credential: ${userId}:${ref}`);
          return value;
        },
      );
    },
  };
}

/**
 * Subscribes to `event.http-egress` and pushes every payload onto a
 * shared array. Each test gets a fresh array + a fresh plugin so
 * captures can't bleed between tests.
 */
function eventCapturePlugin(captured: HttpEgressEvent[]): Plugin {
  return {
    manifest: {
      name: '@test/event-capture',
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: ['event.http-egress'],
    },
    init({ bus }) {
      bus.subscribe<HttpEgressEvent>(
        'event.http-egress',
        '@test/event-capture',
        async (_ctx, payload) => {
          captured.push(payload);
          return undefined;
        },
      );
    },
  };
}

/**
 * Subscriber that throws on every fire. Used to assert HookBus's
 * isolation contract — a misbehaving subscriber must NOT break the
 * proxy or other subscribers.
 */
function throwingSubscriberPlugin(): Plugin {
  return {
    manifest: {
      name: '@test/throwing-subscriber',
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: ['event.http-egress'],
    },
    init({ bus }) {
      bus.subscribe<HttpEgressEvent>(
        'event.http-egress',
        '@test/throwing-subscriber',
        async () => {
          throw new Error('intentional subscriber failure');
        },
      );
    },
  };
}

interface CapturedTLS {
  authorization: string | undefined;
  body: string;
}

/**
 * TLS upstream signed by the proxy's CA. The proxy adds its CA to the
 * outbound trust store, so the chain validates without
 * `rejectUnauthorized: false`.
 */
async function startCapturingTLSUpstream(ca: CAKeyPair): Promise<{
  port: number;
  captured: CapturedTLS;
  gotRequest: Promise<void>;
  close: () => Promise<void>;
}> {
  const leaf = generateDomainCert('127.0.0.1', ca);
  const captured: CapturedTLS = { authorization: undefined, body: '' };
  let resolveReq!: () => void;
  const gotRequest = new Promise<void>((resolve) => {
    resolveReq = resolve;
  });
  const server: TLSServer = tlsCreate({ key: leaf.key, cert: leaf.cert }, (sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const lines = buf.slice(0, headerEnd).split('\r\n');
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
        sock.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
        sock.end();
        resolveReq();
      }
    });
    sock.on('error', () => { /* aborts expected */ });
  });
  const port = await new Promise<number>((r) =>
    server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)),
  );
  return {
    port,
    captured,
    gotRequest,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function ctx() {
  return makeAgentContext({ sessionId: 'test-session', agentId: 'test-agent', userId: 'test-user' });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('event.http-egress emission', () => {
  let caDir: string;
  let bus: HookBus;
  let kernel: KernelHandle | undefined;
  let captured: HttpEgressEvent[];

  beforeEach(() => {
    caDir = mkdtempSync(join(tmpdir(), 'proxy-egress-'));
    bus = new HookBus();
    kernel = undefined;
    captured = [];
  });

  afterEach(async () => {
    if (kernel) await kernel.shutdown();
    rmSync(caDir, { recursive: true, force: true });
  });

  /**
   * Helper: bootstrap a kernel with mem-credentials + the proxy plugin
   * + the event-capture plugin, in that load order. Returns the kernel
   * handle so the test can drive `proxy:open-session` etc.
   */
  async function boot(extraPlugins: Plugin[] = []): Promise<KernelHandle> {
    return bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({
          listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
          caDir,
        }),
        eventCapturePlugin(captured),
        ...extraPlugins,
      ],
      config: {},
    });
  }

  it('fires for HTTP forward (success) with classification=llm', async () => {
    // Stand up an HTTP upstream the proxy can forward to.
    const upstream: HTTPServer = httpCreate((_req, res) => {
      res.end('OK from upstream');
    });
    const upPort = await new Promise<number>((r) =>
      upstream.listen(0, '127.0.0.1', () => r((upstream.address() as { port: number }).port)),
    );

    try {
      kernel = await boot();
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-secret' });

      const opened = await bus.call<unknown, { proxyEndpoint: string }>(
        'proxy:open-session',
        ctx(),
        {
          sessionId: 's1',
          userId: 'u1',
          agentId: 'a1',
          allowlist: ['127.0.0.1'],
          allowedIPs: ['127.0.0.1'],
          credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key' } },
        },
      );
      const proxyPort = parseInt(opened.proxyEndpoint.split(':').pop()!, 10);

      const dispatcher = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
        proxyTunnel: false, // HTTP path, not CONNECT
      });
      const res = await fetch(`http://127.0.0.1:${upPort}/foo/bar`, { dispatcher } as RequestInit);
      expect(res.status).toBe(200);

      // The fire is sync from the listener's perspective (it doesn't await
      // bus.fire) but the subscriber callback is async — give it a tick.
      await new Promise<void>((r) => setImmediate(r));
      expect(captured.length).toBe(1);
      const ev = captured[0]!;
      expect(ev.sessionId).toBe('s1');
      expect(ev.userId).toBe('u1');
      expect(ev.method).toBe('GET');
      expect(ev.host).toBe('127.0.0.1');
      expect(ev.path).toBe('/foo/bar');
      expect(ev.status).toBe(200);
      expect(ev.classification).toBe('llm');
      expect(ev.credentialInjected).toBe(false); // HTTP path doesn't substitute
      expect(ev.blockedReason).toBeUndefined();
      expect(typeof ev.durationMs).toBe('number');
      expect(typeof ev.timestamp).toBe('number');
      expect(ev.responseBytes).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });

  it('fires for MITM CONNECT (success) with credentialInjected=true', async () => {
    // Pre-mint the CA so the upstream cert chains to it.
    const ca = await getOrCreateCA(caDir);
    const upInfo = await startCapturingTLSUpstream(ca);

    try {
      kernel = await boot();
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-real-secret' });

      const opened = await bus.call<
        unknown,
        { proxyEndpoint: string; envMap: Record<string, string> }
      >('proxy:open-session', ctx(), {
        sessionId: 's1',
        userId: 'u1',
        agentId: 'a1',
        allowlist: ['127.0.0.1'],
        allowedIPs: ['127.0.0.1'],
        credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key' } },
      });
      const proxyPort = parseInt(opened.proxyEndpoint.split(':').pop()!, 10);
      const placeholder = opened.envMap.ANTHROPIC_API_KEY!;

      const dispatcher = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
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
      expect(upInfo.captured.authorization).toBe('Bearer sk-real-secret');

      // Wait for the cleanup-driven 200 audit. The MITM cleanup runs on
      // socket close, which can fire after the fetch resolves; poll a
      // bounded number of ticks rather than a fixed sleep.
      for (let i = 0; i < 100 && captured.length === 0; i++) {
        await new Promise<void>((r) => setImmediate(r));
      }
      expect(captured.length).toBe(1);
      const ev = captured[0]!;
      expect(ev.sessionId).toBe('s1');
      expect(ev.userId).toBe('u1');
      expect(ev.method).toBe('CONNECT');
      expect(ev.host).toBe('127.0.0.1');
      expect(ev.path).toBe('/');
      expect(ev.status).toBe(200);
      expect(ev.classification).toBe('llm');
      expect(ev.credentialInjected).toBe(true);
      expect(ev.blockedReason).toBeUndefined();
    } finally {
      await upInfo.close();
    }
  });

  it('fires for allowlist block with blockedReason=allowlist', async () => {
    const upstream: HTTPServer = httpCreate((_req, res) => res.end('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream.listen(0, '127.0.0.1', () => r((upstream.address() as { port: number }).port)),
    );

    try {
      kernel = await boot();
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-secret' });
      // Open a session with an allowlist that does NOT include 127.0.0.1 —
      // requests to 127.0.0.1 hit "no allowing session" and 403.
      const opened = await bus.call<unknown, { proxyEndpoint: string }>(
        'proxy:open-session',
        ctx(),
        {
          sessionId: 's1',
          userId: 'u1',
          agentId: 'a1',
          allowlist: ['other.example.com'],
          credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key' } },
        },
      );
      const proxyPort = parseInt(opened.proxyEndpoint.split(':').pop()!, 10);

      const dispatcher = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
        proxyTunnel: false,
      });
      const res = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
      expect(res.status).toBe(403);

      await new Promise<void>((r) => setImmediate(r));
      expect(captured.length).toBe(1);
      const ev = captured[0]!;
      expect(ev.blockedReason).toBe('allowlist');
      expect(ev.status).toBe(403);
      expect(ev.host).toBe('127.0.0.1');
      // No matching session → sessionId/userId empty, classification='other'.
      expect(ev.sessionId).toBe('');
      expect(ev.userId).toBe('');
      expect(ev.classification).toBe('other');
      expect(ev.credentialInjected).toBe(false);
    } finally {
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });

  it('fires for private-IP block with blockedReason=private-ip', async () => {
    try {
      kernel = await boot();
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-secret' });
      // Allowlist contains the host but NO allowedIPs override. The DNS
      // resolution to 127.0.0.1 trips BlockedIPError → 403.
      const opened = await bus.call<unknown, { proxyEndpoint: string }>(
        'proxy:open-session',
        ctx(),
        {
          sessionId: 's1',
          userId: 'u1',
          agentId: 'a1',
          allowlist: ['127.0.0.1'], // host allowed
          // allowedIPs intentionally omitted — private-IP block fires.
          credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key' } },
        },
      );
      const proxyPort = parseInt(opened.proxyEndpoint.split(':').pop()!, 10);

      const dispatcher = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
        proxyTunnel: false,
      });
      // The whole point of this test is the proxy's private-IP block —
      // we deliberately request `http://127.0.0.1/` (the metadata-style
      // bare-loopback URL the proxy must reject as SSRF) and assert the
      // 403 + `event.http-egress` shape. HTTPS would change the path
      // under test (CONNECT vs forwarding) and hide the bug we're after.
      const res = await fetch(`http://127.0.0.1/`, { dispatcher } as RequestInit); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      expect(res.status).toBe(403);

      await new Promise<void>((r) => setImmediate(r));
      expect(captured.length).toBe(1);
      const ev = captured[0]!;
      expect(ev.blockedReason).toBe('private-ip');
      expect(ev.status).toBe(403);
      // Session matched (allowlist passed), so attribution carries through.
      expect(ev.sessionId).toBe('s1');
      expect(ev.userId).toBe('u1');
      expect(ev.classification).toBe('llm');
    } finally {
      // No upstream to close; the request never reaches one.
    }
  });

  it('keeps firing when a subscriber throws (HookBus isolation)', async () => {
    // Two subscribers: a throwing one (loaded first) + the capture one.
    // HookBus.fire MUST catch the throw and continue to the next subscriber,
    // so the capture array still receives the payload.
    const upstream: HTTPServer = httpCreate((_req, res) => res.end('OK'));
    const upPort = await new Promise<number>((r) =>
      upstream.listen(0, '127.0.0.1', () => r((upstream.address() as { port: number }).port)),
    );

    try {
      // Order matters: throwingSubscriber registers BEFORE eventCapture so
      // the throw fires first, and we can prove eventCapture still runs.
      kernel = await bootstrap({
        bus,
        plugins: [
          memCredentialsPlugin(),
          createCredentialProxyPlugin({
            listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
            caDir,
          }),
          throwingSubscriberPlugin(),
          eventCapturePlugin(captured),
        ],
        config: {},
      });

      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-secret' });
      const opened = await bus.call<unknown, { proxyEndpoint: string }>(
        'proxy:open-session',
        ctx(),
        {
          sessionId: 's1',
          userId: 'u1',
          agentId: 'a1',
          allowlist: ['127.0.0.1'],
          allowedIPs: ['127.0.0.1'],
          credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key' } },
        },
      );
      const proxyPort = parseInt(opened.proxyEndpoint.split(':').pop()!, 10);

      const dispatcher = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
        proxyTunnel: false,
      });
      const res = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
      expect(res.status).toBe(200);

      await new Promise<void>((r) => setImmediate(r));
      // The throwing subscriber's failure must not have stopped the capture.
      expect(captured.length).toBe(1);
      expect(captured[0]!.status).toBe(200);
    } finally {
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});
