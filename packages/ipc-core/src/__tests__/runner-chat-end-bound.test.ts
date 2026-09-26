/**
 * TASK-555 — the runner-reported `chat:end` puts a clock on each subscriber.
 *
 * When the runner POSTs `event.chat-end`, @ax/ipc-core fires `chat:end` and
 * @ax/chat-orchestrator's subscriber resolves the waiting `agent:invoke` with
 * the runner's outcome. Subscribers run in registration order, so a hung one
 * registered AHEAD of the orchestrator's used to keep the orchestrator's from
 * ever running: a turn the runner had FINISHED sat until `chatTimeoutMs` and
 * was reported as `chat-run-timeout`.
 *
 * The turn test drives a real orchestrator turn into flight, hangs a chat:end
 * subscriber that inits BEFORE the orchestrator, and delivers the runner's
 * outcome through the same `fireEventChatEnd` the dispatcher calls.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  HookBus,
  makeAgentContext,
  type AgentContext,
  type AgentOutcome,
  type Logger,
  type Plugin,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
// Test-only cross-plugin import (eslint allowlists `src/__tests__/**`): the
// regression is about the orchestrator's subscriber, so it needs the real one.
import { createChatOrchestratorPlugin } from '@ax/chat-orchestrator';
import {
  fireEventChatEnd,
  RUNNER_CHAT_END_SUBSCRIBER_TIMEOUT_MS,
} from '../handlers/event-chat-end.js';

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

/** A plugin whose `chat:end` subscriber never settles. */
function hangerPlugin(): Plugin {
  return {
    manifest: {
      name: HANGER,
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: ['chat:end'],
    },
    init({ bus }) {
      bus.subscribe('chat:end', HANGER, never);
    },
  };
}

/** Services for a turn that reaches in-flight and waits on the runner. */
function inFlightServices(onQueued: () => void): Record<string, ServiceHandler> {
  return {
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
      onQueued();
      return { cursor: 0 };
    },
    'session:terminate': async () => ({}),
  };
}

describe('ipc-core — runner-reported chat:end subscriber bound (TASK-555)', () => {
  it('a hung chat:end subscriber ahead of the orchestrator no longer turns a finished turn into chat-run-timeout', async () => {
    let queued = 0;
    const h = await createTestHarness({
      services: inFlightServices(() => {
        queued += 1;
      }),
      plugins: [
        // FIRST, so its subscriber is registered ahead of the orchestrator's.
        hangerPlugin(),
        createChatOrchestratorPlugin({
          runnerBinaries: { 'claude-sdk': '/irrelevant' },
          // Far past the 2 s window below: a turn that only ends at its own
          // deadline reads as 'still-pending', never as a false pass.
          chatTimeoutMs: 30_000,
        }),
      ],
    });
    const turnLog: Logged[] = [];
    const turnCtx = ctxWith(turnLog, 's-runner-end', 'r-runner-end');
    const invoke = h.bus.call<unknown, AgentOutcome>('agent:invoke', turnCtx, {
      message: { role: 'user', content: 'hi' },
    });
    for (let i = 0; queued === 0 && i < 1_000; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(queued, 'the turn must reach in-flight').toBe(1);

    // The runner finished and reported it. Same function the dispatcher calls
    // after its 202; a short bound so the test need not wait 30 s.
    const runnerOutcome: AgentOutcome = {
      kind: 'complete',
      messages: [{ role: 'assistant', content: 'done' }],
    };
    const fired = fireEventChatEnd(turnCtx, h.bus, { outcome: runnerOutcome }, 20);

    const outcome = await within(invoke, 2_000);
    expect(outcome, 'the turn ends with the outcome the runner reported').toMatchObject({
      kind: 'complete',
    });
    expect(await within(fired, 2_000), 'the fire itself ends too').not.toBe('still-pending');
    // The hung subscriber is NAMED, so the skip is not silent.
    expect(
      turnLog.filter(
        (l) => l.msg === 'hook_subscriber_timed_out' && l.bindings.hook === 'chat:end',
      ),
    ).toEqual([
      {
        msg: 'hook_subscriber_timed_out',
        bindings: { hook: 'chat:end', plugin: HANGER, timeoutMs: 20 },
      },
    ]);
  });

  it('the dispatcher path bounds it at RUNNER_CHAT_END_SUBSCRIBER_TIMEOUT_MS', async () => {
    // The dispatcher calls fireEventChatEnd with three arguments. This pins
    // that the default — production — is a finite bound, not unbounded.
    const bus = new HookBus();
    const fireSpy = vi.spyOn(bus, 'fire');
    const outcome: AgentOutcome = { kind: 'complete', messages: [] };
    await fireEventChatEnd(ctxWith([], 's', 'r'), bus, { outcome });
    expect(fireSpy.mock.calls.map((c) => [c[0], c[3]])).toEqual([
      ['chat:end', { subscriberTimeoutMs: RUNNER_CHAT_END_SUBSCRIBER_TIMEOUT_MS }],
    ]);
    expect(Number.isFinite(RUNNER_CHAT_END_SUBSCRIBER_TIMEOUT_MS)).toBe(true);
    expect(RUNNER_CHAT_END_SUBSCRIBER_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
