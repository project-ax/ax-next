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
import { createServer as tlsCreate, type Server as TLSServer } from 'node:tls';
import { ProxyAgent } from 'undici';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type Plugin,
  type KernelHandle,
} from '@ax/core';
import { generateDomainCert, type CAKeyPair } from '../ca.js';
import { createCredentialProxyPlugin } from '../plugin.js';

// In-memory `credentials:get` / `credentials:set` plugin. Matches the
// Phase 3 shape of @ax/credentials: `({ref, userId}) → string`. Stub
// stays in this file (vs. importing the real plugin) so we don't pull
// AES-GCM crypto into the proxy plugin's tests — they only need the
// hook surface, not the encryption.
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

interface CapturedRequest {
  authorization: string | undefined;
  body: string;
}

/**
 * Stand up a TLS upstream signed by the proxy's CA. The proxy adds its
 * own CA to its outbound trust store, so the chain validates without
 * `rejectUnauthorized: false`.
 */
async function startCapturingUpstream(
  ca: CAKeyPair,
): Promise<{ port: number; captured: CapturedRequest; gotRequest: Promise<void>; close: () => Promise<void> }> {
  const leaf = generateDomainCert('127.0.0.1', ca);
  const captured: CapturedRequest = { authorization: undefined, body: '' };
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
      const header = buf.slice(0, headerEnd);
      const lines = header.split('\r\n');
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
    sock.on('error', () => { /* ignored — abort-side errors expected */ });
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
        credentials: Record<string, { ref: string; kind: string }>;
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
      credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key' } },
    });

    expect(result.proxyEndpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);
    expect(result.caCertPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(result.envMap.ANTHROPIC_API_KEY).toMatch(/^ax-cred:[0-9a-f]{32}$/);
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
        { proxyEndpoint: string; caCertPem: string; envMap: Record<string, string> }
      >('proxy:open-session', ctx(), {
        sessionId: 's1',
        userId: 'u1',
        agentId: 'a1',
        allowlist: ['127.0.0.1'],
        allowedIPs: ['127.0.0.1'],
        credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key' } },
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
      // The upstream is also no longer reachable because the allowlist is
      // gone — so the proxy returns 403 on CONNECT, which fetch surfaces
      // as a network error. That 403 IS the proof that the session-config
      // store no longer has the entry.
      await bus.call('proxy:close-session', ctx(), { sessionId: 's1' });

      const dispatcher2 = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
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
      // A 403 on CONNECT shows up as a fetch error from undici. Either way,
      // the upstream MUST NOT see a second request body with the real secret.
      // The first request already resolved gotRequest; the captured object
      // would be overwritten if a second body got through.
      expect(secondReqError).toBeDefined();
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
        { proxyEndpoint: string; caCertPem: string; envMap: Record<string, string> }
      >('proxy:open-session', ctx(), {
        sessionId: 's1',
        userId: 'u1',
        agentId: 'a1',
        allowlist: ['127.0.0.1'],
        allowedIPs: ['127.0.0.1'],
        credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key' } },
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
      const dispatcher2 = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
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
});
