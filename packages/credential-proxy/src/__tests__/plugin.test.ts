/**
 * Plugin tests — Task 9.
 *
 * `proxy:open-session` resolves credential refs via `credentials:get`,
 * builds a fresh CredentialPlaceholderMap for the session, registers it
 * with the listener's session store, and returns
 *   { proxyEndpoint, caCertPem, envMap }.
 *
 * `proxy:close-session` deregisters the session — verified end-to-end:
 * a request through the proxy that previously had its placeholder
 * substituted no longer gets substitution after close (the upstream
 * receives the raw placeholder, or — if allowlist is also gone — gets
 * a 403). We use the substitution path since that's the production
 * effect close-session needs to undo.
 *
 * Why end-to-end vs. a test seam: the registry is plugin-internal.
 * Exposing it for tests would invite future tests to lean on internals
 * rather than the hook surface (the actual contract). End-to-end here
 * is small enough — we already have all the listener helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect as netConnect } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer as tlsCreate, type Server as TLSServer } from 'node:tls';
import { ProxyAgent } from 'undici';
import {
  HookBus,
  PluginError,
  bootstrap,
  createLogger,
  makeAgentContext,
  type Plugin,
  type KernelHandle,
} from '@ax/core';
import { generateDomainCert, getOrCreateCA, type CAKeyPair } from '../ca.js';
import { createCredentialProxyPlugin } from '../plugin.js';
import { basicAuth, rawConnect } from './proxy-auth-helpers.js';

// In-memory `credentials:get` / `credentials:set` plugin. Matches the
// Phase 3 shape of @ax/credentials: `({ref, userId}) → string`. Stub
// stays in this file (vs. importing the real plugin) so we don't pull
// AES-GCM crypto into the proxy plugin's tests — they only need the
// hook surface, not the encryption.
function memCredentialsPlugin(onGet?: (ref: string) => void): Plugin {
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
          onGet?.(ref);
          const value = store.get(k(userId, ref));
          if (value === undefined) throw new Error(`no such credential: ${userId}:${ref}`);
          return value;
        },
      );
    },
  };
}

interface CapturedRequest {
  authorization: string | undefined;
  body: string;
}

/**
 * Stand up a TLS upstream signed by the proxy's CA. The proxy adds its
 * own CA to its outbound trust store, so the chain validates without
 * `rejectUnauthorized: false`.
 *
 * `certHost` is the name the leaf cert is issued for — it must be the name the
 * proxy dials the upstream by (the CONNECT hostname, used as SNI). `bindHost` is
 * the local address it listens on. Both default to `127.0.0.1`; the credential
 * binding tests override them to stand up a second upstream reached as
 * `localhost`. `authorizations` records EVERY request's Authorization header and
 * `raw()` every byte received, for "the real value never arrived" assertions.
 */
async function startCapturingUpstream(
  ca: CAKeyPair,
  opts: { certHost?: string; bindHost?: string } = {},
): Promise<{
  port: number;
  captured: CapturedRequest;
  authorizations: Array<string | undefined>;
  raw: () => string;
  gotRequest: Promise<void>;
  close: () => Promise<void>;
}> {
  const leaf = generateDomainCert(opts.certHost ?? '127.0.0.1', ca);
  const captured: CapturedRequest = { authorization: undefined, body: '' };
  const authorizations: Array<string | undefined> = [];
  let raw = '';
  let resolveReq!: () => void;
  const gotRequest = new Promise<void>((resolve) => {
    resolveReq = resolve;
  });

  const server: TLSServer = tlsCreate({ key: leaf.key, cert: leaf.cert }, (sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      raw += d.toString('utf8');
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
      if (buf.length - bodyStart >= contentLength) {
        captured.authorization = authorization;
        captured.body = buf.slice(bodyStart, bodyStart + contentLength);
        authorizations.push(authorization);
        sock.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
        sock.end();
        resolveReq();
      }
    });
    sock.on('error', () => { /* ignored — abort-side errors expected */ });
  });

  const port = await new Promise<number>((r) =>
    server.listen(0, opts.bindHost ?? '127.0.0.1', () =>
      r((server.address() as { port: number }).port),
    ),
  );
  return {
    port,
    captured,
    authorizations,
    raw: () => raw,
    gotRequest,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function ctx() {
  return makeAgentContext({ sessionId: 'test-session', agentId: 'test-agent', userId: 'test-user' });
}

// Parameterized ctx — proxy:add-host ownership checks key off ctx.userId.
function ctxFor(userId: string) {
  return makeAgentContext({ sessionId: 'test-session', agentId: 'test-agent', userId });
}

/**
 * A context whose logger writes into `lines` (parsed JSON), so a test can assert
 * on what the plugin logged without scraping stdout.
 */
function capturingCtx(userId: string) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    reqId: 'req-capture',
    writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return {
    lines,
    ctx: makeAgentContext({ sessionId: 'test-session', agentId: 'test-agent', userId, logger }),
  };
}

/** One POST through the proxy as the session that owns `token`. Resolves with the status. */
async function postThroughProxy(opts: {
  proxyPort: number;
  token: string;
  ca: CAKeyPair;
  host: string;
  upstreamPort: number;
  authorization: string;
}): Promise<number> {
  const dispatcher = new ProxyAgent({
    uri: `http://127.0.0.1:${opts.proxyPort}`,
    token: basicAuth(opts.token),
    requestTls: { ca: opts.ca.cert },
  });
  try {
    const res = await fetch(`https://${opts.host}:${opts.upstreamPort}/v1/messages`, {
      method: 'POST',
      headers: { authorization: opts.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
      dispatcher,
    } as RequestInit);
    await res.text();
    return res.status;
  } finally {
    await dispatcher.close();
  }
}

describe('@ax/credential-proxy plugin', () => {
  let caDir: string;
  let bus: HookBus;
  let kernel: KernelHandle | undefined;

  beforeEach(() => {
    caDir = mkdtempSync(join(tmpdir(), 'proxy-plugin-'));
    bus = new HookBus();
    kernel = undefined;
  });

  afterEach(async () => {
    if (kernel) await kernel.shutdown();
    rmSync(caDir, { recursive: true, force: true });
  });

  it('proxy:open-session resolves credentials, returns endpoint + envMap + CA', async () => {
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({
          listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
          caDir,
        }),
      ],
      config: {},
    });

    // Pre-populate a credential so the proxy:open-session resolution succeeds.
    await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-real-secret-xyz' });

    const result = await bus.call<
      {
        sessionId: string;
        userId: string;
        agentId: string;
        allowlist: string[];
        credentials: Record<string, { ref: string; kind: string; allowedHosts?: string[] }>;
      },
      {
        proxyEndpoint: string;
        caCertPem: string;
        envMap: Record<string, string>;
      }
    >('proxy:open-session', ctx(), {
      sessionId: 's1',
      userId: 'u1',
      agentId: 'a1',
      allowlist: ['api.anthropic.com'],
      credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key', allowedHosts: ['api.anthropic.com'] } },
    });

    expect(result.proxyEndpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);
    expect(result.caCertPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(result.envMap.ANTHROPIC_API_KEY).toMatch(/^ax-cred:[0-9a-f]{32}$/);
  });

  it('proxy:open-session returns the advertised endpoint (cluster Service URL), not the bind address (TASK-149)', async () => {
    // In TCP mode the listener binds 0.0.0.0:<port> inside the host pod, but
    // a runner in ANOTHER pod reaches it over a k8s Service. The advertised
    // endpoint (analogous to sandbox-k8s hostIpcUrl) overrides what
    // open-session returns so the runner gets a dialable URL.
    const advertised = 'tcp://ax-next-proxy.ax-next.svc.cluster.local:8888';
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({
          listen: { kind: 'tcp', host: '0.0.0.0', port: 0 },
          advertisedEndpoint: advertised,
          caDir,
        }),
      ],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      ref: 'r1',
      userId: 'u1',
      value: 'sk-real-secret-xyz',
    });
    const result = await bus.call<
      {
        sessionId: string;
        userId: string;
        agentId: string;
        allowlist: string[];
        credentials: Record<string, { ref: string; kind: string; allowedHosts?: string[] }>;
      },
      { proxyEndpoint: string }
    >('proxy:open-session', ctx(), {
      sessionId: 's1',
      userId: 'u1',
      agentId: 'a1',
      allowlist: ['api.anthropic.com'],
      credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key', allowedHosts: ['api.anthropic.com'] } },
    });
    expect(result.proxyEndpoint).toBe(advertised);
  });

  it('proxy:open-session returns a 32-hex proxyAuthToken (egress attribution)', async () => {
    // TASK-52: the proxy mints a per-session token the sandbox carries as
    // Proxy-Authorization, so the listener can attribute even a blocked
    // (allowlist-miss) request back to the session that made it.
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({
          listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
          caDir,
        }),
      ],
      config: {},
    });

    const out = await bus.call<
      {
        sessionId: string;
        userId: string;
        agentId: string;
        allowlist: string[];
        credentials: Record<string, { ref: string; kind: string }>;
      },
      { proxyAuthToken: string }
    >('proxy:open-session', ctx(), {
      sessionId: 's1',
      userId: 'u1',
      agentId: 'a1',
      allowlist: ['api.example.com'],
      credentials: {},
    });

    expect(out.proxyAuthToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('mints a distinct proxyAuthToken per session', async () => {
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({
          listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
          caDir,
        }),
      ],
      config: {},
    });

    const a = await bus.call<unknown, { proxyAuthToken: string }>(
      'proxy:open-session',
      ctx(),
      { sessionId: 'sa', userId: 'u', agentId: 'a', allowlist: [], credentials: {} },
    );
    const b = await bus.call<unknown, { proxyAuthToken: string }>(
      'proxy:open-session',
      ctx(),
      { sessionId: 'sb', userId: 'u', agentId: 'a', allowlist: [], credentials: {} },
    );
    expect(a.proxyAuthToken).not.toBe(b.proxyAuthToken);
  });

  it('proxy:close-session deregisters placeholder map (substitution stops)', async () => {
    // Mint a CA in caDir up front so the upstream can be signed by it.
    // The plugin's getOrCreateCA will load this same CA on init.
    const { getOrCreateCA } = await import('../ca.js');
    const ca = await getOrCreateCA(caDir);
    const upInfo = await startCapturingUpstream(ca);

    try {
      kernel = await bootstrap({
        bus,
        plugins: [
          memCredentialsPlugin(),
          createCredentialProxyPlugin({
            listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
            caDir,
          }),
        ],
        config: {},
      });

      // Pre-populate two credentials so two sessions can have separate placeholders.
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-secret-one' });

      const opened = await bus.call<
        unknown,
        {
          proxyEndpoint: string;
          caCertPem: string;
          proxyAuthToken: string;
          envMap: Record<string, string>;
        }
      >('proxy:open-session', ctx(), {
        sessionId: 's1',
        userId: 'u1',
        agentId: 'a1',
        allowlist: ['127.0.0.1'],
        allowedIPs: ['127.0.0.1'],
        // Bound to the host the upstream is reached as (TASK-687).
        credentials: {
          ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key', allowedHosts: ['127.0.0.1'] },
        },
      });

      // Extract the proxy port from the endpoint.
      const portMatch = opened.proxyEndpoint.match(/^tcp:\/\/127\.0\.0\.1:(\d+)$/);
      expect(portMatch).not.toBeNull();
      const proxyPort = parseInt(portMatch![1]!, 10);
      const placeholder = opened.envMap.ANTHROPIC_API_KEY!;

      // Send a request through the proxy with the placeholder. Substitution
      // SHOULD happen — the upstream sees the real value.
      const dispatcher = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
        token: basicAuth(opened.proxyAuthToken),
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
      expect(upInfo.captured.authorization).toBe('Bearer sk-secret-one');
      expect(upInfo.captured.authorization).not.toContain('ax-cred:');

      // Now close the session and verify substitution no longer happens.
      // The upstream is also no longer reachable because the session is gone:
      // its proxy token no longer authenticates, so the proxy returns 407 on
      // CONNECT, which fetch surfaces as a network error. We deliberately
      // present the CLOSED session's own token again — that 407 IS the proof
      // that the session-config store no longer has the entry.
      await bus.call('proxy:close-session', ctx(), { sessionId: 's1' });

      const dispatcher2 = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
        token: basicAuth(opened.proxyAuthToken),
        requestTls: { ca: ca.cert },
      });
      let secondReqError: Error | undefined;
      try {
        await fetch(`https://127.0.0.1:${upInfo.port}/v1/messages`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${placeholder}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ hello: 'world' }),
          dispatcher: dispatcher2,
        } as RequestInit);
      } catch (err) {
        secondReqError = err as Error;
      }
      // A 407 on CONNECT shows up as a fetch error from undici. Either way,
      // the upstream MUST NOT see a second request body with the real secret.
      // The first request already resolved gotRequest; the captured object
      // would be overwritten if a second body got through.
      expect(secondReqError).toBeDefined();
      // undici reports a refused CONNECT as an opaque "cancelled" error, so pin
      // the actual reason with a raw CONNECT: the CLOSED session's token no
      // longer authenticates → the proxy answers 407, not some other failure.
      const rawReply = await new Promise<string>((resolve, reject) => {
        const sock = netConnect(proxyPort, '127.0.0.1', () => {
          sock.write(rawConnect(`127.0.0.1:${upInfo.port}`, opened.proxyAuthToken));
        });
        let buf = '';
        sock.on('data', (d) => (buf += d.toString('utf8')));
        sock.on('end', () => resolve(buf));
        sock.on('error', reject);
      });
      expect(rawReply).toMatch(/^HTTP\/1\.1 407 /);
      expect(upInfo.captured.body).toBe(JSON.stringify({ hello: 'world' }));
      expect(upInfo.captured.authorization).toBe('Bearer sk-secret-one');
    } finally {
      await upInfo.close();
    }
  });

  it('proxy:rotate-session re-resolves credentials and returns fresh envMap', async () => {
    // Mint the CA up front so the upstream can be signed by it.
    const { getOrCreateCA } = await import('../ca.js');
    const ca = await getOrCreateCA(caDir);

    // A multi-request capturing upstream: each request body+authorization
    // pushed onto an array. Each request gets a fresh promise so the test
    // can wait for the next one.
    interface Captured {
      authorization: string | undefined;
      body: string;
    }
    const captures: Captured[] = [];
    const waiters: Array<() => void> = [];
    function nextRequest(): Promise<void> {
      return new Promise<void>((resolve) => waiters.push(resolve));
    }
    const leaf = generateDomainCert('127.0.0.1', ca);
    const server: TLSServer = tlsCreate({ key: leaf.key, cert: leaf.cert }, (sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('utf8');
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
        if (buf.length - bodyStart >= contentLength) {
          const body = buf.slice(bodyStart, bodyStart + contentLength);
          captures.push({ authorization, body });
          sock.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
          sock.end();
          const w = waiters.shift();
          if (w) w();
        }
      });
      sock.on('error', () => { /* ignored */ });
    });
    const upPort = await new Promise<number>((r) =>
      server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)),
    );
    const closeUpstream = (): Promise<void> =>
      new Promise<void>((r) => server.close(() => r()));

    try {
      kernel = await bootstrap({
        bus,
        plugins: [
          memCredentialsPlugin(),
          createCredentialProxyPlugin({
            listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
            caDir,
          }),
        ],
        config: {},
      });

      // Original credential value.
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-original' });

      const opened = await bus.call<
        unknown,
        {
          proxyEndpoint: string;
          caCertPem: string;
          proxyAuthToken: string;
          envMap: Record<string, string>;
        }
      >('proxy:open-session', ctx(), {
        sessionId: 's1',
        userId: 'u1',
        agentId: 'a1',
        allowlist: ['127.0.0.1'],
        allowedIPs: ['127.0.0.1'],
        // Bound to the host the upstream is reached as (TASK-687).
        credentials: {
          ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key', allowedHosts: ['127.0.0.1'] },
        },
      });

      const portMatch = opened.proxyEndpoint.match(/^tcp:\/\/127\.0\.0\.1:(\d+)$/);
      expect(portMatch).not.toBeNull();
      const proxyPort = parseInt(portMatch![1]!, 10);
      const oldPlaceholder = opened.envMap.ANTHROPIC_API_KEY!;
      expect(oldPlaceholder).toMatch(/^ax-cred:[0-9a-f]{32}$/);

      // First round-trip: substitution turns the OLD placeholder into the
      // ORIGINAL value.
      const dispatcher1 = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
        token: basicAuth(opened.proxyAuthToken),
        requestTls: { ca: ca.cert },
      });
      const wait1 = nextRequest();
      const res1 = await fetch(`https://127.0.0.1:${upPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${oldPlaceholder}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ which: 'first' }),
        dispatcher: dispatcher1,
      } as RequestInit);
      expect(res1.status).toBe(200);
      await wait1;
      expect(captures[0]?.authorization).toBe('Bearer sk-original');

      // Rotate: change the backing store, then call rotate-session.
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-rotated' });
      const rotated = await bus.call<
        { sessionId: string },
        { envMap: Record<string, string> }
      >('proxy:rotate-session', ctx(), { sessionId: 's1' });
      const placeholderAfterRotate = rotated.envMap.ANTHROPIC_API_KEY!;
      // I11: the placeholder is STABLE across rotations. A fresh placeholder
      // would invalidate the running sandbox's env (already read by the SDK
      // at startup). Same placeholder now substitutes to the new value.
      expect(placeholderAfterRotate).toBe(oldPlaceholder);

      // Second round-trip with the SAME placeholder: substitution → ROTATED.
      // Rotation re-resolves credentials only; the session's proxy token is
      // unchanged, so the same token still authenticates the second request.
      const dispatcher2 = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
        token: basicAuth(opened.proxyAuthToken),
        requestTls: { ca: ca.cert },
      });
      const wait2 = nextRequest();
      const res2 = await fetch(`https://127.0.0.1:${upPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${oldPlaceholder}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ which: 'second' }),
        dispatcher: dispatcher2,
      } as RequestInit);
      expect(res2.status).toBe(200);
      await wait2;
      expect(captures[1]?.authorization).toBe('Bearer sk-rotated');
      // The original value must NOT leak after rotation — the substitution
      // table should now hold ONLY the rotated value behind the placeholder.
      expect(captures[1]?.authorization).not.toContain('sk-original');
    } finally {
      await closeUpstream();
    }
  });

  it('proxy:rotate-session throws PluginError for unknown session', async () => {
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({
          listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
          caDir,
        }),
      ],
      config: {},
    });

    let caught: unknown;
    try {
      await bus.call('proxy:rotate-session', ctx(), { sessionId: 'never-opened' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('unknown-session');
    expect((caught as PluginError).message).toMatch(/never-opened/);
    expect((caught as PluginError).message).toMatch(/not open/);
  });

  // ── TASK-783: a failed resolve names the credential it failed on ─────
  //
  // open/rotate resolve a whole SET of refs (provider key + connector slots).
  // A bare resolver error lost which one failed, so the orchestrator could not
  // tell a missing provider key from a dead connector sign-in. The proxy now
  // rethrows as `credential-resolve-failed` with `diagnosis.envName` (the
  // caller's own key) and the original error on `.cause`. Its message is fixed
  // text: a resolver message can carry provider-authored OAuth error text.

  const UPSTREAM_TEXT = 'error_description=provider-says-something-long';

  function assertNamesCredential(caught: unknown, envName: string, causeName: string): void {
    expect(caught).toBeInstanceOf(PluginError);
    const pe = caught as PluginError;
    expect(pe.code).toBe('credential-resolve-failed');
    expect(pe.plugin).toBe('@ax/credential-proxy');
    expect(pe.diagnosis).toEqual({ envName });
    // The original resolver error survives on .cause (wrapped once by the bus).
    const cause = pe.cause as { name?: string; cause?: { name?: string } } | undefined;
    expect(cause?.name === causeName || cause?.cause?.name === causeName).toBe(true);
    // No upstream text in the message, and no env name in prose either.
    expect(pe.message).not.toContain(UPSTREAM_TEXT);
    expect(pe.message).not.toContain(envName);
  }

  it('proxy:open-session: a failed credentials:get names the failing env key (TASK-783)', async () => {
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin((ref) => {
          if (ref === 'account:gmail') {
            const e = new Error(`refresh rejected: ${UPSTREAM_TEXT}`);
            e.name = 'NeedsReconnectError';
            throw e;
          }
        }),
        createCredentialProxyPlugin({ listen: { kind: 'tcp', host: '127.0.0.1', port: 0 }, caDir }),
      ],
      config: {},
    });
    await bus.call('credentials:set', ctx(), { ref: 'provider:anthropic', userId: 'u1', value: 'sk-1' });

    let caught: unknown;
    try {
      await bus.call('proxy:open-session', ctx(), {
        sessionId: 's-name',
        userId: 'u1',
        agentId: 'a1',
        allowlist: [],
        credentials: {
          ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          'connector:gmail:GMAIL': { ref: 'account:gmail', kind: 'mcp-oauth' },
        },
      });
    } catch (err) {
      caught = err;
    }
    assertNamesCredential(caught, 'connector:gmail:GMAIL', 'NeedsReconnectError');
  });

  it('proxy:rotate-session: a failed credentials:get names the failing env key (TASK-783)', async () => {
    let failGmail = false;
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin((ref) => {
          if (failGmail && ref === 'account:gmail') {
            throw new PluginError({
              code: 'credential-not-found',
              plugin: '@test/mem-credentials',
              message: `no credential: ${UPSTREAM_TEXT}`,
            });
          }
        }),
        createCredentialProxyPlugin({ listen: { kind: 'tcp', host: '127.0.0.1', port: 0 }, caDir }),
      ],
      config: {},
    });
    await bus.call('credentials:set', ctx(), { ref: 'provider:anthropic', userId: 'u1', value: 'sk-1' });
    await bus.call('credentials:set', ctx(), { ref: 'account:gmail', userId: 'u1', value: 'tok-1' });
    await bus.call('proxy:open-session', ctx(), {
      sessionId: 's-rot-name',
      userId: 'u1',
      agentId: 'a1',
      allowlist: [],
      credentials: {
        ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
        'connector:gmail:GMAIL': { ref: 'account:gmail', kind: 'mcp-oauth' },
      },
    });

    failGmail = true;
    let caught: unknown;
    try {
      await bus.call('proxy:rotate-session', ctx(), { sessionId: 's-rot-name' });
    } catch (err) {
      caught = err;
    }
    assertNamesCredential(caught, 'connector:gmail:GMAIL', 'PluginError');
    expect(((caught as PluginError).cause as PluginError).code).toBe('credential-not-found');
  });

  // ── proxy:add-host (TASK-37 — reactive egress wall) ──────────────────
  //
  // Widens a LIVE session's allowlist with no re-spawn. Host-internal,
  // owner-checked. We assert the bus contract + ownership/validation throws
  // here; the live-widening EFFECT (blocked 403 → grant → retry no longer
  // 403) is proven end-to-end through the real listener in
  // reactive-wall.canary.test.ts (the plugin's `sessions` Map is internal —
  // no test seam, same posture as TASK-52).

  async function bootProxy(): Promise<void> {
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({
          listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
          caDir,
        }),
      ],
      config: {},
    });
  }

  async function openSession(userId: string, allowlist: string[]): Promise<void> {
    await bus.call('proxy:open-session', ctxFor(userId), {
      sessionId: 's1',
      userId,
      agentId: 'a1',
      allowlist,
      credentials: {},
    });
  }

  it('proxy:add-host adds a host to the live session allowlist (owner only)', async () => {
    await bootProxy();
    await openSession('u1', ['a.example.com']);
    const out = await bus.call<
      { sessionId: string; host: string },
      { added: boolean; agentId?: string }
    >('proxy:add-host', ctxFor('u1'), { sessionId: 's1', host: 'b.example.com' });
    // openSession opens with agentId 'a1' — proxy:add-host returns it so the
    // host-side caller can persist a per-(user, agent) grant (TASK-44).
    expect(out).toEqual({ added: true, agentId: 'a1' });
  });

  it('proxy:add-host returns the session agentId on a successful grant', async () => {
    await bootProxy();
    await bus.call('proxy:open-session', ctxFor('u1'), {
      sessionId: 's-agent',
      userId: 'u1',
      agentId: 'agent-7',
      allowlist: ['a.example.com'],
      credentials: {},
    });
    const out = await bus.call<
      { sessionId: string; host: string },
      { added: boolean; agentId?: string }
    >('proxy:add-host', ctxFor('u1'), { sessionId: 's-agent', host: 'b.example.com' });
    expect(out).toEqual({ added: true, agentId: 'agent-7' });
  });

  it('proxy:add-host rejects a grant from a different user (ownership)', async () => {
    await bootProxy();
    await openSession('u1', []);
    let caught: unknown;
    try {
      await bus.call('proxy:add-host', ctxFor('attacker'), {
        sessionId: 's1',
        host: 'b.example.com',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('forbidden');
    expect((caught as PluginError).message).toMatch(/not the session owner/i);
  });

  it('proxy:add-host returns { added: false } for an unknown/closed session (no throw)', async () => {
    await bootProxy();
    const out = await bus.call<
      { sessionId: string; host: string },
      { added: boolean }
    >('proxy:add-host', ctxFor('u1'), { sessionId: 'gone', host: 'b.example.com' });
    expect(out).toEqual({ added: false });
  });

  it.each(['', 'a'.repeat(254), 'has space', 'UPPER.example.com', '*.example.com'])(
    'proxy:add-host rejects an invalid host %p',
    async (host) => {
      await bootProxy();
      await openSession('u1', []);
      let caught: unknown;
      try {
        await bus.call('proxy:add-host', ctxFor('u1'), { sessionId: 's1', host });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('invalid-host');
      expect((caught as PluginError).message).toMatch(/invalid host/i);
    },
  );

  // ── credential binding (TASK-687) ────────────────────────────────────
  //
  // A credential's `allowedHosts` (proxy:open-session) decides where its
  // placeholder is substituted; the session `allowlist` only decides where the
  // session may REACH. These run the real plugin + real listener over real
  // sockets. The plugin's listener has no resolver seam, so two distinct
  // allowlisted hostnames reaching loopback upstreams are `127.0.0.1` (an IP
  // literal, bound to the credential) and `localhost` (a name the user "adds" —
  // the stand-in for a host they control). Each has its own upstream + leaf
  // cert, and the session's `allowedIPs` covers whichever loopback address
  // `localhost` resolves to on this machine (127.0.0.1 or ::1).

  const REAL_KEY = 'sk-REAL-operator-key-0123456789';

  interface BindingRig {
    ca: CAKeyPair;
    /** Upstream reached as `127.0.0.1` — the host the credential is bound to. */
    bound: Awaited<ReturnType<typeof startCapturingUpstream>>;
    /** Upstream reached as `localhost` — allowlisted, but NOT a bound host. */
    other: Awaited<ReturnType<typeof startCapturingUpstream>>;
    /** Loopback address `localhost` resolves to here. */
    localhostIP: string;
    close: () => Promise<void>;
  }

  async function startBindingRig(): Promise<BindingRig> {
    const ca = await getOrCreateCA(caDir);
    const { address: localhostIP } = await dnsLookup('localhost');
    const bound = await startCapturingUpstream(ca);
    const other = await startCapturingUpstream(ca, { certHost: 'localhost', bindHost: localhostIP });
    return {
      ca,
      bound,
      other,
      localhostIP,
      close: async () => {
        await bound.close();
        await other.close();
      },
    };
  }

  interface OpenedSession {
    proxyEndpoint: string;
    proxyAuthToken: string;
    envMap: Record<string, string>;
  }

  it('END TO END: a host added via proxy:add-host never receives a key bound to another host', async () => {
    const rig = await startBindingRig();
    try {
      await bootProxy();
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: REAL_KEY });
      const { ctx: openCtx, lines } = capturingCtx('u1');
      const opened = await bus.call<unknown, OpenedSession>('proxy:open-session', openCtx, {
        sessionId: 's1',
        userId: 'u1',
        agentId: 'a1',
        allowlist: ['127.0.0.1'],
        allowedIPs: ['127.0.0.1', rig.localhostIP],
        credentials: {
          ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key', allowedHosts: ['127.0.0.1'] },
        },
      });
      const proxyPort = parseInt(opened.proxyEndpoint.split(':').pop()!, 10);
      const placeholder = opened.envMap.ANTHROPIC_API_KEY!;
      const post = (host: string, upstreamPort: number): Promise<number> =>
        postThroughProxy({
          proxyPort,
          token: opened.proxyAuthToken,
          ca: rig.ca,
          host,
          upstreamPort,
          authorization: `Bearer ${placeholder}`,
        });

      // Premise: `localhost` is NOT reachable until the user adds it.
      await expect(post('localhost', rig.other.port)).rejects.toThrow();
      expect(rig.other.authorizations).toEqual([]);

      // The session's owner widens its own allowlist to a host it controls.
      const added = await bus.call<{ sessionId: string; host: string }, { added: boolean }>(
        'proxy:add-host',
        ctxFor('u1'),
        { sessionId: 's1', host: 'localhost' },
      );
      expect(added.added).toBe(true);

      // Reachable now — and the operator key does NOT follow it there.
      expect(await post('localhost', rig.other.port)).toBe(200);
      expect(rig.other.authorizations).toEqual([`Bearer ${placeholder}`]);
      expect(rig.other.raw()).not.toContain(REAL_KEY);

      // The bound host still gets the real value.
      expect(await post('127.0.0.1', rig.bound.port)).toBe(200);
      expect(rig.bound.authorizations).toEqual([`Bearer ${REAL_KEY}`]);

      // A bound credential is not "unbound": no warning for it.
      expect(lines.filter((l) => l.msg === 'credential_unbound')).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  it.each([
    ['omitted', undefined],
    ['an empty list', [] as string[]],
  ])(
    'a credential whose allowedHosts is %s keeps its placeholder in envMap but is never substituted, and is logged by name only',
    async (_label, allowedHosts) => {
      const rig = await startBindingRig();
      try {
        await bootProxy();
        await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: REAL_KEY });
        const { ctx: openCtx, lines } = capturingCtx('u1');
        const opened = await bus.call<unknown, OpenedSession>('proxy:open-session', openCtx, {
          sessionId: 's1',
          userId: 'u1',
          agentId: 'a1',
          // 127.0.0.1 IS allowlisted and reached — the credential just isn't bound to it.
          allowlist: ['127.0.0.1'],
          allowedIPs: ['127.0.0.1'],
          credentials: {
            ANTHROPIC_API_KEY: {
              ref: 'r1',
              kind: 'api-key',
              ...(allowedHosts !== undefined ? { allowedHosts } : {}),
            },
          },
        });
        const placeholder = opened.envMap.ANTHROPIC_API_KEY!;
        expect(placeholder).toMatch(/^ax-cred:[0-9a-f]{32}$/);

        const status = await postThroughProxy({
          proxyPort: parseInt(opened.proxyEndpoint.split(':').pop()!, 10),
          token: opened.proxyAuthToken,
          ca: rig.ca,
          host: '127.0.0.1',
          upstreamPort: rig.bound.port,
          authorization: `Bearer ${placeholder}`,
        });
        expect(status).toBe(200);
        expect(rig.bound.authorizations).toEqual([`Bearer ${placeholder}`]);
        expect(rig.bound.raw()).not.toContain(REAL_KEY);

        // Default-deny is made visible: one warning, carrying the env NAME only.
        const warns = lines.filter((l) => l.msg === 'credential_unbound');
        expect(warns).toHaveLength(1);
        expect(warns[0]).toMatchObject({ level: 'warn', envName: 'ANTHROPIC_API_KEY' });
        const logged = JSON.stringify(lines);
        expect(logged).not.toContain(REAL_KEY);
        expect(logged).not.toContain(placeholder);
      } finally {
        await rig.close();
      }
    },
  );

  it.each([
    ['a bare string', 'api.provider.test'],
    ['an array holding a number', ['api.provider.test', 42]],
    ['an object', { host: 'api.provider.test' }],
    ['null', null],
  ])(
    'proxy:open-session rejects %s as allowedHosts (invalid-credential-hosts) before any credentials:get',
    async (_label, allowedHosts) => {
      let getCalls = 0;
      kernel = await bootstrap({
        bus,
        plugins: [
          memCredentialsPlugin(() => {
            getCalls += 1;
          }),
          createCredentialProxyPlugin({
            listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
            caDir,
          }),
        ],
        config: {},
      });
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: REAL_KEY });

      let caught: unknown;
      try {
        await bus.call('proxy:open-session', ctxFor('u1'), {
          sessionId: 's-bad',
          userId: 'u1',
          agentId: 'a1',
          allowlist: ['127.0.0.1'],
          credentials: {
            // A WELL-FORMED credential first: if validation were interleaved with
            // resolution, this one's credentials:get would already have run.
            GOOD: { ref: 'r1', kind: 'api-key', allowedHosts: ['api.provider.test'] },
            BAD: { ref: 'r1', kind: 'api-key', allowedHosts },
          },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('invalid-credential-hosts');
      expect((caught as PluginError).message).toMatch(/BAD/);
      expect(getCalls).toBe(0);

      // Nothing was half-registered.
      let rotateErr: unknown;
      try {
        await bus.call('proxy:rotate-session', ctx(), { sessionId: 's-bad' });
      } catch (err) {
        rotateErr = err;
      }
      expect((rotateErr as PluginError).code).toBe('unknown-session');
    },
  );

  it('proxy:rotate-session keeps the binding: the bound host gets the NEW value, an unbound host still gets nothing', async () => {
    const rig = await startBindingRig();
    try {
      await bootProxy();
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-original' });
      const opened = await bus.call<unknown, OpenedSession>('proxy:open-session', ctx(), {
        sessionId: 's1',
        userId: 'u1',
        agentId: 'a1',
        // Both hosts allowlisted from the start; only 127.0.0.1 is bound.
        allowlist: ['127.0.0.1', 'localhost'],
        allowedIPs: ['127.0.0.1', rig.localhostIP],
        credentials: {
          ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key', allowedHosts: ['127.0.0.1'] },
        },
      });
      const proxyPort = parseInt(opened.proxyEndpoint.split(':').pop()!, 10);
      const placeholder = opened.envMap.ANTHROPIC_API_KEY!;
      const post = (host: string, upstreamPort: number): Promise<number> =>
        postThroughProxy({
          proxyPort,
          token: opened.proxyAuthToken,
          ca: rig.ca,
          host,
          upstreamPort,
          authorization: `Bearer ${placeholder}`,
        });

      // Before rotation.
      expect(await post('127.0.0.1', rig.bound.port)).toBe(200);
      expect(await post('localhost', rig.other.port)).toBe(200);
      expect(rig.bound.authorizations).toEqual(['Bearer sk-original']);
      expect(rig.other.authorizations).toEqual([`Bearer ${placeholder}`]);

      // Rotate the backing value.
      await bus.call('credentials:set', ctx(), { ref: 'r1', userId: 'u1', value: 'sk-rotated' });
      const rotated = await bus.call<{ sessionId: string }, { envMap: Record<string, string> }>(
        'proxy:rotate-session',
        ctx(),
        { sessionId: 's1' },
      );
      expect(rotated.envMap.ANTHROPIC_API_KEY).toBe(placeholder); // I11: same placeholder

      // After rotation: bound host gets the NEW value…
      expect(await post('127.0.0.1', rig.bound.port)).toBe(200);
      expect(rig.bound.authorizations).toEqual(['Bearer sk-original', 'Bearer sk-rotated']);
      // …and rotation did not widen the binding: the other host still sees only
      // the placeholder, never either real value.
      expect(await post('localhost', rig.other.port)).toBe(200);
      expect(rig.other.authorizations).toEqual([`Bearer ${placeholder}`, `Bearer ${placeholder}`]);
      expect(rig.other.raw()).not.toContain('sk-original');
      expect(rig.other.raw()).not.toContain('sk-rotated');
    } finally {
      await rig.close();
    }
  });
});
