/**
 * TASK-1199 — `proxy:drain-session-allowed-hosts`: the hosts a person allowed
 * on a LIVE session since the runner last asked.
 *
 * `proxy:add-host` (a person's own click: web "Allow access" or a Slack host
 * prompt) widens the session's live allowlist. It also records the host, once,
 * for that session, and the runner drains the record at the start of the
 * person's next turn so the agent learns the host is now allowed. These tests
 * pin the record's rules through the bus contract (the plugin's state is
 * private, the same posture as plugin.test.ts's add-host block):
 *
 *   - only a host that was NOT already on the live allowlist is recorded, so a
 *     double click, web plus Slack, or a stale card tells the agent once;
 *   - only the session's owner records (the add-host ownership gate);
 *   - the drain is surface-once, in grant order, and keyed ONLY by
 *     ctx.sessionId (another session, even the same person's, sees nothing);
 *   - closing the session forgets the record.
 *
 * The through-the-listener proof (block, allow, drain, the retry passes) is in
 * reactive-wall.canary.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
  type KernelHandle,
} from '@ax/core';
import { createCredentialProxyPlugin } from '../plugin.js';

// In-memory credentials plugin (same shape as the other proxy tests). The
// sessions here carry no credentials; open-session still declares the call.
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

interface AddHostOutput {
  added: boolean;
  agentId?: string;
}

describe('proxy:drain-session-allowed-hosts (TASK-1199)', () => {
  let caDir: string;
  let bus: HookBus;
  let kernel: KernelHandle | undefined;

  // One CA for the file: getOrCreateCA reuses it, and generating a 2048-bit
  // key per test buys nothing here (no listener traffic).
  beforeAll(() => {
    caDir = mkdtempSync(join(tmpdir(), 'allowed-hosts-drain-'));
  });

  afterAll(() => {
    rmSync(caDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    bus = new HookBus();
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({ listen: { kind: 'tcp', host: '127.0.0.1', port: 0 }, caDir }),
      ],
      config: {},
    });
  });

  afterEach(async () => {
    if (kernel) await kernel.shutdown();
    kernel = undefined;
  });

  // The person's own request context (the channel-web route, a Slack click).
  // Its sessionId is NOT the runner session: add-host takes the session from
  // its input, and the owner from ctx.userId.
  function personCtx(userId: string): AgentContext {
    return makeAgentContext({ sessionId: 'person-request', agentId: 'a1', userId });
  }

  // The runner's context. Over IPC, ctx.sessionId is bearer-bound, so it IS
  // the session being drained.
  function sessionCtx(sessionId: string): AgentContext {
    return makeAgentContext({ sessionId, agentId: 'a1', userId: 'u1' });
  }

  async function openSession(sessionId: string, userId = 'u1'): Promise<void> {
    await bus.call('proxy:open-session', personCtx(userId), {
      sessionId,
      userId,
      agentId: 'a1',
      allowlist: ['allowed.example.com'],
      credentials: {},
    });
  }

  function addHost(sessionId: string, host: string, userId = 'u1'): Promise<AddHostOutput> {
    return bus.call<{ sessionId: string; host: string }, AddHostOutput>(
      'proxy:add-host',
      personCtx(userId),
      { sessionId, host },
    );
  }

  function drain(sessionId: string): Promise<{ hosts: string[] }> {
    return bus.call<Record<string, never>, { hosts: string[] }>(
      'proxy:drain-session-allowed-hosts',
      sessionCtx(sessionId),
      {},
    );
  }

  it('A1: a host added to a live session is drained once', async () => {
    await openSession('s1');
    expect(await addHost('s1', 'new.example.com')).toEqual({ added: true, agentId: 'a1' });
    expect(await drain('s1')).toEqual({ hosts: ['new.example.com'] });
    // Surface-once: the drain cleared it.
    expect(await drain('s1')).toEqual({ hosts: [] });
  });

  it('A1b: several hosts allowed in one gap come back once each, in grant order', async () => {
    await openSession('s1');
    await addHost('s1', 'b.example.com');
    await addHost('s1', 'a.example.com');
    expect(await drain('s1')).toEqual({ hosts: ['b.example.com', 'a.example.com'] });
  });

  it('A2: a host already on the live allowlist is still "added" but records nothing', async () => {
    await openSession('s1');
    // The add-host answer is unchanged for a host that was already there...
    expect(await addHost('s1', 'allowed.example.com')).toEqual({ added: true, agentId: 'a1' });
    // ...but the agent is not told about a host it could already reach.
    expect(await drain('s1')).toEqual({ hosts: [] });
  });

  it('A3: allowing the same host twice (double click, web plus Slack) records it once', async () => {
    await openSession('s1');
    await addHost('s1', 'new.example.com');
    await addHost('s1', 'new.example.com');
    expect(await drain('s1')).toEqual({ hosts: ['new.example.com'] });
  });

  it('A3b: a stale Allow after the drain does not tell the agent again', async () => {
    await openSession('s1');
    await addHost('s1', 'new.example.com');
    expect(await drain('s1')).toEqual({ hosts: ['new.example.com'] });
    // An old card for the same host, clicked after the agent was told.
    expect(await addHost('s1', 'new.example.com')).toEqual({ added: true, agentId: 'a1' });
    expect(await drain('s1')).toEqual({ hosts: [] });
  });

  it('A4: an Allow for an unknown or closed session records nothing', async () => {
    expect(await addHost('s-gone', 'new.example.com')).toEqual({ added: false });
    expect(await drain('s-gone')).toEqual({ hosts: [] });
  });

  it("A5: an Allow from someone who doesn't own the session is refused and records nothing", async () => {
    await openSession('s1');
    let caught: unknown;
    try {
      await addHost('s1', 'new.example.com', 'u2');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('forbidden');
    expect(await drain('s1')).toEqual({ hosts: [] });
  });

  it("A6: the drain reads only ctx.sessionId's record (another session, even the same person's, sees nothing)", async () => {
    await openSession('s1');
    await openSession('s2');
    await addHost('s1', 'new.example.com');
    expect(await drain('s2')).toEqual({ hosts: [] });
    // s2's drain did not consume s1's record.
    expect(await drain('s1')).toEqual({ hosts: ['new.example.com'] });
  });

  it('A7: closing the session forgets its record', async () => {
    await openSession('s1');
    await addHost('s1', 'new.example.com');
    await bus.call('proxy:close-session', personCtx('u1'), { sessionId: 's1' });
    expect(await drain('s1')).toEqual({ hosts: [] });
  });

  it('A8: an empty ctx.sessionId drains nothing', async () => {
    await openSession('s1');
    await addHost('s1', 'new.example.com');
    expect(await drain('')).toEqual({ hosts: [] });
    // And it did not consume a real session's record either.
    expect(await drain('s1')).toEqual({ hosts: ['new.example.com'] });
  });
});

/**
 * TASK-1212 — a site kept while the agent wasn't running (a late Allow: a
 * day-old Slack prompt, a web "Always" after the session ended) reaches the
 * agent's next session. The orchestrator names those sites in
 * `proxy:open-session`'s `newlyAllowedHosts`, and the proxy seeds the same
 * TASK-1199 record a live `proxy:add-host` writes, so the runner's first drain
 * opens the turn with the "now allowed" line.
 *
 * The field GRANTS NOTHING: only `allowlist` decides what the session reaches.
 * The proxy reports a host only when it is a string, a real hostname
 * (HOST_RE) and on this session's own allowlist, so the line never names a
 * host the session can't reach, and never carries arbitrary text into the
 * model's context.
 */
describe('proxy:open-session newlyAllowedHosts (TASK-1212)', () => {
  let caDir: string;
  let bus: HookBus;
  let kernel: KernelHandle | undefined;

  beforeAll(() => {
    caDir = mkdtempSync(join(tmpdir(), 'newly-allowed-hosts-'));
  });

  afterAll(() => {
    rmSync(caDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    bus = new HookBus();
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(),
        createCredentialProxyPlugin({ listen: { kind: 'tcp', host: '127.0.0.1', port: 0 }, caDir }),
      ],
      config: {},
    });
  });

  afterEach(async () => {
    if (kernel) await kernel.shutdown();
    kernel = undefined;
  });

  // The orchestrator opens the session on the turn's own context.
  function openCtx(): AgentContext {
    return makeAgentContext({ sessionId: 'orchestrator-turn', agentId: 'a1', userId: 'u1' });
  }

  // Typed loosely on purpose: the malformed cases below hand the proxy what a
  // broken caller could, not what the type allows.
  function open(sessionId: string, fields: { allowlist: unknown[]; newlyAllowedHosts?: unknown }) {
    return bus.call('proxy:open-session', openCtx(), {
      sessionId,
      userId: 'u1',
      agentId: 'a1',
      credentials: {},
      ...fields,
    });
  }

  function drain(sessionId: string): Promise<{ hosts: string[] }> {
    return bus.call<Record<string, never>, { hosts: string[] }>(
      'proxy:drain-session-allowed-hosts',
      makeAgentContext({ sessionId, agentId: 'a1', userId: 'u1' }),
      {},
    );
  }

  it('open-session: newly allowed hosts on the allowlist are reported once, at the first drain', async () => {
    await open('s1', {
      allowlist: ['a.example.com', 'b.example.com'],
      newlyAllowedHosts: ['b.example.com'],
    });
    expect(await drain('s1')).toEqual({ hosts: ['b.example.com'] });
    // Surface-once, like a live Allow's record.
    expect(await drain('s1')).toEqual({ hosts: [] });
  });

  it('a newly allowed host that is not on the allowlist, or is not a host, is never reported', async () => {
    await open('s1', {
      // The proxy does not vet its caller's allowlist, so a malformed entry can
      // sit on it. Each bad entry below is ON the allowlist except the first,
      // so every one of the three checks has to hold on its own.
      allowlist: ['a.example.com', 'NOT A HOST', 42],
      newlyAllowedHosts: [
        'c.example.com', // a real hostname this session can't reach
        'NOT A HOST', // on the allowlist, but not a hostname
        42, // on the allowlist, and '42' would pass the hostname check
        'a.example.com', // the one true statement
      ],
    });
    expect(await drain('s1')).toEqual({ hosts: ['a.example.com'] });
  });

  it('a newlyAllowedHosts that is not a list is ignored: the session still opens, nothing is reported', async () => {
    await open('s1', {
      allowlist: ['a.example.com'],
      newlyAllowedHosts: { 0: 'a.example.com', length: 1 },
    });
    expect(await drain('s1')).toEqual({ hosts: [] });
    // The session is open: a live Allow on it still answers added.
    expect(
      await bus.call<{ sessionId: string; host: string }, { added: boolean }>(
        'proxy:add-host',
        openCtx(),
        { sessionId: 's1', host: 'b.example.com' },
      ),
    ).toEqual({ added: true, agentId: 'a1' });
  });

  it('at most 32 are reported, the first ones given', async () => {
    const hosts = Array.from({ length: 40 }, (_, i) => `h${i}.example.com`);
    await open('s1', { allowlist: hosts, newlyAllowedHosts: hosts });
    expect((await drain('s1')).hosts).toEqual(hosts.slice(0, 32));
  });

  it('close-session forgets them (only for the session it closes)', async () => {
    await open('s1', { allowlist: ['a.example.com'], newlyAllowedHosts: ['a.example.com'] });
    await open('s2', { allowlist: ['a.example.com'], newlyAllowedHosts: ['a.example.com'] });
    await bus.call('proxy:close-session', openCtx(), { sessionId: 's1' });
    // Opened again under the same id, without the field: nothing carried over.
    await open('s1', { allowlist: ['b.example.com'] });
    expect(await drain('s1')).toEqual({ hosts: [] });
    expect(await drain('s2')).toEqual({ hosts: ['a.example.com'] });
  });

  it('no newlyAllowedHosts: nothing reported (unchanged)', async () => {
    await open('s1', { allowlist: ['a.example.com', 'b.example.com'] });
    expect(await drain('s1')).toEqual({ hosts: [] });
  });
});
