/**
 * `agent:invoke` has NO HookBus timeout (TASK-498).
 *
 * THE BUG THIS PINS. The hook was registered with no `timeoutMs`, so it ran on
 * the HookBus default of 120 s — while the orchestrator's own bound on a turn
 * (`chatTimeoutMs`) defaults to TEN MINUTES, and `withTimeout` races the
 * handler without cancelling it. Every turn longer than two minutes therefore
 * had its `bus.call('agent:invoke')` rejected WHILE THE TURN WAS ALIVE AND
 * STREAMING. channel-web dispatches fire-and-forget and only logged that
 * rejection (`chat_run_dispatch_failed`), which is why nobody noticed — and why
 * that log line could not be trusted as a failure signal, which is exactly what
 * TASK-498 needed it to be. It now surfaces a `chat:turn-error`, so a rejection
 * that fires on a healthy long turn would blank the screen on every one.
 *
 * WHY THE ANSWER IS "NO CLOCK" AND NOT "A BIGGER CLOCK". The first fix here was
 * `chatTimeoutMs + 60 s`, on the reasoning that the bus must never fire before
 * the orchestrator's own bound. A reviewer showed that does not hold: the
 * orchestrator arms its timer only AFTER setup — `chat:start` subscribers,
 * `agents:resolve`, `proxy:open-session` and `sandbox:open-session` (registered
 * `timeoutMs: 300_000` by BOTH providers) — while the bus clock starts at
 * handler entry. A three-minute cold pod spawn puts the bus deadline two
 * minutes ahead of the orchestrator's, and no finite slack fixes it, because
 * `HookBus.fire` puts no clock on `chat:start` subscribers at all.
 *
 * So the orchestrator owns turn duration alone. The assertions below are the
 * two halves of that: the registration carries no finite deadline, and a turn
 * that takes longer than the bus default still comes back as an OUTCOME.
 */
import { describe, it, expect, vi } from 'vitest';
import { HookBus, makeAgentContext, createLogger, type AgentOutcome } from '@ax/core';
import { createChatOrchestratorPlugin } from '../index.js';
import { AGENT_INVOKE_TIMEOUT_MS } from '../orchestrator.js';

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
  it('registers no finite deadline — the orchestrator owns turn duration', async () => {
    const bus = new HookBus();
    const spy = vi.spyOn(bus, 'registerService');
    await createChatOrchestratorPlugin({
      runnerBinaries: { 'claude-sdk': '/irrelevant' },
      chatTimeoutMs: 42_000,
    }).init({ bus, config: {} });

    const registration = spy.mock.calls.find((c) => c[0] === 'agent:invoke');
    expect(registration).toBeDefined();
    const opts = registration![3] as { timeoutMs?: number } | undefined;
    /*
      EXPLICITLY Infinity, not merely absent. Leaving the option off would fall
      back to the HookBus default, which is the bug. The registration has to
      SAY that this hook is not on a bus clock.
    */
    expect(opts?.timeoutMs).toBe(Number.POSITIVE_INFINITY);
    expect(AGENT_INVOKE_TIMEOUT_MS).toBe(Number.POSITIVE_INFINITY);
  });

  it('does not shorten when the host configures a chat timeout', async () => {
    // The deadline is not derived from `chatTimeoutMs` any more, and must not
    // quietly start being again: a derived one measures from the wrong
    // instant (handler entry, not the start of streaming).
    const bus = new HookBus();
    const spy = vi.spyOn(bus, 'registerService');
    await createChatOrchestratorPlugin({
      runnerBinaries: { 'claude-sdk': '/irrelevant' },
      chatTimeoutMs: 1_000,
    }).init({ bus, config: {} });
    const opts = spy.mock.calls.find((c) => c[0] === 'agent:invoke')![3] as {
      timeoutMs?: number;
    };
    expect(opts.timeoutMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('a turn that outlives the bus DEFAULT still returns its outcome, not a rejection', async () => {
    /*
      The behavioural half, shrunk so it runs in milliseconds: a bus whose
      default service timeout is 25 ms, and a turn whose SETUP alone takes
      ~120 ms. On the unfixed registration this call rejects with "service
      hook 'agent:invoke' exceeded 25ms" — the same failure the shipped 120 s
      default produced on any turn over two minutes, just sooner.

      The slow part is a `chat:start` subscriber for two reasons: `HookBus.
      fire` puts no clock on subscribers, so the delay stays inside the handler
      where the timeout applies rather than blowing a nested call's own budget
      first; and it sits in the SETUP phase, which is precisely the stretch the
      orchestrator's own timer is not yet watching. That is the gap a derived
      deadline could not cover, so it is the one worth testing.
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
