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
 * The companion case proves the security posture: a blocked request with NO
 * token stays blocked (the missing token never widens egress) and simply
 * isn't attributed — degrading to today's behavior, never to wider reach.
 *
 * Self-contained (mirrors egress-events.test.ts's helper shapes) so the canary
 * is reachable on its own.
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
    // is an allowlist miss (403) that matches NO session via findAllowing-
    // Session. The token is the only attribution path.
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
      token: 'Basic ' + Buffer.from('ax:' + open.proxyAuthToken).toString('base64'),
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

  it('a blocked egress with NO token stays unattributed (degrade, never widen)', async () => {
    upstream = httpCreate((_req, res) => res.end('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const captured: HttpEgressEvent[] = [];
    await boot(captured);

    await bus.call<unknown, OpenResult>('proxy:open-session', ctx(), {
      sessionId: 's1',
      userId: 'u1',
      agentId: 'a1',
      allowlist: ['allowed.example.com'],
      credentials: {},
    });

    const proxyPort = await (async () => {
      const open = await bus.call<unknown, OpenResult>('proxy:open-session', ctx(), {
        sessionId: 's2',
        userId: 'u2',
        agentId: 'a2',
        allowlist: ['allowed.example.com'],
        credentials: {},
      });
      return parseInt(open.proxyEndpoint.split(':').pop()!, 10);
    })();

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${proxyPort}`,
      proxyTunnel: false,
      // No token at all.
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    // Still blocked — token absence NEVER widens egress.
    expect(res.status).toBe(403);

    await new Promise<void>((r) => setImmediate(r));
    const block = captured.find((a) => a.blockedReason === 'allowlist');
    expect(block).toBeDefined();
    // Unattributed: the plugin maps an unmatched session to the empty string.
    expect(block!.sessionId).toBe('');
  });
});
