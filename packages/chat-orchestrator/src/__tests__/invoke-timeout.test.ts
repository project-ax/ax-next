/**
 * `agent:invoke`'s service timeout (TASK-498).
 *
 * THE BUG THIS PINS. The hook was registered with no `timeoutMs`, so it ran on
 * the HookBus default of 120 s — while the orchestrator's own bound on a turn
 * (`chatTimeoutMs`) defaults to TEN MINUTES. Every turn longer than two
 * minutes therefore had its `bus.call('agent:invoke')` rejected with
 * `exceeded 120000ms` WHILE THE TURN WAS ALIVE AND STREAMING. channel-web
 * dispatches fire-and-forget and only logged that rejection
 * (`chat_run_dispatch_failed`), which is why nobody noticed — and why that log
 * line could not be trusted as a failure signal, which is exactly what
 * TASK-498 needed it to be. It now surfaces a `chat:turn-error`, and a
 * rejection that fires on healthy long turns would blank the screen on every
 * one of them.
 *
 * So the rule is: THE BUS TIMEOUT MUST NEVER FIRE FIRST. The orchestrator
 * bounds each turn itself and fires `chat:turn-error(chat-run-timeout)` when
 * it does; the bus timeout is a backstop for a handler that failed to settle
 * at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { HookBus, makeAgentContext, createLogger, type AgentOutcome } from '@ax/core';
import { createChatOrchestratorPlugin } from '../index.js';
import {
  AGENT_INVOKE_TIMEOUT_SLACK_MS,
  DEFAULT_CHAT_TIMEOUT_MS,
} from '../orchestrator.js';

function ctx() {
  return makeAgentContext({
    sessionId: 's-1',
    agentId: 'test-agent',
    userId: 'test-user',
    conversationId: 'conv-1',
    reqId: 'req-1',
    logger: createLogger({ reqId: 'req-1', writer: () => undefined }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('agent:invoke service timeout', () => {
  it('is registered strictly LATER than the orchestrator’s own chat timeout', async () => {
    const bus = new HookBus();
    const spy = vi.spyOn(bus, 'registerService');
    const plugin = createChatOrchestratorPlugin({
      runnerBinaries: { 'claude-sdk': '/irrelevant' },
      chatTimeoutMs: 42_000,
    });
    await plugin.init({ bus, config: {} });

    const registration = spy.mock.calls.find((c) => c[0] === 'agent:invoke');
    expect(registration).toBeDefined();
    const opts = registration![3] as { timeoutMs?: number } | undefined;
    expect(opts?.timeoutMs).toBe(42_000 + AGENT_INVOKE_TIMEOUT_SLACK_MS);
    // The relationship, not just the arithmetic: a slack of zero would put the
    // two bounds in a race, and a negative one would put them back the wrong
    // way round.
    expect(opts!.timeoutMs!).toBeGreaterThan(42_000);
  });

  it('tracks the DEFAULT chat timeout when the host configures none', async () => {
    // The default is the case that actually shipped broken: ten minutes of
    // allowed turn, two minutes of allowed call.
    const bus = new HookBus();
    const spy = vi.spyOn(bus, 'registerService');
    await createChatOrchestratorPlugin({
      runnerBinaries: { 'claude-sdk': '/irrelevant' },
    }).init({ bus, config: {} });
    const opts = spy.mock.calls.find((c) => c[0] === 'agent:invoke')![3] as {
      timeoutMs?: number;
    };
    expect(opts.timeoutMs).toBe(DEFAULT_CHAT_TIMEOUT_MS + AGENT_INVOKE_TIMEOUT_SLACK_MS);
    expect(opts.timeoutMs!).toBeGreaterThan(DEFAULT_CHAT_TIMEOUT_MS);
  });

  it('a turn that outlives the bus DEFAULT still returns its outcome, not a rejection', async () => {
    /*
      The behavioural half, shrunk so it runs in milliseconds: a bus whose
      default service timeout is 25 ms, a turn that takes ~120 ms, and a chat
      timeout comfortably above both. On the unfixed registration this call
      rejects with "service hook 'agent:invoke' exceeded 25ms" — the same
      failure the shipped 120 s default produced on any turn over two minutes,
      just sooner.

      The slow part is a `chat:start` subscriber, because `HookBus.fire` puts
      no clock on subscribers: that keeps the delay inside the handler where
      the timeout applies, rather than inside a nested `bus.call` that would
      blow its own (tiny) budget first and mask the thing under test.
    */
    const bus = new HookBus({ defaultServiceTimeoutMs: 25 });
    bus.subscribe('chat:start', 'slow-observer', async () => {
      await sleep(120);
      return undefined;
    });
    await createChatOrchestratorPlugin({
      runnerBinaries: { 'claude-sdk': '/irrelevant' },
      chatTimeoutMs: 5_000,
    }).init({ bus, config: {} });

    // No `agents:resolve` is registered, so the turn ends promptly after the
    // slow observer — a terminated OUTCOME, which is the contract. What must
    // not happen is the CALL being killed out from under it.
    const outcome = await bus.call<unknown, AgentOutcome>('agent:invoke', ctx(), {
      message: { role: 'user', content: 'hi' },
    });
    expect(outcome.kind).toBe('terminated');
  });
});
