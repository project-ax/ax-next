/**
 * Task 12 — full-stack acceptance test for `@ax/credential-proxy`.
 *
 * The single end-to-end test the plugin has to pass before it ships:
 * boot the kernel with mem-credentials + the proxy + an event capturer,
 * stand up a TLS upstream signed by the proxy's own CA, open a session,
 * send a real HTTPS request through the proxy with a placeholder
 * `Authorization` header, and assert the upstream received the
 * substituted real credential. Then close the session and prove a
 * subsequent request through the same dispatcher fails closed.
 *
 * If any prior task (CA management, MITM TLS termination, credential
 * substitution, allowlist gate, event emission, session lifecycle)
 * regressed, this test catches it. Per-task tests still cover the
 * fine-grained edge cases — this one proves they all work TOGETHER.
 *
 * Hostname strategy: we use `127.0.0.1` as the allowlist hostname (same
 * as the listener tests in Tasks 6/8 and egress-events.test.ts) instead
 * of the plan's symbolic `mock-llm.test`. Wiring a custom DNS resolver
 * through the plugin config just for one test would expand the plugin
 * surface for no real coverage gain — `127.0.0.1` exercises the same
 * MITM substitution path. The symbolic-hostname seam still exists at
 * the listener level (`ProxyListenerOptions.resolver`) and is covered
 * by listener tests that use it directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as tlsCreate, type Server as TLSServer } from 'node:tls';
import { ProxyAgent } from 'undici';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type Plugin,
  type KernelHandle,
} from '@ax/core';
import { generateDomainCert, getOrCreateCA, type CAKeyPair } from '../ca.js';
import { createCredentialProxyPlugin, type HttpEgressEvent } from '../plugin.js';

// ── Test helpers (same shape as plugin.test.ts / egress-events.test.ts) ──

/**
 * In-memory credentials plugin matching the current `@ax/credentials`
 * shape: `{ id } → { value }`. Phase 1b will reshape this to
 * `({ ref, userId }) → currentValue` — the proxy's hook surface doesn't
 * change either way.
 */
function memCredentialsPlugin(): Plugin {
  const store = new Map<string, string>();
  return {
    manifest: {
      name: '@test/mem-credentials',
      version: '0.0.0',
      registers: ['credentials:get', 'credentials:set'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<{ id: string; value: string }, void>(
        'credentials:set',
        '@test/mem-credentials',
        async (_ctx, { id, value }) => {
          store.set(id, value);
        },
      );
      bus.registerService<{ id: string }, { value: string }>(
        'credentials:get',
        '@test/mem-credentials',
        async (_ctx, { id }) => {
          const value = store.get(id);
          if (value === undefined) throw new Error(`no such credential: ${id}`);
          return { value };
        },
      );
    },
  };
}

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

interface CapturedTLS {
  authorization: string | undefined;
  body: string;
  path: string | undefined;
  method: string | undefined;
}

/**
 * TLS upstream signed by the proxy's CA — the proxy adds its CA to its
 * outbound trust store, so the chain validates cleanly. The upstream
 * captures the request's Authorization header + body so the test can
 * assert MITM substitution actually replaced the placeholder bytes.
 */
async function startCapturingTLSUpstream(ca: CAKeyPair): Promise<{
  port: number;
  captured: CapturedTLS;
  gotRequest: Promise<void>;
  close: () => Promise<void>;
}> {
  const leaf = generateDomainCert('127.0.0.1', ca);
  const captured: CapturedTLS = {
    authorization: undefined,
    body: '',
    path: undefined,
    method: undefined,
  };
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
      // Request line: METHOD PATH HTTP/1.1
      const reqLine = lines[0]!.split(' ');
      captured.method = reqLine[0];
      captured.path = reqLine[1];
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
        const responseBody = '{"id":"msg_1","content":"hello"}';
        sock.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${responseBody.length}\r\nConnection: close\r\n\r\n${responseBody}`,
        );
        sock.end();
        resolveReq();
      }
    });
    sock.on('error', () => {
      /* aborts expected on close */
    });
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
  return makeAgentContext({
    sessionId: 'acceptance-test-session',
    agentId: 'acceptance-test-agent',
    userId: 'acceptance-test-user',
  });
}

// ── The single end-to-end acceptance test ────────────────────────────

describe('credential-proxy acceptance (Phase 1a Task 12)', () => {
  let caDir: string;
  let bus: HookBus;
  let kernel: KernelHandle | undefined;
  let captured: HttpEgressEvent[];

  beforeEach(() => {
    caDir = mkdtempSync(join(tmpdir(), 'proxy-acceptance-'));
    bus = new HookBus();
    kernel = undefined;
    captured = [];
  });

  afterEach(async () => {
    if (kernel) await kernel.shutdown();
    rmSync(caDir, { recursive: true, force: true });
  });

  it('substitutes credentials end-to-end and blocks after close-session', async () => {
    // 1. Pre-mint the CA so the upstream cert chains to it. Bootstrap
    //    will see it on disk and reuse it instead of generating a new one.
    const ca = await getOrCreateCA(caDir);
    const upstream = await startCapturingTLSUpstream(ca);

    try {
      // 2. Bootstrap the kernel with mem-credentials + the proxy + the
      //    event-capture plugin. Plugins load in order; the proxy needs
      //    `credentials:get` registered before its open-session handler
      //    fires, so mem-credentials goes first.
      kernel = await bootstrap({
        bus,
        plugins: [
          memCredentialsPlugin(),
          createCredentialProxyPlugin({
            listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
            caDir,
          }),
          eventCapturePlugin(captured),
        ],
        config: {},
      });

      // 3. Stash the real secret in the in-memory credentials store.
      await bus.call('credentials:set', ctx(), {
        id: 'anthropic',
        value: 'sk-real-secret',
      });

      // 4. Open a proxy session. The plugin resolves `anthropic` via
      //    `credentials:get`, mints a placeholder for it, and returns
      //    everything the bridge would hand a sandboxed agent: where to
      //    point HTTPS_PROXY, which CA to trust, and the env-var map.
      const opened = await bus.call<
        unknown,
        { proxyEndpoint: string; caCertPem: string; envMap: Record<string, string> }
      >('proxy:open-session', ctx(), {
        sessionId: 'acceptance-s1',
        userId: 'acceptance-u1',
        agentId: 'acceptance-a1',
        // 127.0.0.1 instead of `mock-llm.test` — see file-header note.
        allowlist: ['127.0.0.1'],
        // The private-IP block fires for 127.0.0.1 unless it's explicitly
        // exempted via allowedIPs (test-only escape hatch).
        allowedIPs: ['127.0.0.1'],
        credentials: {
          ANTHROPIC_API_KEY: { ref: 'anthropic', kind: 'api-key' },
        },
      });

      const proxyPort = parseInt(opened.proxyEndpoint.split(':').pop()!, 10);
      const placeholder = opened.envMap.ANTHROPIC_API_KEY!;
      // Sanity: the placeholder is opaque (not the real secret). If this
      // ever fails, the registry stopped masking — that's a critical bug.
      expect(placeholder).toMatch(/^ax-cred:[0-9a-f]{32}$/);
      expect(placeholder).not.toBe('sk-real-secret');
      expect(opened.caCertPem).toContain('-----BEGIN CERTIFICATE-----');

      // 5. Configure undici to route through the proxy and trust the
      //    CA returned by open-session — exactly what the bridge will
      //    do for sandboxed processes.
      const dispatcher = new ProxyAgent({
        uri: `http://127.0.0.1:${proxyPort}`,
        requestTls: { ca: opened.caCertPem },
      });

      // 6. POST through the proxy with the PLACEHOLDER in the auth
      //    header. The proxy's MITM path should swap it for the real
      //    secret before forwarding upstream.
      const res = await fetch(`https://127.0.0.1:${upstream.port}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${placeholder}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: 'hello' }),
        dispatcher,
      } as RequestInit);

      // 7. Round-trip checks.
      expect(res.status).toBe(200);
      const respBody = await res.json();
      expect(respBody).toEqual({ id: 'msg_1', content: 'hello' });

      await upstream.gotRequest;
      expect(upstream.captured.method).toBe('POST');
      expect(upstream.captured.path).toBe('/v1/messages');
      // THE assertion: the placeholder must have been substituted.
      expect(upstream.captured.authorization).toBe('Bearer sk-real-secret');
      expect(upstream.captured.body).toBe('{"prompt":"hello"}');

      // 8. Exactly one `event.http-egress` should have fired, with
      //    `classification: 'llm'` (api-key kind), `credentialInjected:
      //    true` (substitution actually happened), and the right host.
      //    The MITM cleanup runs on socket close — poll a bounded number
      //    of microtasks rather than racing on a fixed sleep.
      for (let i = 0; i < 100 && captured.length === 0; i++) {
        await new Promise<void>((r) => setImmediate(r));
      }
      expect(captured.length).toBe(1);
      const ev = captured[0]!;
      expect(ev.sessionId).toBe('acceptance-s1');
      expect(ev.userId).toBe('acceptance-u1');
      expect(ev.method).toBe('CONNECT');
      expect(ev.host).toBe('127.0.0.1');
      expect(ev.status).toBe(200);
      expect(ev.classification).toBe('llm');
      expect(ev.credentialInjected).toBe(true);
      expect(ev.blockedReason).toBeUndefined();

      // 9. Close the session. The plugin should drop both the registry
      //    entry (no more substitution) and the session config (no more
      //    allowlist match → next request 403s).
      await bus.call('proxy:close-session', ctx(), { sessionId: 'acceptance-s1' });

      // 10. Subsequent request through the same dispatcher must fail
      //     closed. With the session gone, the hostname is no longer in
      //     any allowlist → CONNECT returns 403 → undici surfaces this
      //     either as a non-2xx response or a fetch error depending on
      //     how it interprets the proxy reply. Accept either; what
      //     matters is that the request did NOT reach the upstream.
      const upstreamHitsBefore = captured.length;
      let postCloseStatus: number | undefined;
      let postCloseError: unknown;
      try {
        const res2 = await fetch(`https://127.0.0.1:${upstream.port}/v1/messages`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${placeholder}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ prompt: 'should-be-blocked' }),
          dispatcher,
        } as RequestInit);
        postCloseStatus = res2.status;
        // Drain to avoid leaking the response.
        await res2.arrayBuffer().catch(() => undefined);
      } catch (err) {
        postCloseError = err;
      }
      // Either undici threw on the failed CONNECT, or it surfaced a
      // non-2xx status. Both prove the request was blocked.
      const blocked = postCloseError !== undefined || (postCloseStatus !== undefined && postCloseStatus >= 400);
      expect(blocked).toBe(true);

      // The upstream must NOT have seen the second request — its captured
      // body should still be the first request's body. (gotRequest already
      // resolved on the first; checking method/body suffices.)
      expect(upstream.captured.body).toBe('{"prompt":"hello"}');

      // The post-close blocked attempt also fires an `event.http-egress`
      // with `blockedReason: 'allowlist'`. Wait for it the same bounded
      // way as before — it fires from the listener's CONNECT-allowlist
      // path on the next event-loop tick.
      for (let i = 0; i < 100 && captured.length === upstreamHitsBefore; i++) {
        await new Promise<void>((r) => setImmediate(r));
      }
      expect(captured.length).toBeGreaterThan(upstreamHitsBefore);
      const blockEv = captured[captured.length - 1]!;
      expect(blockEv.blockedReason).toBe('allowlist');
      expect(blockEv.status).toBe(403);
    } finally {
      await upstream.close();
    }
  });
});
