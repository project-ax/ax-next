import { describe, it, expect } from 'vitest';
import {
  HookBus,
  makeAgentContext,
  createLogger,
  type AgentMessage,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// ---------------------------------------------------------------------------
// Phase 2B Task 11 — system-prompt:augment hook in the orchestrator.
//
// The orchestrator calls `system-prompt:augment` between the agents:resolve
// step and the fresh-spawn proxy/sandbox open. Contributions are concatenated
// in array order (joined with "\n\n", empty bodies filtered) and written to
// `agentConfig.systemPromptAugment` (its own field since TASK-142 — the runner
// prepends it on top of the composed `.ax/` identity prompt) before forwarding
// into `sandbox:open-session`.
//
// Properties under test:
//   1. Provider registered → sandbox sees the augment in systemPromptAugment.
//   2. Provider absent → systemPromptAugment stays empty.
//   3. Multiple contributions concat in array order; empty bodies filtered.
//   4. Provider throw → chat completes with empty augment
//      (fire-and-degrade; failures don't abort the chat).
//   5. Routed-into-live-sandbox path: augment NOT called — the runner
//      already has its baked-in systemPromptAugment.
// ---------------------------------------------------------------------------

const TEST_AGENT = {
  id: 'test-agent',
  ownerId: 'test-user',
  ownerType: 'user' as const,
  visibility: 'personal' as const,
  displayName: 'Test',
  allowedTools: ['file.read'],
  mcpConfigIds: [],
  model: 'claude-sonnet-4-7',
  workspaceRef: null,
};

function silentCtx(overrides?: {
  sessionId?: string;
  conversationId?: string;
  reqId?: string;
}) {
  return makeAgentContext({
    sessionId: overrides?.sessionId ?? 'aug-session',
    agentId: 'test-agent',
    userId: 'test-user',
    ...(overrides?.conversationId !== undefined
      ? { conversationId: overrides.conversationId }
      : {}),
    ...(overrides?.reqId !== undefined ? { reqId: overrides.reqId } : {}),
    logger: createLogger({ reqId: 'aug-test', writer: () => undefined }),
  });
}

interface AugmentMocks {
  services: Record<string, ServiceHandler>;
  trace: {
    augmentCalls: number;
    sandboxOpen: number;
    lastSystemPromptAugment: string | undefined;
    lastQueuedMessage: AgentMessage | undefined;
  };
}

// Build a self-contained mock bundle: agents:resolve, sandbox:open-session
// (fires chat:end on the bus to resolve the orchestrator's waiter), session:
// queue-work, session:terminate, and proxy stubs. Augment provider, if any,
// is passed in via `augmentProvider`.
function buildMocks(opts: {
  busRef: { current: HookBus | null };
  augmentProvider?: ServiceHandler;
  /** When set, also wires conversations:* + session:is-alive returning alive. */
  routedSession?: { conversationId: string; activeSessionId: string };
} = {} as never): AugmentMocks {
  const trace: AugmentMocks['trace'] = {
    augmentCalls: 0,
    sandboxOpen: 0,
    lastSystemPromptAugment: undefined,
    lastQueuedMessage: undefined,
  };

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
    'session:queue-work': async (_ctx, input: unknown) => {
      const entry = (input as { entry: { type: string; payload?: AgentMessage } })
        .entry;
      if (entry.type === 'user-message') {
        trace.lastQueuedMessage = entry.payload;
      }
      return { cursor: 0 };
    },
    'session:terminate': async () => ({}),
    'sandbox:open-session': async (ctx, input: unknown) => {
      trace.sandboxOpen += 1;
      const i = input as {
        sessionId: string;
        owner: { agentConfig: { systemPromptAugment: string } };
      };
      trace.lastSystemPromptAugment = i.owner.agentConfig.systemPromptAugment;
      const originatingReqId = ctx.reqId;
      // Fire chat:end on the next tick to resolve the orchestrator's waiter.
      setImmediate(() => {
        void opts.busRef.current!.fire(
          'chat:end',
          makeAgentContext({
            sessionId: i.sessionId,
            agentId: 'test-agent',
            userId: 'test-user',
            reqId: originatingReqId,
            logger: createLogger({
              reqId: originatingReqId,
              writer: () => undefined,
            }),
          }),
          { outcome: { kind: 'complete', messages: [] } },
        );
      });
      return {
        runnerEndpoint: 'unix:///tmp/aug.sock',
        handle: {
          kill: async () => undefined,
          exited: new Promise(() => undefined),
        },
      };
    },
    'proxy:open-session': async () => ({
      proxyEndpoint: 'tcp://127.0.0.1:54321',
      caCertPem: 'CA',
      envMap: {},
    }),
    'proxy:close-session': async () => ({}),
  };

  if (opts.augmentProvider !== undefined) {
    const wrapped = opts.augmentProvider;
    services['system-prompt:augment'] = async (ctx, input) => {
      trace.augmentCalls += 1;
      return wrapped(ctx, input);
    };
  }

  if (opts.routedSession !== undefined) {
    const { conversationId, activeSessionId } = opts.routedSession;
    services['conversations:get'] = async (_ctx, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      return {
        conversation: {
          conversationId: i.conversationId,
          userId: i.userId,
          agentId: 'test-agent',
          activeSessionId: i.conversationId === conversationId
            ? activeSessionId
            : null,
          activeReqId: null,
        },
      };
    };
    services['conversations:bind-session'] = async () => undefined;
    services['session:is-alive'] = async (_ctx, input: unknown) => {
      const sid = (input as { sessionId: string }).sessionId;
      return { alive: sid === activeSessionId };
    };
  }

  return { services, trace };
}

describe('chat-orchestrator system-prompt:augment (Phase 2B)', () => {
  it('augment provider registered → prepends contribution to systemPrompt', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      busRef,
      augmentProvider: async () => ({
        contributions: [{ source: 'memory-strata', body: 'INJECT-ME' }],
      }),
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx({ sessionId: 'aug-1' }),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('complete');
    expect(mocks.trace.augmentCalls).toBe(1);
    expect(mocks.trace.sandboxOpen).toBe(1);
    expect(mocks.trace.lastSystemPromptAugment).toBe('INJECT-ME');
  });

  it('augment provider not registered → sandbox sees the original prompt unchanged', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({ busRef });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx({ sessionId: 'aug-2' }),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('complete');
    expect(mocks.trace.augmentCalls).toBe(0);
    expect(mocks.trace.lastSystemPromptAugment).toBe('');
  });

  it('multiple contributions concat in order; empty bodies filtered', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      busRef,
      augmentProvider: async () => ({
        contributions: [
          { source: 'a', body: 'A' },
          { source: 'b', body: 'B' },
          // Empty body — must be filtered before the join, otherwise the
          // resulting prompt would carry a dangling "\n\n" gap.
          { source: 'empty', body: '' },
        ],
      }),
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });
    busRef.current = h.bus;

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx({ sessionId: 'aug-3' }),
      { message: { role: 'user', content: 'hi' } },
    );

    // Concat order: 'A', 'B' (empty filtered) joined with '\n\n', then
    // separator '\n\n', then base prompt.
    expect(mocks.trace.lastSystemPromptAugment).toBe('A\n\nB');
  });

  it('augment provider throws → chat completes with un-augmented prompt', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      busRef,
      augmentProvider: async () => {
        throw new Error('augment-impl boom');
      },
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });
    busRef.current = h.bus;

    // The agent:invoke call MUST resolve normally — augmentation is fire-
    // and-degrade. A throw must not propagate as a terminated outcome.
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx({ sessionId: 'aug-4' }),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('complete');
    expect(mocks.trace.augmentCalls).toBe(1);
    // Original prompt forwarded — augmentation never landed.
    expect(mocks.trace.lastSystemPromptAugment).toBe('');
  });

  it('routed path (live sandbox) does NOT call system-prompt:augment', async () => {
    // J6 — when ctx.conversationId points at a live session, the
    // orchestrator routes into that session's inbox without re-spawning.
    // The runner already has its baked-in systemPrompt; calling augment
    // on this path would compute a contribution that nothing consumes,
    // wasting work and potentially logging confusing audit events.
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      busRef,
      augmentProvider: async () => ({
        contributions: [{ source: 'memory-strata', body: 'SHOULD-NOT-APPEAR' }],
      }),
      routedSession: {
        conversationId: 'conv-routed',
        activeSessionId: 's-live',
      },
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });
    busRef.current = h.bus;

    // The runner emits chat:end on s-live with the originating reqId so
    // the orchestrator's deferred resolves.
    const reqId = 'req-routed-1';
    setImmediate(() => {
      void h.bus.fire(
        'chat:end',
        makeAgentContext({
          sessionId: 's-live',
          agentId: 'test-agent',
          userId: 'test-user',
          reqId,
          logger: createLogger({ reqId, writer: () => undefined }),
        }),
        { outcome: { kind: 'complete', messages: [] } },
      );
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx({
        sessionId: 'unused-fresh',
        conversationId: 'conv-routed',
        reqId,
      }),
      { message: { role: 'user', content: 'follow-up' } },
    );

    expect(outcome.kind).toBe('complete');
    // Routed: sandbox:open-session NEVER called.
    expect(mocks.trace.sandboxOpen).toBe(0);
    // Augment NEVER called — the routed branch returns before reaching it.
    expect(mocks.trace.augmentCalls).toBe(0);
  });
});
