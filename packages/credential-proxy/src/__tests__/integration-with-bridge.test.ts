/**
 * Task 17 — end-to-end integration test (proxy + bridge + mock LLM).
 *
 * This is the Phase 1a verification criterion from the design doc Section 7:
 * "integration test stands up a proxy listener, sends a mock HTTPS request,
 * confirms cert minting + substitution + audit event."
 *
 * Unlike the listener-level tests (which talk to the proxy directly via
 * TCP) and acceptance.test.ts (which routes undici → proxy via TCP), this
 * test exercises the full Phase 1a wire path that a real sandbox would use:
 *
 *   client (undici)
 *     ↓ HTTP-proxy on 127.0.0.1:<bridge.port>
 *   @ax/credential-proxy-bridge (TCP listener)
 *     ↓ Unix-socket forward
 *   @ax/credential-proxy host listener (Unix socket)
 *     ↓ MITM TLS termination + credential substitution + allowlist gate
 *   mock TLS upstream signed by the proxy's CA
 *
 * If any link in that chain regressed — bridge socket forwarding, the
 * Unix-socket listener, MITM cert minting, placeholder substitution, or
 * the bus event emission — this test catches it.
 *
 * The test ALSO proves the two packages compose end-to-end: the bridge is
 * imported as a workspace devDependency and the same Unix socket the proxy
 * binds is what the bridge connects to.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
import { startWebProxyBridge, type WebProxyBridge } from '@ax/credential-proxy-bridge';
import { generateDomainCert, getOrCreateCA, type CAKeyPair } from '../ca.js';
import { createCredentialProxyPlugin, type HttpEgressEvent } from '../plugin.js';

// ── Test helpers (same shapes as acceptance.test.ts / egress-events.test.ts) ──

/** In-memory credentials plugin matching the current `{id} → {value}` shape. */
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
 * TLS upstream signed by the proxy's CA. The proxy adds its own CA to the
 * outbound trust store, so the chain validates without rejectUnauthorized
 * gymnastics. Captures the first request's auth header + body so we can
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
        const respBody = '{"id":"msg_1","content":"hello"}';
        sock.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${respBody.length}\r\nConnection: close\r\n\r\n${respBody}`,
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
    sessionId: 'integration-test-session',
    agentId: 'integration-test-agent',
    userId: 'integration-test-user',
  });
}

// ── The end-to-end integration test ──────────────────────────────────

describe('credential-proxy + bridge end-to-end (Phase 1a Task 17)', () => {
  let workDir: string;
  let socketPath: string;
  let caDir: string;
  let bus: HookBus;
  let kernel: KernelHandle | undefined;
  let bridge: WebProxyBridge | undefined;
  let upstream: { close: () => Promise<void> } | undefined;
  let captured: HttpEgressEvent[];

  beforeEach(() => {
    // One tmpdir holds both the CA material and the Unix socket. Per-test
    // isolation — no risk of stomping a parallel run's socket.
    workDir = mkdtempSync(join(tmpdir(), 'proxy-bridge-int-'));
    socketPath = join(workDir, 'proxy.sock');
    caDir = join(workDir, 'ca');
    bus = new HookBus();
    kernel = undefined;
    bridge = undefined;
    upstream = undefined;
    captured = [];
  });

  afterEach(async () => {
    // Tear down in reverse start order so nothing tries to send into a
    // half-closed downstream. Each cleanup is best-effort — a regression
    // in one shouldn't leak the others.
    if (bridge) {
      try {
        bridge.stop();
      } catch {
        /* ignore */
      }
    }
    if (upstream) {
      try {
        await upstream.close();
      } catch {
        /* ignore */
      }
    }
    if (kernel) {
      try {
        await kernel.shutdown();
      } catch {
        /* ignore */
      }
    }
    // Belt-and-braces: the listener should unlink the socket on stop, but
    // if shutdown threw, rmSync of the workDir below still cleans it up.
    if (existsSync(socketPath)) {
      try {
        rmSync(socketPath, { force: true });
      } catch {
        /* ignore */
      }
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('substitutes credentials end-to-end through bridge → unix socket → proxy → upstream', async () => {
    // 1. Pre-mint the CA so we can sign the upstream cert with the same
    //    CA the proxy will use. bootstrap() finds it on disk and reuses it.
    const ca = await getOrCreateCA(caDir);
    upstream = await startCapturingTLSUpstream(ca);
    const upstreamPort = (upstream as { port: number }).port;

    // 2. Bootstrap the host: mem-credentials first (proxy:open-session
    //    needs credentials:get registered before it fires), then the proxy
    //    listening on a UNIX SOCKET (the wire shape sandboxes use), then
    //    the event-capture subscriber.
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({
          listen: { kind: 'unix', path: socketPath },
          caDir,
        }),
        eventCapturePlugin(captured),
      ],
      config: {},
    });

    // 3. Stash the real secret.
    await bus.call('credentials:set', ctx(), {
      id: 'r1',
      value: 'sk-real',
    });

    // 4. Open a proxy session — same shape the agent-runner plugin will
    //    use in Phase 1b. Allowlist 127.0.0.1 (where the upstream is) and
    //    exempt it from the private-IP block (test-only escape hatch).
    const opened = await bus.call<
      unknown,
      { proxyEndpoint: string; caCertPem: string; envMap: Record<string, string> }
    >('proxy:open-session', ctx(), {
      sessionId: 'int-s1',
      userId: 'int-u1',
      agentId: 'int-a1',
      allowlist: ['127.0.0.1'],
      allowedIPs: ['127.0.0.1'],
      credentials: {
        ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key' },
      },
    });

    // The endpoint should be the unix:// form — proves the plugin honored
    // our listen.kind: 'unix' config.
    expect(opened.proxyEndpoint).toBe(`unix://${socketPath}`);
    const placeholder = opened.envMap.ANTHROPIC_API_KEY!;
    expect(placeholder).toMatch(/^ax-cred:[0-9a-f]{32}$/);
    expect(placeholder).not.toBe('sk-real');

    // 5. Stand up the bridge in the SAME process, pointed at the proxy's
    //    Unix socket. From the client's POV the bridge is a regular
    //    HTTP proxy on 127.0.0.1:<port>; under the hood it tunnels every
    //    byte through the Unix socket to the host listener.
    bridge = await startWebProxyBridge(socketPath);
    expect(bridge.port).toBeGreaterThan(0);

    // 6. POST an HTTPS request through the bridge. ProxyAgent.uri points
    //    at the BRIDGE's TCP port — not the host listener directly —
    //    so we exercise the full chain. requestTls.ca trusts the CA the
    //    proxy returned via open-session (which is the same CA that
    //    signed the upstream leaf, so the MITM-minted leaf for 127.0.0.1
    //    chains cleanly).
    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${bridge.port}`,
      requestTls: { ca: opened.caCertPem },
    });

    const res = await fetch(`https://127.0.0.1:${upstreamPort}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${placeholder}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'hello' }),
      dispatcher,
    } as RequestInit);

    // 7. Round-trip checks: the response made it back through the chain.
    expect(res.status).toBe(200);
    const respBody = await res.json();
    expect(respBody).toEqual({ id: 'msg_1', content: 'hello' });

    // 8. THE substitution assertion: the upstream MUST see the real secret,
    //    not the placeholder. If MITM credential substitution regressed,
    //    this is where it shows up.
    await upstream.gotRequest;
    expect((upstream as { captured: CapturedTLS }).captured.method).toBe('POST');
    expect((upstream as { captured: CapturedTLS }).captured.path).toBe('/v1/messages');
    expect((upstream as { captured: CapturedTLS }).captured.authorization).toBe(
      'Bearer sk-real',
    );
    expect((upstream as { captured: CapturedTLS }).captured.authorization).not.toContain(
      'ax-cred:',
    );
    expect((upstream as { captured: CapturedTLS }).captured.body).toBe('{"prompt":"hello"}');

    // 9. THE event assertion: exactly one event.http-egress fires, with
    //    classification 'llm' (api-key kind), credentialInjected: true,
    //    status: 200. The audit emit happens on socket close from the
    //    listener — poll a bounded number of microtasks rather than
    //    racing on a fixed sleep.
    for (let i = 0; i < 100 && captured.length === 0; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(captured.length).toBe(1);
    const ev = captured[0]!;
    expect(ev.sessionId).toBe('int-s1');
    expect(ev.userId).toBe('int-u1');
    expect(ev.method).toBe('CONNECT');
    expect(ev.host).toBe('127.0.0.1');
    expect(ev.status).toBe(200);
    expect(ev.classification).toBe('llm');
    expect(ev.credentialInjected).toBe(true);
    expect(ev.blockedReason).toBeUndefined();
  });
});
