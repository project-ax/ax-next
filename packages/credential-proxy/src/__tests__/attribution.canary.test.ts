/**
 * TASK-52 attribution canary — end-to-end proof of the per-session proxy
 * token.
 *
 * This is the half-wired-window proof (invariant #3): the token is minted
 * (`proxy:open-session`) → carried into the request as `Proxy-Authorization:
 * Basic ax:<token>` → parsed by the listener → stamped onto the BLOCKED
 * (allowlist-miss) audit → emitted on `event.http-egress` with a REAL
 * `sessionId`/`userId`. Before TASK-52 that `sessionId` was the empty string;
 * proving it carries the session is the whole point of this card. The
 * immediate consumer is `@ax/audit-log`, which already subscribes to
 * `event.http-egress` and persists each entry — so this is NOT dead code.
 *
 * The companion case proves the security posture (TASK-158): a request with NO
 * token is REFUSED outright (407) before anything else runs — it never reaches
 * the upstream — and the refusal is audited as `blockedReason: 'proxy-auth'`
 * with an empty sessionId/userId (there is no session to attribute it to).
 * A missing token never widens egress and never borrows another session's.
 *
 * Self-contained (mirrors egress-events.test.ts's helper shapes) so the canary
 * is reachable on its own.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as httpCreate, request as httpRequest, type Server as HTTPServer } from 'node:http';
import { ProxyAgent } from 'undici';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type Plugin,
  type KernelHandle,
} from '@ax/core';
import { createCredentialProxyPlugin, type HttpEgressEvent } from '../plugin.js';
import { basicAuth } from './proxy-auth-helpers.js';

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

function ctx() {
  return makeAgentContext({ sessionId: 'test-session', agentId: 'test-agent', userId: 'test-user' });
}

interface OpenResult {
  proxyEndpoint: string;
  proxyAuthToken: string;
}

describe('TASK-52 attribution canary', () => {
  let caDir: string;
  let bus: HookBus;
  let kernel: KernelHandle | undefined;
  let upstream: HTTPServer | undefined;

  beforeEach(() => {
    caDir = mkdtempSync(join(tmpdir(), 'proxy-canary-'));
    bus = new HookBus();
    kernel = undefined;
  });

  afterEach(async () => {
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    if (kernel) await kernel.shutdown();
    rmSync(caDir, { recursive: true, force: true });
    upstream = undefined;
  });

  async function boot(captured: HttpEgressEvent[]): Promise<void> {
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
  }

  it('per-session token attributes a blocked egress to its session on event.http-egress', async () => {
    upstream = httpCreate((_req, res) => res.end('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const captured: HttpEgressEvent[] = [];
    await boot(captured);

    // Open a session whose allowlist EXCLUDES 127.0.0.1 → the request below
    // is an allowlist miss (403) against that session's own allowlist. The
    // token is what identifies (and so attributes) the caller.
    const open = await bus.call<unknown, OpenResult>('proxy:open-session', ctx(), {
      sessionId: 's1',
      userId: 'u1',
      agentId: 'a1',
      allowlist: ['allowed.example.com'],
      credentials: {},
    });
    expect(open.proxyAuthToken).toMatch(/^[0-9a-f]{32}$/);

    const proxyPort = parseInt(open.proxyEndpoint.split(':').pop()!, 10);
    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${proxyPort}`,
      proxyTunnel: false,
      token: basicAuth(open.proxyAuthToken),
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    expect(res.status).toBe(403);

    // The subscriber callback is async — give it a tick to fire.
    await new Promise<void>((r) => setImmediate(r));
    const block = captured.find((a) => a.blockedReason === 'allowlist');
    expect(block).toBeDefined();
    // Attribution: before TASK-52 this was '' — the whole point of the card.
    expect(block!.sessionId).toBe('s1');
    expect(block!.userId).toBe('u1');
  });

  it('a request with NO token is refused 407, never reaches the upstream, and is audited as proxy-auth (never widens)', async () => {
    let upstreamHits = 0;
    upstream = httpCreate((_req, res) => {
      upstreamHits++;
      res.end('SHOULD NOT REACH');
    });
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const captured: HttpEgressEvent[] = [];
    await boot(captured);

    // Even a session that WOULD allow the host must not help a caller that
    // carries no token: the allowlist is per-session, never global.
    const open = await bus.call<unknown, OpenResult>('proxy:open-session', ctx(), {
      sessionId: 's1',
      userId: 'u1',
      agentId: 'a1',
      allowlist: ['127.0.0.1'],
      allowedIPs: ['127.0.0.1'],
      credentials: {},
    });
    const proxyPort = parseInt(open.proxyEndpoint.split(':').pop()!, 10);

    // A raw HTTP-proxy request with NO Proxy-Authorization header. (undici's
    // ProxyAgent throws on a 407 instead of surfacing it, so talk to the proxy
    // directly to observe the actual status.)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: `http://127.0.0.1:${upPort}/`,
          headers: { Host: `127.0.0.1:${upPort}` },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    // Refused at the door — a missing token NEVER widens egress.
    expect(status).toBe(407);
    expect(upstreamHits).toBe(0);

    await new Promise<void>((r) => setImmediate(r));
    const block = captured.find((a) => a.blockedReason === 'proxy-auth');
    expect(block).toBeDefined();
    expect(block!.status).toBe(407);
    // Unattributed: no token resolved to a session, so the plugin maps the
    // missing attribution to the empty string.
    expect(block!.sessionId).toBe('');
    expect(block!.userId).toBe('');
    // It is NOT reported as an allowlist miss (no session's policy was consulted).
    expect(captured.some((a) => a.blockedReason === 'allowlist')).toBe(false);
  });
});
