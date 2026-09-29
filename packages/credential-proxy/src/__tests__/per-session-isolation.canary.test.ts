/**
 * TASK-158 canary — per-session egress isolation through the REAL plugin.
 *
 * `per-session-isolation.test.ts` proves the listener's gate with hand-built
 * session configs. This is the half-wired-window proof (invariant #3): two
 * users' sessions are opened through the actual `proxy:open-session` service,
 * each gets its own minted token back, and the token — not the host list — is
 * what decides whose allowlist governs a request. It also walks the two
 * operations the card's attack story relies on:
 *
 *   - "user A remembers a site" (`proxy:add-host`, the reactive egress wall):
 *     widening A's allowlist must not widen B's.
 *   - "A's session ends" (`proxy:close-session`): A's token stops working,
 *     B's is untouched.
 *
 * Both hosts resolve to loopback and the upstream binds dual-stack, so the
 * canary runs on any machine (`localhost` may resolve to ::1 or 127.0.0.1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as httpCreate, type Server as HTTPServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type Plugin,
  type KernelHandle,
} from '@ax/core';
import { createCredentialProxyPlugin, type HttpEgressEvent } from '../plugin.js';
import { connectStatus, rawConnect, viaHttpProxy, basicAuth } from './proxy-auth-helpers.js';

function memCredentialsPlugin(): Plugin {
  return {
    manifest: {
      name: '@test/mem-credentials',
      version: '0.0.0',
      registers: ['credentials:get'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<{ ref: string; userId: string }, string>(
        'credentials:get',
        '@test/mem-credentials',
        async () => {
          throw new Error('no credentials are seeded in this canary');
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

interface Opened {
  proxyEndpoint: string;
  proxyAuthToken: string;
}

const ctxFor = (userId: string, sessionId: string) =>
  makeAgentContext({ sessionId, agentId: 'agent', userId });

describe('TASK-158 canary — per-session egress isolation via the real plugin', () => {
  let caDir: string;
  let bus: HookBus;
  let kernel: KernelHandle | undefined;
  let upstream: HTTPServer | undefined;
  let upstreamHits: number;
  let upPort: number;
  let captured: HttpEgressEvent[];

  beforeEach(async () => {
    caDir = mkdtempSync(join(tmpdir(), 'proxy-isolation-canary-'));
    bus = new HookBus();
    kernel = undefined;
    captured = [];
    upstreamHits = 0;
    upstream = httpCreate((_req, res) => {
      upstreamHits++;
      res.end('upstream-ok');
    });
    // No host arg: bind dual-stack so BOTH 127.0.0.1 and localhost (::1 or v4) reach it.
    await new Promise<void>((r) => upstream!.listen(0, () => r()));
    upPort = (upstream.address() as AddressInfo).port;
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({ listen: { kind: 'tcp', host: '127.0.0.1', port: 0 }, caDir }),
        eventCapturePlugin(captured),
      ],
      config: {},
    });
  });

  afterEach(async () => {
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    if (kernel) await kernel.shutdown();
    rmSync(caDir, { recursive: true, force: true });
  });

  /** Open a session through the real service. `hostToAllow` is its whole allowlist. */
  async function open(userId: string, sessionId: string, hostToAllow: string): Promise<Opened> {
    return bus.call<unknown, Opened>('proxy:open-session', ctxFor(userId, sessionId), {
      sessionId,
      userId,
      agentId: 'agent',
      allowlist: [hostToAllow],
      credentials: {},
      // Loopback is a private IP; this is the test-only SSRF escape hatch.
      allowedIPs: ['127.0.0.1', '::1'],
    });
  }

  const portOf = (o: Opened): number => parseInt(o.proxyEndpoint.split(':').pop() as string, 10);
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('mints a distinct token per session, and the token decides whose allowlist applies', async () => {
    const a = await open('user-a', 'sess-a', '127.0.0.1');
    const b = await open('user-b', 'sess-b', 'localhost');
    expect(a.proxyAuthToken).toMatch(/^[0-9a-f]{32}$/);
    expect(b.proxyAuthToken).toMatch(/^[0-9a-f]{32}$/);
    expect(a.proxyAuthToken).not.toBe(b.proxyAuthToken);
    const port = portOf(a);

    // Each session reaches its OWN host…
    const aOwn = await viaHttpProxy(port, `http://127.0.0.1:${upPort}/`, basicAuth(a.proxyAuthToken));
    const bOwn = await viaHttpProxy(port, `http://localhost:${upPort}/`, basicAuth(b.proxyAuthToken));
    expect(aOwn.status).toBe(200);
    expect(bOwn.status).toBe(200);
    expect(upstreamHits).toBe(2);

    // …and NEITHER reaches the other's, in either direction, on plain HTTP…
    const aToB = await viaHttpProxy(port, `http://localhost:${upPort}/`, basicAuth(a.proxyAuthToken));
    const bToA = await viaHttpProxy(port, `http://127.0.0.1:${upPort}/`, basicAuth(b.proxyAuthToken));
    expect(aToB.status).toBe(403);
    expect(bToA.status).toBe(403);
    expect(upstreamHits).toBe(2); // the two refusals never touched the upstream

    // …nor on CONNECT (own host: tunnel granted; the other's: 403).
    expect((await connectStatus(port, rawConnect(`127.0.0.1:${upPort}`, a.proxyAuthToken))).status).toBe(200);
    expect((await connectStatus(port, rawConnect(`localhost:${upPort}`, a.proxyAuthToken))).status).toBe(403);
    expect((await connectStatus(port, rawConnect(`localhost:${upPort}`, b.proxyAuthToken))).status).toBe(200);
    expect((await connectStatus(port, rawConnect(`127.0.0.1:${upPort}`, b.proxyAuthToken))).status).toBe(403);

    // The deny events name the CALLING session, not the host's owner.
    await settle();
    const denies = captured.filter((e) => e.blockedReason === 'allowlist');
    expect(denies.map((e) => [e.sessionId, e.userId, e.host]).sort()).toEqual(
      [
        ['sess-a', 'user-a', 'localhost'],
        ['sess-a', 'user-a', 'localhost'],
        ['sess-b', 'user-b', '127.0.0.1'],
        ['sess-b', 'user-b', '127.0.0.1'],
      ].sort(),
    );
  });

  it('a request without a valid token is refused with a proxy-auth event (never attributed, never widened)', async () => {
    const a = await open('user-a', 'sess-a', '127.0.0.1');
    const port = portOf(a);

    const noToken = await viaHttpProxy(port, `http://127.0.0.1:${upPort}/`, undefined);
    const forged = await viaHttpProxy(port, `http://127.0.0.1:${upPort}/`, basicAuth('0'.repeat(32)));
    const connect = await connectStatus(port, rawConnect(`127.0.0.1:${upPort}`));

    expect(noToken.status).toBe(407);
    expect(forged.status).toBe(407);
    expect(connect.status).toBe(407);
    expect(upstreamHits).toBe(0);

    await settle();
    const authEvents = captured.filter((e) => e.blockedReason === 'proxy-auth');
    expect(authEvents).toHaveLength(3);
    for (const e of authEvents) {
      expect(e.sessionId).toBe('');
      expect(e.userId).toBe('');
      expect(e.status).toBe(407);
    }
    // The wall only raises "allow this site?" for allowlist misses — never for these.
    expect(captured.filter((e) => e.blockedReason === 'allowlist')).toHaveLength(0);
  });

  it("proxy:add-host (user A remembers a site) widens A only — B's reach is unchanged", async () => {
    const a = await open('user-a', 'sess-a', '127.0.0.1');
    const b = await open('user-b', 'sess-b', 'localhost');
    const port = portOf(a);

    // Before: A cannot reach B's host.
    expect((await viaHttpProxy(port, `http://localhost:${upPort}/`, basicAuth(a.proxyAuthToken))).status).toBe(403);

    // A's owner grants localhost to A's session (the same call the reactive wall makes).
    const added = await bus.call<unknown, { added: boolean }>(
      'proxy:add-host',
      ctxFor('user-a', 'sess-a'),
      { sessionId: 'sess-a', host: 'localhost' },
    );
    expect(added.added).toBe(true);

    // After: A reaches it — and B, who already owned it, is unaffected — but B still
    // cannot reach A's host just because A's session now allows two.
    expect((await viaHttpProxy(port, `http://localhost:${upPort}/`, basicAuth(a.proxyAuthToken))).status).toBe(200);
    expect((await viaHttpProxy(port, `http://localhost:${upPort}/`, basicAuth(b.proxyAuthToken))).status).toBe(200);
    expect((await viaHttpProxy(port, `http://127.0.0.1:${upPort}/`, basicAuth(b.proxyAuthToken))).status).toBe(403);

    // And the reverse: granting host X to A does not let a THIRD session that never asked for it in.
    const c = await open('user-c', 'sess-c', 'example.invalid');
    expect((await viaHttpProxy(port, `http://127.0.0.1:${upPort}/`, basicAuth(c.proxyAuthToken))).status).toBe(403);
    expect((await viaHttpProxy(port, `http://localhost:${upPort}/`, basicAuth(c.proxyAuthToken))).status).toBe(403);
  });

  it("proxy:close-session revokes that session's token and leaves the others alone", async () => {
    const a = await open('user-a', 'sess-a', '127.0.0.1');
    const b = await open('user-b', 'sess-b', 'localhost');
    const port = portOf(a);

    expect((await viaHttpProxy(port, `http://127.0.0.1:${upPort}/`, basicAuth(a.proxyAuthToken))).status).toBe(200);

    await bus.call('proxy:close-session', ctxFor('user-a', 'sess-a'), { sessionId: 'sess-a' });

    // A's stale token is now just an unknown token: refused on both paths.
    expect((await viaHttpProxy(port, `http://127.0.0.1:${upPort}/`, basicAuth(a.proxyAuthToken))).status).toBe(407);
    expect((await connectStatus(port, rawConnect(`127.0.0.1:${upPort}`, a.proxyAuthToken))).status).toBe(407);
    // B keeps working.
    expect((await viaHttpProxy(port, `http://localhost:${upPort}/`, basicAuth(b.proxyAuthToken))).status).toBe(200);
  });

  it('re-opening a session id mints a NEW token; the old one stops working', async () => {
    const first = await open('user-a', 'sess-a', '127.0.0.1');
    const port = portOf(first);
    const second = await open('user-a', 'sess-a', '127.0.0.1');

    expect(second.proxyAuthToken).not.toBe(first.proxyAuthToken);
    expect((await viaHttpProxy(port, `http://127.0.0.1:${upPort}/`, basicAuth(second.proxyAuthToken))).status).toBe(200);
    expect((await viaHttpProxy(port, `http://127.0.0.1:${upPort}/`, basicAuth(first.proxyAuthToken))).status).toBe(407);
  });
});
