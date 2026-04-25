import { describe, it, expect } from 'vitest';
import {
  HookBus,
  makeChatContext,
  createLogger,
  reject,
  type ChatMessage,
  type ChatOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// ---------------------------------------------------------------------------
// Orchestrator tests
//
// We exercise chat:run end-to-end through the bus, but stub the three peer
// plugins (session / sandbox / ipc) as service-hook mocks so no real runner
// subprocess is spawned. The mock `sandbox:open-session` simulates what a
// real runner would do: it fires `chat:end` on the bus (standing in for the
// IPC server's /event.chat-end handler) with a constructed outcome, and
// returns a handle with `kill()` + `exited` promises.
//
// The sessionId the orchestrator passes to `sandbox:open-session` is the
// same sessionId that flows through every chat:end fire — that's the join
// key the orchestrator uses in its waiter Map.
// ---------------------------------------------------------------------------

function silentCtx(sessionId = 'test-session') {
  return makeChatContext({
    sessionId,
    agentId: 'test-agent',
    userId: 'test-user',
    logger: createLogger({ reqId: 'orch-test', writer: () => undefined }),
  });
}

interface MockBundle {
  services: Record<string, ServiceHandler>;
  calls: {
    sessionQueueWork: number;
    sessionTerminate: number;
    sandboxOpen: number;
    killCalls: number;
  };
  lastQueuedMessage(): ChatMessage | undefined;
}

// Builds a default mock bundle. Callers can override individual services.
// The orchestrator itself does NOT call session:create (sandbox:open-session
// does), so we don't mock session:create here.
function buildMocks(opts: {
  openSession?: ServiceHandler;
  queueWork?: ServiceHandler;
} = {}): MockBundle {
  const calls = {
    sessionQueueWork: 0,
    sessionTerminate: 0,
    sandboxOpen: 0,
    killCalls: 0,
  };
  let lastQueued: ChatMessage | undefined;

  const services: Record<string, ServiceHandler> = {
    'session:queue-work':
      opts.queueWork ??
      (async (_ctx, input: unknown) => {
        calls.sessionQueueWork += 1;
        const entry = (input as { entry: { type: string; payload?: ChatMessage } })
          .entry;
        if (entry.type === 'user-message') {
          lastQueued = entry.payload;
        }
        return { cursor: 0 };
      }),
    'session:terminate': async () => {
      calls.sessionTerminate += 1;
      return {};
    },
    'sandbox:open-session': async (ctx, input: unknown) => {
      calls.sandboxOpen += 1;
      if (opts.openSession !== undefined) {
        // Delegate to override but still wrap the returned handle so we can
        // count kill() calls even when the test provides its own handle.
        const result = (await opts.openSession(ctx, input)) as {
          runnerEndpoint: string;
          handle: {
            kill: () => Promise<void>;
            exited: Promise<unknown>;
          };
        };
        const originalKill = result.handle.kill;
        return {
          runnerEndpoint: result.runnerEndpoint,
          handle: {
            ...result.handle,
            kill: async () => {
              calls.killCalls += 1;
              await originalKill();
            },
          },
        };
      }
      return {
        runnerEndpoint: 'unix:///tmp/mock.sock',
        handle: {
          kill: async () => {
            calls.killCalls += 1;
          },
          // Never resolves unless kill() — the real sandbox's exited resolves
          // on child-close; for tests we keep it pending to simulate a live
          // subprocess.
          exited: new Promise(() => undefined),
        },
      };
    },
  };
  return {
    services,
    calls,
    lastQueuedMessage: () => lastQueued,
  };
}

describe('chat-orchestrator', () => {
  it('chat:start rejection does NOT open the sandbox and fires chat:end with reason', async () => {
    const mocks = buildMocks();
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });

    h.bus.subscribe('chat:start', 'blocker', async () =>
      reject({ reason: 'blocked' }),
    );
    const endFires: ChatOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: ChatOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      silentCtx(),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome).toEqual({
      kind: 'terminated',
      reason: 'chat:start:blocked',
    });
    expect(mocks.calls.sandboxOpen).toBe(0);
    expect(mocks.calls.sessionQueueWork).toBe(0);
    expect(endFires).toHaveLength(1);
    expect(endFires[0]).toEqual(outcome);
  });

  it('happy path: fake sandbox fires chat:end with a complete outcome; orchestrator returns it', async () => {
    const expectedOutcome: ChatOutcome = {
      kind: 'complete',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };

    // The mock open-session simulates a runner that processed the message
    // and posted /event.chat-end to the IPC server, which fired chat:end on
    // the bus. We fire directly here — no real IPC loop needed.
    let busRef: HookBus | null = null;
    const mocks = buildMocks({
      openSession: async (_ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeChatContext({
              sessionId,
              agentId: 'agent',
              userId: 'user',
              logger: createLogger({ reqId: 'runner', writer: () => undefined }),
            }),
            { outcome: expectedOutcome },
          );
        });
        return {
          runnerEndpoint: 'unix:///tmp/fake.sock',
          handle: {
            kill: async () => undefined,
            exited: new Promise(() => undefined),
          },
        };
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
    busRef = h.bus;

    const endFires: ChatOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: ChatOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      silentCtx('happy-session'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome).toEqual(expectedOutcome);
    // chat:end fires EXACTLY once — from the bus.fire inside the fake
    // runner. The orchestrator must NOT re-fire.
    expect(endFires).toHaveLength(1);
    expect(endFires[0]).toEqual(expectedOutcome);
    expect(mocks.calls.sandboxOpen).toBe(1);
    expect(mocks.lastQueuedMessage()).toEqual({ role: 'user', content: 'hi' });
  });

  it('sandbox:open-session throws → outcome terminated(sandbox-open-failed) and chat:end fires', async () => {
    const mocks = buildMocks({
      openSession: async () => {
        throw new Error('spawn failure');
      },
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 1_000,
        }),
      ],
    });

    const endFires: ChatOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: ChatOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      silentCtx('fail-open'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('sandbox-open-failed');
      expect(outcome.error).toBeDefined();
    }
    expect(endFires).toHaveLength(1);
    // session:terminate must be called on the open-failure path — otherwise
    // the token we minted lingers with no listener. The orchestrator fires
    // this defensively because sandbox-subprocess's own cleanup never ran.
    expect(mocks.calls.sessionTerminate).toBeGreaterThanOrEqual(1);
  });

  it('session:queue-work throws → outcome terminated(queue-work-failed) and kill() is called', async () => {
    const mocks = buildMocks({
      queueWork: async () => {
        throw new Error('queue boom');
      },
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 1_000,
        }),
      ],
    });

    const endFires: ChatOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: ChatOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      silentCtx('fail-queue'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('queue-work-failed');
    }
    expect(mocks.calls.killCalls).toBe(1);
    expect(endFires).toHaveLength(1);
  });

  it('sandbox exits before chat:end → outcome terminated(sandbox-exit-before-chat-end) and chat:end fires', async () => {
    const mocks = buildMocks({
      openSession: async () => {
        return {
          runnerEndpoint: 'unix:///tmp/short.sock',
          handle: {
            kill: async () => undefined,
            // Resolves quickly, without any chat:end fire beforehand.
            exited: Promise.resolve({ code: 0, signal: null }),
          },
        };
      },
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 1_000,
        }),
      ],
    });

    const endFires: ChatOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: ChatOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, ChatOutcome>(
      'chat:run',
      silentCtx('short-lived'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome).toEqual({
      kind: 'terminated',
      reason: 'sandbox-exit-before-chat-end',
    });
    // Orchestrator synthesized chat:end because the IPC server never did.
    expect(endFires).toHaveLength(1);
    expect(endFires[0]).toEqual(outcome);
  });

  it('chat:end fires exactly once across all exit paths', async () => {
    // We already assert single-fire in each scenario above; this is a
    // parametrized sweep so a regression in any one path lights up loudly.
    const scenarios: Array<{
      name: string;
      setup: (services: Record<string, ServiceHandler>) => ServiceHandler | undefined;
      input: ChatMessage;
      startBlock?: boolean;
      expectKind: ChatOutcome['kind'];
    }> = [
      { name: 'start-reject', setup: () => undefined, input: { role: 'user', content: 'x' }, startBlock: true, expectKind: 'terminated' },
      {
        name: 'queue-fail',
        setup: (s) => {
          s['session:queue-work'] = async () => {
            throw new Error('nope');
          };
          return undefined;
        },
        input: { role: 'user', content: 'x' },
        expectKind: 'terminated',
      },
      {
        name: 'open-fail',
        setup: (s) => {
          s['sandbox:open-session'] = async () => {
            throw new Error('nope');
          };
          return undefined;
        },
        input: { role: 'user', content: 'x' },
        expectKind: 'terminated',
      },
      {
        name: 'sandbox-exit',
        setup: (s) => {
          s['sandbox:open-session'] = async () => ({
            runnerEndpoint: 'unix:///tmp/x.sock',
            handle: {
              kill: async () => undefined,
              exited: Promise.resolve({ code: 0, signal: null }),
            },
          });
          return undefined;
        },
        input: { role: 'user', content: 'x' },
        expectKind: 'terminated',
      },
    ];

    for (const s of scenarios) {
      const mocks = buildMocks();
      s.setup(mocks.services);
      const h = await createTestHarness({
        services: mocks.services,
        plugins: [
          createChatOrchestratorPlugin({
            runnerBinary: '/irrelevant',
            chatTimeoutMs: 1_000,
          }),
        ],
      });
      if (s.startBlock) {
        h.bus.subscribe('chat:start', 'block', async () =>
          reject({ reason: 'blocked' }),
        );
      }
      let endCount = 0;
      h.bus.subscribe('chat:end', 'counter', async () => {
        endCount += 1;
        return undefined;
      });
      const outcome = await h.bus.call<unknown, ChatOutcome>(
        'chat:run',
        silentCtx(`scenario-${s.name}`),
        { message: s.input },
      );
      expect(outcome.kind, `scenario ${s.name}`).toBe(s.expectKind);
      expect(endCount, `scenario ${s.name}`).toBe(1);
    }
  });

  it('multiple concurrent chat:runs with different sessionIds do not cross-contaminate', async () => {
    let busRef: HookBus | null = null;

    const mocks = buildMocks({
      openSession: async (_ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        // Each "runner" emits a distinct complete outcome echoing its sessionId
        // so we can verify the orchestrator routed the right outcome back to
        // the right caller.
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeChatContext({
              sessionId,
              agentId: 'a',
              userId: 'u',
              logger: createLogger({ reqId: 'r', writer: () => undefined }),
            }),
            {
              outcome: {
                kind: 'complete',
                messages: [{ role: 'assistant', content: `reply-${sessionId}` }],
              },
            },
          );
        });
        return {
          runnerEndpoint: `unix:///tmp/${sessionId}.sock`,
          handle: {
            kill: async () => undefined,
            exited: new Promise(() => undefined),
          },
        };
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
    busRef = h.bus;

    const [a, b] = await Promise.all([
      h.bus.call<unknown, ChatOutcome>('chat:run', silentCtx('session-A'), {
        message: { role: 'user', content: 'hi-A' },
      }),
      h.bus.call<unknown, ChatOutcome>('chat:run', silentCtx('session-B'), {
        message: { role: 'user', content: 'hi-B' },
      }),
    ]);

    expect(a.kind).toBe('complete');
    if (a.kind === 'complete') {
      expect(a.messages).toEqual([
        { role: 'assistant', content: 'reply-session-A' },
      ]);
    }
    expect(b.kind).toBe('complete');
    if (b.kind === 'complete') {
      expect(b.messages).toEqual([
        { role: 'assistant', content: 'reply-session-B' },
      ]);
    }
  });
});
