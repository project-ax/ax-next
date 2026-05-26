/**
 * TASK-37 reactive-wall canary — end-to-end proof of the live allowlist
 * widening (invariant #3: no half-wired surface).
 *
 * The full reactive loop, through the REAL listener:
 *   1. Open a session with a per-session token (TASK-52) and an allowlist that
 *      EXCLUDES the upstream. A request carrying the token is an allowlist-miss
 *      → 403, attributed to the session on event.http-egress (the orchestrator
 *      keys the host-grant card off this).
 *   2. The owner grants the host LIVE via proxy:add-host — no re-spawn, no new
 *      session.
 *   3. The retry now passes the allowlist gate (no longer a domain_denied 403),
 *      proving the widened host landed on the live allowlist Set the listener
 *      reads by reference.
 *
 * The immediate production caller of proxy:add-host is the channel-web grant
 * route (POST /api/chat/allow-host); this canary exercises the hook directly,
 * the route test (routes-allow-host.test.ts) covers the HTTP boundary, and the
 * orchestrator test covers the card-surfacing — together the surface is fully
 * wired.
 *
 * Self-contained (mirrors attribution.canary.test.ts's helper shapes).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as httpCreate, type Server as HTTPServer } from 'node:http';
import { ProxyAgent } from 'undici';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type Plugin,
  type KernelHandle,
} from '@ax/core';
import { createCredentialProxyPlugin, type HttpEgressEvent } from '../plugin.js';

// In-memory credentials plugin (same shape as the other proxy tests).
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

// Captures every event.http-egress payload onto a shared array.
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

function ctx(userId: string) {
  return makeAgentContext({ sessionId: 'test-session', agentId: 'test-agent', userId });
}

interface OpenResult {
  proxyEndpoint: string;
  proxyAuthToken: string;
}

describe('TASK-37 reactive-wall canary', () => {
  let caDir: string;
  let bus: HookBus;
  let kernel: KernelHandle | undefined;
  let upstream: HTTPServer | undefined;

  beforeEach(() => {
    caDir = mkdtempSync(join(tmpdir(), 'reactive-wall-'));
    bus = new HookBus();
    kernel = undefined;
  });

  afterEach(async () => {
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    if (kernel) await kernel.shutdown();
    rmSync(caDir, { recursive: true, force: true });
    upstream = undefined;
  });

  it('attributed block → proxy:add-host widens live → retry passes the allowlist gate (no re-spawn)', async () => {
    upstream = httpCreate((_req, res) => res.end('OK'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const captured: HttpEgressEvent[] = [];
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({ listen: { kind: 'tcp', host: '127.0.0.1', port: 0 }, caDir }),
        eventCapturePlugin(captured),
      ],
      config: {},
    });

    // Allowlist EXCLUDES 127.0.0.1 → the request below is an allowlist miss
    // (the ONLY gate that blocks it). allowedIPs lets the loopback upstream
    // through the private-IP SSRF gate, so once the allowlist is widened the
    // retry actually reaches the upstream — isolating THIS card's effect (the
    // allowlist widening) from the orthogonal SSRF gate. The test-only
    // allowedIPs escape hatch is the same one the other listener tests use to
    // reach a 127.0.0.1 upstream.
    const open = await bus.call<unknown, OpenResult>('proxy:open-session', ctx('u1'), {
      sessionId: 's1',
      userId: 'u1',
      agentId: 'a1',
      allowlist: ['allowed.example.com'],
      allowedIPs: ['127.0.0.1'],
      credentials: {},
    });
    expect(open.proxyAuthToken).toMatch(/^[0-9a-f]{32}$/);

    const proxyPort = parseInt(open.proxyEndpoint.split(':').pop()!, 10);
    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${proxyPort}`,
      proxyTunnel: false,
      token: 'Basic ' + Buffer.from('ax:' + open.proxyAuthToken).toString('base64'),
    });

    // 1) Blocked request carrying the token → 403, attributed to s1 (TASK-52).
    const r1 = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    expect(r1.status).toBe(403);
    await new Promise<void>((res) => setImmediate(res));
    const block = captured.find(
      (a) => a.blockedReason === 'allowlist' && a.host === '127.0.0.1',
    );
    expect(block).toBeDefined();
    expect(block!.sessionId).toBe('s1');

    // 2) Owner grants the host LIVE — no re-spawn, same session.
    const grant = await bus.call<{ sessionId: string; host: string }, { added: boolean }>(
      'proxy:add-host',
      ctx('u1'),
      { sessionId: 's1', host: '127.0.0.1' },
    );
    expect(grant).toEqual({ added: true });

    // 3) Retry now passes the allowlist gate — no longer a domain_denied 403.
    const r2 = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    expect(r2.status).not.toBe(403);
    expect(r2.status).toBe(200);
    // And the second egress audit is NOT an allowlist block for 127.0.0.1.
    await new Promise<void>((res) => setImmediate(res));
    const allowlistBlocks = captured.filter(
      (a) => a.blockedReason === 'allowlist' && a.host === '127.0.0.1',
    );
    expect(allowlistBlocks).toHaveLength(1); // only the first request was blocked
  });
});
