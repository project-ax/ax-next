/**
 * TASK-551 — the orchestrator's `chat:end`, `chat:turn-error` and
 * `chat:permission-request` fires put a clock on each subscriber.
 *
 * Before this, `HookBus.fire` waited on those subscribers forever, and every
 * one of these fires is awaited by something that cannot afford that:
 * `agent:invoke` (which has no deadline of its own) awaits the synthesized
 * `chat:end` and the `chat:turn-error` before it, and the egress-wall card is
 * awaited inside an `event.http-egress` subscriber. One hung subscriber pinned
 * the turn — or the fire that delivered it — open with nothing to end it.
 *
 * Each test below hangs one subscriber FIRST, registers an observer AFTER it,
 * and checks the three things the bound promises: the wait ends, the hung
 * subscriber is named in `hook_subscriber_timed_out`, and the later
 * subscriber still ran.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PluginError,
  makeAgentContext,
  type AgentContext,
  type AgentOutcome,
  type Logger,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';
import { CHAT_EVENT_SUBSCRIBER_TIMEOUT_MS } from '../orchestrator.js';

interface Logged {
  msg: string;
  bindings: Record<string, unknown>;
}

function capturingLogger(sink: Logged[]): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, bindings) => {
      sink.push({ msg, bindings: bindings ?? {} });
    },
    error: (msg, bindings) => {
      sink.push({ msg, bindings: bindings ?? {} });
    },
    child: () => logger,
  };
  return logger;
}

function ctxWith(sink: Logged[], sessionId: string, reqId: string): AgentContext {
  return makeAgentContext({
    sessionId,
    agentId: 'test-agent',
    userId: 'test-user',
    reqId,
    logger: capturingLogger(sink),
  });
}

const never = (): Promise<never> => new Promise<never>(() => {});

/** Resolve to 'still-pending' if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | 'still-pending'> {
  return Promise.race([
    p,
    new Promise<'still-pending'>((r) => setTimeout(() => r('still-pending'), ms)),
  ]);
}

const HANGER = '@ax/test-hanger';

function timedOutFor(logged: Logged[], hook: string): Logged[] {
  return logged.filter(
    (l) => l.msg === 'hook_subscriber_timed_out' && l.bindings.hook === hook,
  );
}

/**
 * Services for a turn that ends at `agents:resolve` with a forbidden error —
 * a path that fires `chat:turn-error` and then a synthesized `chat:end`, both
 * awaited before `agent:invoke` returns.
 */
function forbiddenResolveServices(): Record<string, ServiceHandler> {
  return {
    'agents:resolve': async () => {
      throw new PluginError({ code: 'forbidden', plugin: '@ax/agents', message: 'nope' });
    },
    'session:queue-work': async () => ({ cursor: 0 }),
    'session:terminate': async () => ({}),
    'sandbox:open-session': async () => {
      throw new Error('not reached');
    },
  };
}

async function forbiddenTurnHarness(chatEventSubscriberTimeoutMs?: number) {
  return createTestHarness({
    services: forbiddenResolveServices(),
    plugins: [
      createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' },
        chatTimeoutMs: 5_000,
        ...(chatEventSubscriberTimeoutMs !== undefined ? { chatEventSubscriberTimeoutMs } : {}),
      }),
    ],
  });
}

describe('chat-orchestrator — chat event subscriber bound (TASK-551)', () => {
  it('a chat:end subscriber that never settles cannot hang agent:invoke', async () => {
    const h = await forbiddenTurnHarness(20);
    h.bus.subscribe('chat:end', HANGER, never);
    const ends: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_c, p: unknown) => {
      ends.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const logged: Logged[] = [];
    const outcome = await within(
      h.bus.call<unknown, AgentOutcome>('agent:invoke', ctxWith(logged, 's-end', 'r-end'), {
        message: { role: 'user', content: 'hi' },
      }),
      2_000,
    );

    expect(outcome, 'the bound must end the wait').toMatchObject({
      kind: 'terminated',
      reason: 'agent-resolve:forbidden',
    });
    // The subscriber after the hung one still ran...
    expect(ends).toHaveLength(1);
    // ...and the hung one is NAMED, so the skip is not silent.
    expect(timedOutFor(logged, 'chat:end')).toEqual([
      {
        msg: 'hook_subscriber_timed_out',
        bindings: { hook: 'chat:end', plugin: HANGER, timeoutMs: 20 },
      },
    ]);
  });

  it('a chat:turn-error subscriber that never settles cannot hang agent:invoke', async () => {
    const h = await forbiddenTurnHarness(20);
    h.bus.subscribe('chat:turn-error', HANGER, never);
    const errors: unknown[] = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_c, p: unknown) => {
      errors.push(p);
      return undefined;
    });
    const ends: unknown[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_c, p: unknown) => {
      ends.push(p);
      return undefined;
    });

    const logged: Logged[] = [];
    const outcome = await within(
      h.bus.call<unknown, AgentOutcome>('agent:invoke', ctxWith(logged, 's-te', 'r-te'), {
        message: { role: 'user', content: 'hi' },
      }),
      2_000,
    );

    expect(outcome, 'the bound must end the wait').toMatchObject({
      kind: 'terminated',
      reason: 'agent-resolve:forbidden',
    });
    expect(errors).toEqual([{ reqId: 'r-te', reason: 'agent-resolve:forbidden' }]);
    // The turn carried on past the hung turn-error subscriber to its chat:end.
    expect(ends).toHaveLength(1);
    expect(timedOutFor(logged, 'chat:turn-error')).toEqual([
      {
        msg: 'hook_subscriber_timed_out',
        bindings: { hook: 'chat:turn-error', plugin: HANGER, timeoutMs: 20 },
      },
    ]);
  });

  it('a chat:permission-request subscriber that never settles cannot hang the egress-wall card', async () => {
    // Drive a turn into flight (sandbox open, message queued, waiter
    // registered) so an allowlist block on its session raises a host card.
    let queued = 0;
    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({
        agent: {
          id: 'test-agent',
          ownerId: 'test-user',
          ownerType: 'user',
          visibility: 'personal',
          displayName: 'Test Agent',
          systemPrompt: '',
          allowedTools: [],
          mcpConfigIds: [],
          model: 'claude-opus-4-7',
          runner: 'claude-sdk',
          allowedHosts: [],
          requiredCredentials: {},
          skillAttachments: [],
          workspaceRef: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      }),
      'proxy:open-session': async () => ({
        proxyEndpoint: 'tcp://127.0.0.1:1',
        caCertPem: '',
        envMap: {},
      }),
      'proxy:close-session': async () => ({}),
      'sandbox:open-session': async () => ({
        runnerEndpoint: 'unix:///irrelevant',
        handle: { kill: async () => undefined, exited: new Promise(() => {}) },
      }),
      'session:queue-work': async () => {
        queued += 1;
        return { cursor: 0 };
      },
      'session:terminate': async () => ({}),
    };
    const h = await createTestHarness({
      services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinaries: { 'claude-sdk': '/irrelevant' },
          chatTimeoutMs: 10_000,
          chatEventSubscriberTimeoutMs: 20,
        }),
      ],
    });
    const turnLog: Logged[] = [];
    const turnCtx = ctxWith(turnLog, 's-wall', 'r-wall');
    const invoke = h.bus.call<unknown, AgentOutcome>('agent:invoke', turnCtx, {
      message: { role: 'user', content: 'hi' },
    });
    for (let i = 0; queued === 0 && i < 1_000; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(queued, 'the turn must reach in-flight').toBe(1);

    h.bus.subscribe('chat:permission-request', HANGER, never);
    const cards: unknown[] = [];
    h.bus.subscribe('chat:permission-request', 'obs', async (_c, p: unknown) => {
      cards.push(p);
      return undefined;
    });

    const logged: Logged[] = [];
    const egressFire = h.bus.fire('event.http-egress', ctxWith(logged, 's-wall', 'r-egress'), {
      method: 'GET',
      path: '/',
      status: 403,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 1,
      credentialInjected: false,
      classification: 'other',
      timestamp: Date.now(),
      sessionId: 's-wall',
      userId: 'test-user',
      host: 'blocked.example.com',
      blockedReason: 'allowlist',
    });

    expect(await within(egressFire, 2_000), 'the bound must end the wait').not.toBe(
      'still-pending',
    );
    expect(cards).toEqual([
      { kind: 'host', host: 'blocked.example.com', sessionId: 's-wall', reqId: 'r-wall' },
    ]);
    expect(timedOutFor(logged, 'chat:permission-request')).toEqual([
      {
        msg: 'hook_subscriber_timed_out',
        bindings: { hook: 'chat:permission-request', plugin: HANGER, timeoutMs: 20 },
      },
    ]);

    // Settle the in-flight turn so the harness does not leak it.
    await h.bus.fire('chat:end', turnCtx, {
      outcome: { kind: 'terminated', reason: 'sandbox-terminated' },
    });
    await within(invoke, 2_000);
  });

  it('bounds chat:end and chat:turn-error at CHAT_EVENT_SUBSCRIBER_TIMEOUT_MS by default', async () => {
    // The regressions above pass an explicit bound so they need not wait 30 s.
    // This pins that production — no override — is bounded too.
    const h = await forbiddenTurnHarness();
    const fireSpy = vi.spyOn(h.bus, 'fire');
    await h.bus.call('agent:invoke', ctxWith([], 's-default', 'r-default'), {
      message: { role: 'user', content: 'hi' },
    });
    const optsFor = (hook: string) =>
      fireSpy.mock.calls.filter((c) => c[0] === hook).map((c) => c[3]);
    expect(optsFor('chat:turn-error')).toEqual([
      { subscriberTimeoutMs: CHAT_EVENT_SUBSCRIBER_TIMEOUT_MS },
    ]);
    expect(optsFor('chat:end')).toEqual([
      { subscriberTimeoutMs: CHAT_EVENT_SUBSCRIBER_TIMEOUT_MS },
    ]);
    expect(Number.isFinite(CHAT_EVENT_SUBSCRIBER_TIMEOUT_MS)).toBe(true);
  });

  for (const bad of [-1, Number.NaN]) {
    it(`refuses chatEventSubscriberTimeoutMs=${bad} at init`, async () => {
      await expect(forbiddenTurnHarness(bad)).rejects.toThrow(/chatEventSubscriberTimeoutMs/);
    });
  }
});
