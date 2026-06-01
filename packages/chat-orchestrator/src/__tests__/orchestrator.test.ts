import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  makeAgentContext,
  createLogger,
  reject,
  type AgentMessage,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';
import { withBrokerDefaults } from '../orchestrator.js';

// Default agent stub — every test gets its own copy via spread to avoid
// accidental mutation. Mirrors @ax/agents' AgentRecord shape (the
// orchestrator duplicates it locally per I2).
const TEST_AGENT = {
  id: 'test-agent',
  ownerId: 'test-user',
  ownerType: 'user' as const,
  visibility: 'personal' as const,
  displayName: 'Test',
  systemPrompt: 'be helpful',
  allowedTools: ['file.read'],
  mcpConfigIds: [],
  model: 'claude-sonnet-4-7',
  workspaceRef: null,
};

// ---------------------------------------------------------------------------
// Orchestrator tests
//
// We exercise agent:invoke end-to-end through the bus, but stub the three peer
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
  return makeAgentContext({
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
    agentsResolve: number;
    lastSandboxInput: unknown;
  };
  lastQueuedMessage(): AgentMessage | undefined;
}

// Builds a default mock bundle. Callers can override individual services.
// The orchestrator itself does NOT call session:create (sandbox:open-session
// does), so we don't mock session:create here. agents:resolve IS mocked
// because Week 9.5's orchestrator hard-depends on it.
function buildMocks(opts: {
  openSession?: ServiceHandler;
  queueWork?: ServiceHandler;
  agentsResolve?: ServiceHandler;
  /**
   * Phase 6: credential-proxy is mandatory — the orchestrator now refuses
   * to open a sandbox if neither `proxy:open-session` nor `proxy:close-
   * session` is registered, returning `proxy-not-loaded`. To keep tests
   * that exercise the fresh-sandbox path working without forcing every
   * caller to wire `buildProxyHooks()`, we register trivial proxy stubs
   * by default. Tests that specifically want to assert the missing-proxy
   * gate set `omitProxyStubs: true` to exclude them.
   */
  omitProxyStubs?: boolean;
} = {}): MockBundle {
  const calls = {
    sessionQueueWork: 0,
    sessionTerminate: 0,
    sandboxOpen: 0,
    killCalls: 0,
    agentsResolve: 0,
    lastSandboxInput: undefined as unknown,
  };
  let lastQueued: AgentMessage | undefined;

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async (ctx, input) => {
      calls.agentsResolve += 1;
      if (opts.agentsResolve !== undefined) {
        return opts.agentsResolve(ctx, input);
      }
      return { agent: { ...TEST_AGENT } };
    },
    'session:queue-work':
      opts.queueWork ??
      (async (_ctx, input: unknown) => {
        calls.sessionQueueWork += 1;
        const entry = (input as { entry: { type: string; payload?: AgentMessage } })
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
      calls.lastSandboxInput = input;
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
  // Phase 6: credential-proxy mandatory. Stub both proxy hooks by default
  // so fresh-sandbox tests reach the sandbox layer; tests that assert the
  // gate (`proxy-not-loaded`, `proxy-hooks-misconfigured`) opt out via
  // `omitProxyStubs: true` and register only what they need.
  if (opts.omitProxyStubs !== true) {
    services['proxy:open-session'] = async () => ({
      proxyEndpoint: 'tcp://127.0.0.1:54321',
      caCertPem: 'TEST-CA-PEM',
      envMap: {},
    });
    services['proxy:close-session'] = async () => ({});
  }
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
    const endFires: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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
    const expectedOutcome: AgentOutcome = {
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
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        // Forward the originating reqId so onChatEnd's lookup matches
        // (waiter map is keyed by ctx.reqId — see orchestrator.ts).
        const originatingReqId = ctx.reqId;
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeAgentContext({
              sessionId,
              agentId: 'agent',
              userId: 'user',
              reqId: originatingReqId,
              logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
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

    const endFires: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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

    const endFires: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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

    const endFires: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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

    const endFires: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
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

  // -------------------------------------------------------------------------
  // chat:turn-error (Fault A) — when a turn ends abnormally the orchestrator
  // must signal the channel SSE so the client's "Thinking…" spinner flips to
  // an error instead of hanging forever. The SSE matches by reqId, so the
  // payload must carry the originating reqId.
  // -------------------------------------------------------------------------

  function turnErrorCtx(sessionId: string, reqId: string) {
    return makeAgentContext({
      sessionId,
      agentId: 'test-agent',
      userId: 'test-user',
      reqId,
      logger: createLogger({ reqId, writer: () => undefined }),
    });
  }

  it('fresh-spawn sandbox-exit fires chat:turn-error with the originating reqId', async () => {
    const mocks = buildMocks({
      openSession: async () => ({
        runnerEndpoint: 'unix:///tmp/short.sock',
        handle: {
          kill: async () => undefined,
          exited: Promise.resolve({ code: 143, signal: 'SIGTERM' }),
        },
      }),
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

    const turnErrors: Array<{ reqId?: string; reason?: string }> = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p as { reqId?: string; reason?: string });
      return undefined;
    });

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      turnErrorCtx('short-lived', 'r-exit'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(turnErrors).toEqual([
      { reqId: 'r-exit', reason: 'sandbox-exit-before-chat-end' },
    ]);
  });

  it('wedged-runner timeout fires chat:turn-error(chat-run-timeout)', async () => {
    // Default mock: exited never resolves, no chat:end → the bounded
    // chatTimeoutMs path synthesizes the terminated outcome.
    const mocks = buildMocks();
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 50,
        }),
      ],
    });

    const turnErrors: Array<{ reqId?: string; reason?: string }> = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p as { reqId?: string; reason?: string });
      return undefined;
    });

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      turnErrorCtx('wedged', 'r-timeout'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(turnErrors).toEqual([
      { reqId: 'r-timeout', reason: 'chat-run-timeout' },
    ]);
  });

  it('session:terminate while a turn is in-flight fires chat:turn-error(sandbox-terminated) promptly', async () => {
    // Default mock: exited never resolves, no chat:end → the turn stays
    // in-flight (the routed/warm path doesn't watch exited; it would
    // otherwise wait the full chatTimeoutMs). A session:terminate broadcast
    // (fired by the sandbox provider's exit handler on pod death) must
    // surface the error promptly.
    const mocks = buildMocks();
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 10_000,
        }),
      ],
    });

    const turnErrors: Array<{ reqId?: string; reason?: string }> = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p as { reqId?: string; reason?: string });
      return undefined;
    });

    const ctx = turnErrorCtx('sess-live', 'r-live');
    const invokePromise = h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctx,
      { message: { role: 'user', content: 'hi' } },
    );
    // Let the orchestrator reach the in-flight state (sandbox opened +
    // message enqueued + waiter registered).
    while (mocks.calls.sessionQueueWork === 0) {
      await new Promise((r) => setImmediate(r));
    }

    // The pod died — the session store re-broadcasts session:terminate.
    await h.bus.fire('session:terminate', ctx, { sessionId: 'sess-live' });

    expect(turnErrors).toEqual([
      { reqId: 'r-live', reason: 'sandbox-terminated' },
    ]);

    // Resolve the still-pending invoke so the test doesn't leak a timer.
    await h.bus.fire('chat:end', ctx, {
      outcome: { kind: 'terminated', reason: 'sandbox-terminated' },
    });
    await invokePromise;
  });

  it('session:terminate with no in-flight turn does NOT fire chat:turn-error', async () => {
    const mocks = buildMocks();
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 1_000,
        }),
      ],
    });

    const turnErrors: unknown[] = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p);
      return undefined;
    });

    await h.bus.fire(
      'session:terminate',
      turnErrorCtx('ghost', 'r-ghost'),
      { sessionId: 'ghost' },
    );

    expect(turnErrors).toEqual([]);
  });

  it('a completed turn does NOT fire chat:turn-error', async () => {
    const expectedOutcome: AgentOutcome = {
      kind: 'complete',
      messages: [{ role: 'assistant', content: 'done' }],
    };
    let busRef: HookBus | null = null;
    const mocks = buildMocks({
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        const originatingReqId = ctx.reqId;
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeAgentContext({
              sessionId,
              agentId: 'agent',
              userId: 'user',
              reqId: originatingReqId,
              logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
            }),
            { outcome: expectedOutcome },
          );
        });
        return {
          runnerEndpoint: 'unix:///tmp/ok.sock',
          handle: { kill: async () => undefined, exited: new Promise(() => undefined) },
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
    busRef = h.bus;

    const turnErrors: unknown[] = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      turnErrorCtx('ok-session', 'r-ok'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome).toEqual(expectedOutcome);
    expect(turnErrors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // chat:turn-error (F2b) — a turn can end abnormally WITHOUT the chokepoint
  // synthesizing it: the runner POSTs event.chat-end{terminated} before
  // crashing (e.g. choking on resume of an interrupted transcript), or an
  // early-spawn step fails. onChatEnd (the chat:end subscriber) surfaces the
  // turn-error for the runner-reported live-crash case; the early-spawn
  // returns fire it explicitly. The runner-reported chat:end RESTAMPS reqId,
  // so it carries conversationId for the SSE to match instead.
  // -------------------------------------------------------------------------

  it('F2b: a runner-reported terminated chat:end fires chat:turn-error with the ORIGINAL reqId (recovered, not the restamped one)', async () => {
    let busRef: HookBus | null = null;
    const mocks = buildMocks({
      openSession: async (_ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        // The runner crashed mid-resume and POSTed event.chat-end{terminated}
        // before exiting. The IPC server fires chat:end with a FRESH reqId
        // (restamped per request) + a stamped conversationId. resolveWaiterFor
        // recovers the ORIGINAL agent:invoke reqId via the sessionId fallback,
        // so the turn-error fires with 'r-orig' (the SSE's precise per-turn
        // key), NOT 'r-ipc-restamped' and NOT a coarse conversationId match.
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeAgentContext({
              sessionId,
              agentId: 'agent',
              userId: 'user',
              reqId: 'r-ipc-restamped',
              conversationId: 'cnv-x',
              logger: createLogger({ reqId: 'r-ipc-restamped', writer: () => undefined }),
            }),
            { outcome: { kind: 'terminated', reason: 'Error: resume boom' } },
          );
        });
        return {
          runnerEndpoint: 'unix:///tmp/crash.sock',
          handle: { kill: async () => undefined, exited: new Promise(() => undefined) },
        };
      },
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 1_000 }),
      ],
    });
    busRef = h.bus;

    const turnErrors: Array<{ reqId?: string; reason?: string }> = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p as { reqId?: string; reason?: string });
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      turnErrorCtx('crash-session', 'r-orig'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('terminated');
    // Fires with the recovered ORIGINAL reqId, not the IPC-restamped one.
    expect(turnErrors).toEqual([
      { reqId: 'r-orig', reason: 'Error: resume boom' },
    ]);
  });

  it('F2b: a terminated chat:end with NO in-flight waiter does NOT fire chat:turn-error', async () => {
    // Guards both double-fire (chokepoint already settled the deferred + fired
    // its own turn-error) and spurious-fire (a reaped warm runner POSTs a late
    // terminated chat:end after its turn already completed).
    const mocks = buildMocks();
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 1_000 }),
      ],
    });
    const turnErrors: unknown[] = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p);
      return undefined;
    });
    await h.bus.fire('chat:end', turnErrorCtx('ghost-sess', 'r-ghost'), {
      outcome: { kind: 'terminated', reason: 'late-reap' },
    });
    expect(turnErrors).toEqual([]);
  });

  it('F2b: a completed (kind=complete) chat:end with a live waiter does NOT fire chat:turn-error', async () => {
    // A normal completed turn resolves a live waiter — wasInFlight is true,
    // but a 'complete' outcome must NEVER surface as a turn-error.
    let busRef: HookBus | null = null;
    const mocks = buildMocks({
      openSession: async (_ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeAgentContext({
              sessionId,
              agentId: 'agent',
              userId: 'user',
              reqId: 'r-ipc-restamped',
              conversationId: 'cnv-ok',
              logger: createLogger({ reqId: 'r-ipc-restamped', writer: () => undefined }),
            }),
            { outcome: { kind: 'complete', messages: [{ role: 'assistant', content: 'ok' }] } },
          );
        });
        return {
          runnerEndpoint: 'unix:///tmp/ok.sock',
          handle: { kill: async () => undefined, exited: new Promise(() => undefined) },
        };
      },
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 1_000 }),
      ],
    });
    busRef = h.bus;
    const turnErrors: unknown[] = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p);
      return undefined;
    });
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      turnErrorCtx('ok-session-2', 'r-orig'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(turnErrors).toEqual([]);
  });

  it('F2b: early-spawn sandbox-open-failed fires chat:turn-error with the originating reqId', async () => {
    const mocks = buildMocks({
      openSession: async () => {
        throw new Error('open boom');
      },
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 1_000 }),
      ],
    });
    const turnErrors: Array<{ reqId?: string; reason?: string }> = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p as { reqId?: string; reason?: string });
      return undefined;
    });
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      turnErrorCtx('open-fail-sess', 'r-open'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe('sandbox-open-failed');
    expect(turnErrors).toEqual([
      { reqId: 'r-open', reason: 'sandbox-open-failed' },
    ]);
  });

  it('F2b: early-spawn queue-work-failed fires chat:turn-error with the originating reqId', async () => {
    const mocks = buildMocks({
      queueWork: async () => {
        throw new Error('queue boom');
      },
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 1_000 }),
      ],
    });
    const turnErrors: Array<{ reqId?: string; reason?: string }> = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p as { reqId?: string; reason?: string });
      return undefined;
    });
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      turnErrorCtx('queue-fail-sess', 'r-queue'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe('queue-work-failed');
    expect(turnErrors).toEqual([
      { reqId: 'r-queue', reason: 'queue-work-failed' },
    ]);
  });

  it('chat:end fires exactly once across all exit paths', async () => {
    // We already assert single-fire in each scenario above; this is a
    // parametrized sweep so a regression in any one path lights up loudly.
    const scenarios: Array<{
      name: string;
      setup: (services: Record<string, ServiceHandler>) => ServiceHandler | undefined;
      input: AgentMessage;
      startBlock?: boolean;
      expectKind: AgentOutcome['kind'];
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
      const outcome = await h.bus.call<unknown, AgentOutcome>(
        'agent:invoke',
        silentCtx(`scenario-${s.name}`),
        { message: s.input },
      );
      expect(outcome.kind, `scenario ${s.name}`).toBe(s.expectKind);
      expect(endCount, `scenario ${s.name}`).toBe(1);
    }
  });

  // ---------------------------------------------------------------------
  // Week 9.5 — agents:resolve gate
  // ---------------------------------------------------------------------

  it('agents:resolve rejecting forbidden → terminated outcome with reason agent-resolve:forbidden, sandbox NOT opened', async () => {
    const mocks = buildMocks({
      agentsResolve: async () => {
        throw new PluginError({
          code: 'forbidden',
          plugin: '@ax/agents',
          hookName: 'agents:resolve',
          message: `agent 'a-1' not accessible to user 'u-1'`,
        });
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
    const endFires: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('forbidden-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('agent-resolve:forbidden');
    }
    // Sandbox MUST NOT be opened when ACL rejects.
    expect(mocks.calls.sandboxOpen).toBe(0);
    // chat:end fires exactly once on the rejection path.
    expect(endFires).toHaveLength(1);
  });

  it('agents:resolve rejecting not-found → terminated outcome with reason agent-resolve:not-found', async () => {
    const mocks = buildMocks({
      agentsResolve: async () => {
        throw new PluginError({
          code: 'not-found',
          plugin: '@ax/agents',
          hookName: 'agents:resolve',
          message: `agent 'no-such' not found`,
        });
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
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('nf-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('agent-resolve:not-found');
    }
    expect(mocks.calls.sandboxOpen).toBe(0);
  });

  it('agents:resolve happy path passes the agent owner triple to sandbox:open-session', async () => {
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          id: 'a-resolved',
          systemPrompt: 'you are a poet',
          allowedTools: ['file.read', 'bash.exec'],
          mcpConfigIds: ['mcp-1'],
          model: 'claude-opus-4-7',
        },
      }),
    });
    let busRef: HookBus | null = null;
    // Replace open-session with a happy-path version that fires chat:end.
    mocks.services['sandbox:open-session'] = async (ctx, input: unknown) => {
      mocks.calls.sandboxOpen += 1;
      mocks.calls.lastSandboxInput = input;
      const sessionId = (input as { sessionId: string }).sessionId;
      const originatingReqId = ctx.reqId;
      setImmediate(() => {
        void busRef!.fire(
          'chat:end',
          makeAgentContext({
            sessionId,
            agentId: 'a-resolved',
            userId: 'test-user',
            reqId: originatingReqId,
            logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
          }),
          { outcome: { kind: 'complete', messages: [] } },
        );
      });
      return {
        runnerEndpoint: 'unix:///tmp/x.sock',
        handle: {
          kill: async () => undefined,
          exited: new Promise(() => undefined),
        },
      };
    };

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

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('owned-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(mocks.calls.agentsResolve).toBe(1);
    expect(mocks.calls.sandboxOpen).toBe(1);
    // The owner field carries through to sandbox:open-session unchanged.
    const last = mocks.calls.lastSandboxInput as {
      owner: {
        userId: string;
        agentId: string;
        agentConfig: {
          systemPrompt: string;
          allowedTools: string[];
          mcpConfigIds: string[];
          model: string;
        };
      };
    };
    expect(last.owner.userId).toBe('test-user');
    expect(last.owner.agentId).toBe('a-resolved');
    expect(last.owner.agentConfig).toEqual({
      systemPrompt: 'you are a poet',
      // TASK-51/76: this agent is non-wildcard (explicit tools + mcpConfigIds),
      // so the always-on broker tools (incl. skill_propose, TASK-76) are locked
      // into the frozen allowedTools at session-open. The agent's own tools come
      // first, broker tools appended.
      allowedTools: [
        'file.read',
        'bash.exec',
        'search_catalog',
        'request_capability',
        'skill_propose',
        'connector_propose',
      ],
      mcpConfigIds: ['mcp-1'],
      model: 'claude-opus-4-7',
    });
  });

  // -------------------------------------------------------------------------
  // TASK-51 (JIT §P4) — the always-on broker tools (search_catalog +
  // request_capability) are locked into every MULTI-TENANT (non-wildcard)
  // agent's effective allowedTools at session-open, while the empty-empty
  // wildcard sentinel is preserved. We assert on the frozen agentConfig that
  // flows into sandbox:open-session (lastSandboxInput.owner.agentConfig).
  // -------------------------------------------------------------------------

  // Replace sandbox:open-session with a happy-path version that records the
  // input and fires chat:end, so the orchestrator returns `complete`. Returns
  // a getter for the frozen agentConfig the orchestrator passed through.
  function withRecordingOpenSession(
    mocks: MockBundle,
    getBus: () => HookBus | null,
  ): () => { allowedTools: string[]; mcpConfigIds: string[] } {
    mocks.services['sandbox:open-session'] = async (ctx, input: unknown) => {
      mocks.calls.sandboxOpen += 1;
      mocks.calls.lastSandboxInput = input;
      const sessionId = (input as { sessionId: string }).sessionId;
      const originatingReqId = ctx.reqId;
      setImmediate(() => {
        void getBus()!.fire(
          'chat:end',
          makeAgentContext({
            sessionId,
            agentId: 'a-resolved',
            userId: 'test-user',
            reqId: originatingReqId,
            logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
          }),
          { outcome: { kind: 'complete', messages: [] } },
        );
      });
      return {
        runnerEndpoint: 'unix:///tmp/x.sock',
        handle: { kill: async () => undefined, exited: new Promise(() => undefined) },
      };
    };
    return () => {
      const last = mocks.calls.lastSandboxInput as {
        owner: { agentConfig: { allowedTools: string[]; mcpConfigIds: string[] } };
      };
      return last.owner.agentConfig;
    };
  }

  it('TASK-51: locks broker tools into a non-wildcard agent (allowedTools-based scope)', async () => {
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: { ...TEST_AGENT, id: 'a-resolved', allowedTools: ['file.read'], mcpConfigIds: [] },
      }),
    });
    let busRef: HookBus | null = null;
    const getConfig = withRecordingOpenSession(mocks, () => busRef);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/x', chatTimeoutMs: 5_000 })],
    });
    busRef = h.bus;
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('s1'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    // Agent's own tool first, broker tools appended (order-stable).
    expect(getConfig().allowedTools).toEqual([
      'file.read',
      'search_catalog',
      'request_capability',
      'skill_propose',
      'connector_propose',
    ]);
  });

  it('TASK-51: PRESERVES the empty-empty wildcard sentinel (no broker injection)', async () => {
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: { ...TEST_AGENT, id: 'a-resolved', allowedTools: [], mcpConfigIds: [] },
      }),
    });
    let busRef: HookBus | null = null;
    const getConfig = withRecordingOpenSession(mocks, () => busRef);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/x', chatTimeoutMs: 5_000 })],
    });
    busRef = h.bus;
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('s2'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    // Wildcard agent already sees the whole catalog (incl. broker) via
    // filterByAgentScope — injecting would SHRINK it to broker-only. Untouched.
    expect(getConfig().allowedTools).toEqual([]);
  });

  it('TASK-51: locks broker tools into an mcpConfig-only (non-wildcard) agent', async () => {
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: { ...TEST_AGENT, id: 'a-resolved', allowedTools: [], mcpConfigIds: ['mcp-1'] },
      }),
    });
    let busRef: HookBus | null = null;
    const getConfig = withRecordingOpenSession(mocks, () => busRef);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/x', chatTimeoutMs: 5_000 })],
    });
    busRef = h.bus;
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('s3'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    // Non-wildcard via mcpConfigIds → allowedTools was [] but gets the broker
    // tools (the agent's mcp tools still come through the mcpConfigIds path).
    expect(getConfig().allowedTools).toEqual([
      'search_catalog',
      'request_capability',
      'skill_propose',
      'connector_propose',
    ]);
    expect(getConfig().mcpConfigIds).toEqual(['mcp-1']);
  });

  it('TASK-51: does not duplicate a broker tool the agent already lists', async () => {
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          id: 'a-resolved',
          allowedTools: ['search_catalog', 'file.read'],
          mcpConfigIds: [],
        },
      }),
    });
    let busRef: HookBus | null = null;
    const getConfig = withRecordingOpenSession(mocks, () => busRef);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/x', chatTimeoutMs: 5_000 })],
    });
    busRef = h.bus;
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('s4'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    // search_catalog already present → not duplicated; request_capability +
    // skill_propose + connector_propose appended (TASK-76 / TASK-95).
    expect(getConfig().allowedTools).toEqual([
      'search_catalog',
      'file.read',
      'request_capability',
      'skill_propose',
      'connector_propose',
    ]);
  });

  it('agents:resolve throwing a non-PluginError → terminated outcome with the bus-wrapped code', async () => {
    // The bus wraps non-PluginError throws as PluginError(code='unknown').
    // We document and depend on that wrapping here so the orchestrator's
    // reason-prefix is stable even when the agents impl throws something
    // weird.
    const mocks = buildMocks({
      agentsResolve: async () => {
        throw new Error('database fell over');
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
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('boom-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('agent-resolve:unknown');
    }
  });

  // ---------------------------------------------------------------------
  // Phase 2 — proxy:open-session / proxy:close-session lifecycle
  //
  // The orchestrator opens a per-session credential-proxy session BEFORE
  // sandbox:open-session (when the proxy plugin is loaded; soft dep via
  // bus.hasService) and closes it in finally. Tests cover:
  //   1. Forwarding parity: proxyConfig threads through to sandbox:open-
  //      session unchanged.
  //   2. Happy-path close: proxy:close-session fires after chat:end.
  //   3. Throw safety: proxy:close-session fires even when sandbox:open-
  //      session throws (the half-open window must not leak proxy
  //      sessions).
  // Three structurally-similar setups are factored out below.
  // ---------------------------------------------------------------------

  interface ProxyHookState {
    openCalls: number;
    closeCalls: number;
    rotateCalls: number;
    lastOpenInput: unknown;
    lastRotateInput: unknown;
  }
  function buildProxyHooks(opts: {
    openOutput?: {
      proxyEndpoint: string;
      caCertPem: string;
      envMap: Record<string, string>;
      proxyAuthToken?: string;
    };
    openThrows?: Error;
    /** When true, `proxy:rotate-session` is also registered (Phase 3 I10). */
    includeRotate?: boolean;
    /** When set, `proxy:rotate-session` rejects with this error each time. */
    rotateThrows?: Error;
  } = {}): { state: ProxyHookState; services: Record<string, ServiceHandler> } {
    const state: ProxyHookState = {
      openCalls: 0,
      closeCalls: 0,
      rotateCalls: 0,
      lastOpenInput: undefined,
      lastRotateInput: undefined,
    };
    const services: Record<string, ServiceHandler> = {
      'proxy:open-session': async (_ctx, input) => {
        state.openCalls += 1;
        state.lastOpenInput = input;
        if (opts.openThrows !== undefined) throw opts.openThrows;
        return (
          opts.openOutput ?? {
            proxyEndpoint: 'tcp://127.0.0.1:54321',
            caCertPem: 'TEST-CA-PEM',
            envMap: { ANTHROPIC_API_KEY: 'ax-cred:0123' },
          }
        );
      },
      'proxy:close-session': async () => {
        state.closeCalls += 1;
        return {};
      },
    };
    if (opts.includeRotate) {
      services['proxy:rotate-session'] = async (_ctx, input) => {
        state.rotateCalls += 1;
        state.lastRotateInput = input;
        if (opts.rotateThrows !== undefined) throw opts.rotateThrows;
        return { envMap: { ANTHROPIC_API_KEY: 'ax-cred:0123' } };
      };
    }
    return { state, services };
  }

  it('forwards proxyConfig from agent:invoke into sandbox:open-session', async () => {
    const proxy = buildProxyHooks();
    let busRef: HookBus | null = null;
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
        },
      }),
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        const originatingReqId = ctx.reqId;
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeAgentContext({
              sessionId,
              agentId: 'a',
              userId: 'u',
              reqId: originatingReqId,
              logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
            }),
            { outcome: { kind: 'complete', messages: [] } },
          );
        });
        return {
          runnerEndpoint: 'unix:///tmp/x.sock',
          handle: {
            kill: async () => undefined,
            exited: new Promise(() => undefined),
          },
        };
      },
    });
    Object.assign(mocks.services, proxy.services);
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

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-forward-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(proxy.state.openCalls).toBe(1);

    // proxy:open-session payload carries the agent's allowlist + creds.
    const openIn = proxy.state.lastOpenInput as {
      sessionId: string;
      userId: string;
      agentId: string;
      allowlist: string[];
      credentials: Record<string, { ref: string; kind: string }>;
    };
    expect(openIn.sessionId).toBe('proxy-forward-session');
    expect(openIn.userId).toBe('test-user');
    expect(openIn.allowlist).toEqual(['api.anthropic.com']);
    expect(openIn.credentials).toEqual({
      ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
    });

    // sandbox:open-session received the translated proxyConfig (tcp:// →
    // http:// loopback URL; PEM bytes verbatim; envMap forwarded as-is).
    const sb = mocks.calls.lastSandboxInput as { proxyConfig?: unknown };
    expect(sb.proxyConfig).toEqual({
      endpoint: 'http://127.0.0.1:54321',
      caCertPem: 'TEST-CA-PEM',
      envMap: { ANTHROPIC_API_KEY: 'ax-cred:0123' },
    });
  });

  it('threads proxyAuthToken from proxy:open-session into proxyConfig (TASK-52)', async () => {
    const proxy = buildProxyHooks({
      openOutput: {
        proxyEndpoint: 'tcp://127.0.0.1:54321',
        caCertPem: 'TEST-CA-PEM',
        envMap: { ANTHROPIC_API_KEY: 'ax-cred:0123' },
        proxyAuthToken: 'a'.repeat(32),
      },
    });
    let busRef: HookBus | null = null;
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
        },
      }),
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        const originatingReqId = ctx.reqId;
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeAgentContext({
              sessionId,
              agentId: 'a',
              userId: 'u',
              reqId: originatingReqId,
              logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
            }),
            { outcome: { kind: 'complete', messages: [] } },
          );
        });
        return {
          runnerEndpoint: 'unix:///tmp/x.sock',
          handle: {
            kill: async () => undefined,
            exited: new Promise(() => undefined),
          },
        };
      },
    });
    Object.assign(mocks.services, proxy.services);
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

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-token-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    // The minted token lands on the proxyConfig the sandbox receives, alongside
    // the translated endpoint — so the runner can embed it as Proxy-Authorization.
    const sb = mocks.calls.lastSandboxInput as {
      proxyConfig?: { proxyAuthToken?: string; endpoint?: string };
    };
    expect(sb.proxyConfig?.proxyAuthToken).toBe('a'.repeat(32));
    expect(sb.proxyConfig?.endpoint).toBe('http://127.0.0.1:54321');
  });

  it('terminates with agent-proxy-config-incomplete when only allowedHosts is set on the agent', async () => {
    // Regression: defaults used to apply field-by-field, so an agent with
    // `allowedHosts: ['api.openai.com']` but no requiredCredentials would
    // get a mixed config — the OpenAI allowlist alongside the Anthropic
    // credential ref. Either over-permits egress or breaks the agent's
    // real provider. The fix: fall back only when BOTH fields are
    // missing; a partial config raises loud at agent:invoke time.
    const proxy = buildProxyHooks();
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.openai.com'],
          // requiredCredentials intentionally omitted
        },
      }),
    });
    Object.assign(mocks.services, proxy.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-partial-config'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe(
      'agent-proxy-config-incomplete',
    );
    // Loud: never opened a session with the mixed config.
    expect(proxy.state.openCalls).toBe(0);
  });

  it('terminates with agent-proxy-config-incomplete when only requiredCredentials is set on the agent', async () => {
    // Mirror of the previous test for the other half of the partial-
    // config bug.
    const proxy = buildProxyHooks();
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          // allowedHosts intentionally omitted
          requiredCredentials: {
            OPENAI_API_KEY: { ref: 'openai-api', kind: 'api-key' },
          },
        },
      }),
    });
    Object.assign(mocks.services, proxy.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-partial-config-2'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe(
      'agent-proxy-config-incomplete',
    );
    expect(proxy.state.openCalls).toBe(0);
  });

  it('translates a unix:// proxyEndpoint into proxyConfig.unixSocketPath', async () => {
    const proxy = buildProxyHooks({
      openOutput: {
        proxyEndpoint: 'unix:///var/run/ax/proxy.sock',
        caCertPem: 'CA',
        envMap: {},
      },
    });
    let busRef: HookBus | null = null;
    const mocks = buildMocks({
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        const originatingReqId = ctx.reqId;
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeAgentContext({
              sessionId,
              agentId: 'a',
              userId: 'u',
              reqId: originatingReqId,
              logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
            }),
            { outcome: { kind: 'complete', messages: [] } },
          );
        });
        return {
          runnerEndpoint: 'unix:///tmp/x.sock',
          handle: {
            kill: async () => undefined,
            exited: new Promise(() => undefined),
          },
        };
      },
    });
    Object.assign(mocks.services, proxy.services);
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
    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-unix-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    const sb = mocks.calls.lastSandboxInput as { proxyConfig?: unknown };
    expect(sb.proxyConfig).toEqual({
      unixSocketPath: '/var/run/ax/proxy.sock',
      caCertPem: 'CA',
      envMap: {},
    });
  });

  it('calls proxy:close-session in finally on the happy path', async () => {
    const proxy = buildProxyHooks();
    let busRef: HookBus | null = null;
    const mocks = buildMocks({
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        const originatingReqId = ctx.reqId;
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeAgentContext({
              sessionId,
              agentId: 'a',
              userId: 'u',
              reqId: originatingReqId,
              logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
            }),
            { outcome: { kind: 'complete', messages: [] } },
          );
        });
        return {
          runnerEndpoint: 'unix:///tmp/x.sock',
          handle: {
            kill: async () => undefined,
            exited: new Promise(() => undefined),
          },
        };
      },
    });
    Object.assign(mocks.services, proxy.services);
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

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-happy-close'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(proxy.state.closeCalls).toBe(1);
  });

  it('calls proxy:close-session in finally even when sandbox:open-session throws', async () => {
    const proxy = buildProxyHooks();
    const mocks = buildMocks({
      openSession: async () => {
        throw new Error('spawn failure');
      },
    });
    Object.assign(mocks.services, proxy.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 1_000,
        }),
      ],
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-throw-close'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    // proxy was opened (sandbox throws AFTER proxy:open-session resolves)
    // so the finally MUST close it — otherwise the proxy session leaks.
    expect(proxy.state.openCalls).toBe(1);
    expect(proxy.state.closeCalls).toBe(1);
  });

  it('closes the proxy session even when endpointToProxyConfig throws on a bad scheme', async () => {
    // Regression: proxyOpened must flip BEFORE the scheme-translation step,
    // so a `proxy:open-session` that returned a successful payload but the
    // translator rejects (unknown scheme) still closes the upstream session.
    // Otherwise the proxy leaks one session per misconfigured deploy.
    const proxy = buildProxyHooks({
      openOutput: {
        // unrecognized scheme: not unix:// nor tcp:// — endpointToProxyConfig
        // throws PluginError('invalid-proxy-endpoint').
        proxyEndpoint: 'http://oops:54321',
        caCertPem: 'CA',
        envMap: {},
      },
    });
    const mocks = buildMocks();
    Object.assign(mocks.services, proxy.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 1_000,
        }),
      ],
    });
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-bad-scheme'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('proxy-open-failed');
    }
    expect(proxy.state.openCalls).toBe(1);
    // Critical: close MUST fire even though translation threw — otherwise
    // the upstream proxy session leaks.
    expect(proxy.state.closeCalls).toBe(1);
    // Sandbox MUST NOT be opened on a proxy-open failure path.
    expect(mocks.calls.sandboxOpen).toBe(0);
  });

  // TASK-22 — credential resolution failure at session-open must SURFACE a
  // turn error to the client, not hang it. When `proxy:open-session` throws
  // (the runtime Anthropic key can't be resolved/decrypted), the orchestrator
  // returns terminated(proxy-open-failed) and fires chat:end — but it ALSO
  // fires chat:turn-error so the channel-web SSE writes a terminal error frame
  // and the client flips out of "Thinking…". Before the fix this path fired
  // chat:end only; because the per-turn waiter is registered AFTER the proxy-
  // open block, onChatEnd's F2b fallback found no live waiter and skipped its
  // turn-error fire too — so NOTHING surfaced and the turn hung forever.
  it('TASK-22: proxy:open-session failure (credential resolution) fires chat:turn-error with the originating reqId', async () => {
    const proxy = buildProxyHooks({
      // Simulate `credentials:get` / decrypt failing inside the proxy plugin —
      // the orchestrator only sees the open-session call reject.
      openThrows: new Error('credential resolution failed: cannot decrypt provider:anthropic'),
    });
    const mocks = buildMocks();
    Object.assign(mocks.services, proxy.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 1_000 }),
      ],
    });
    const turnErrors: Array<{ reqId?: string; reason?: string }> = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p as { reqId?: string; reason?: string });
      return undefined;
    });
    const endFires: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'end-obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      turnErrorCtx('cred-fail-sess', 'r-cred'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe('proxy-open-failed');
    // The fix: a turn-error MUST surface, keyed on the originating reqId so the
    // SSE matches the exact turn and closes the stream (error + retry).
    expect(turnErrors).toEqual([{ reqId: 'r-cred', reason: 'proxy-open-failed' }]);
    // chat:end still fires exactly once (audit invariant) — unchanged.
    expect(endFires).toHaveLength(1);
    // No sandbox/runner is ever spawned on this path.
    expect(mocks.calls.sandboxOpen).toBe(0);
    // The raw credential-resolution error must NOT leak to the SSE — only the
    // coarse `reason` enum crosses to the (untrusted) client. The full error
    // stays on the audit chat:end outcome.
    expect((endFires[0] as { error?: unknown }).error).toBeInstanceOf(Error);
    expect(turnErrors[0]).not.toHaveProperty('error');
  });

  // TASK-22 — sibling pre-waiter early-return: same swallow-the-error class.
  // A skewed/missing proxy config (proxy-hooks-misconfigured) must also surface
  // a turn error rather than hang. Locks the whole class, not just the
  // credential path the QA sweep happened to trip.
  it('TASK-22: proxy-hooks-misconfigured fires chat:turn-error with the originating reqId', async () => {
    const mocks = buildMocks({ omitProxyStubs: true });
    // Register ONLY open (no close) → open/close skew → proxy-hooks-misconfigured.
    mocks.services['proxy:open-session'] = async () => ({
      proxyEndpoint: 'tcp://127.0.0.1:1',
      caCertPem: '',
      envMap: {},
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 1_000 }),
      ],
    });
    const turnErrors: Array<{ reqId?: string; reason?: string }> = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p as { reqId?: string; reason?: string });
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      turnErrorCtx('skew-sess', 'r-skew'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe('proxy-hooks-misconfigured');
    expect(turnErrors).toEqual([{ reqId: 'r-skew', reason: 'proxy-hooks-misconfigured' }]);
    expect(mocks.calls.sandboxOpen).toBe(0);
  });

  // TASK-22 — earliest pre-waiter early-return: a failed agents:resolve (ACL
  // forbidden / not-found / internal) is dispatched fire-and-forget by
  // channel-web (202 returned; the synchronous outcome is discarded), so the
  // SSE is the only client signal. It must surface a turn-error, not hang.
  it('TASK-22: agents:resolve failure fires chat:turn-error with the originating reqId', async () => {
    const mocks = buildMocks({
      agentsResolve: async () => {
        throw new PluginError({
          code: 'forbidden',
          plugin: '@ax/agents',
          message: 'agent not reachable by this user',
        });
      },
    });
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 1_000 }),
      ],
    });
    const turnErrors: Array<{ reqId?: string; reason?: string }> = [];
    h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
      turnErrors.push(p as { reqId?: string; reason?: string });
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      turnErrorCtx('acl-fail-sess', 'r-acl'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe('agent-resolve:forbidden');
    expect(turnErrors).toEqual([{ reqId: 'r-acl', reason: 'agent-resolve:forbidden' }]);
    expect(mocks.calls.sandboxOpen).toBe(0);
  });

  it('terminates with proxy-hooks-misconfigured when only proxy:open-session is registered', async () => {
    // A skewed preset that wires open without close would leak sessions
    // on every invoke. We refuse to enable proxy mode in that case and
    // surface a clear `proxy-hooks-misconfigured` outcome so audit-log
    // and operators see the misconfiguration immediately.
    const mocks = buildMocks({ omitProxyStubs: true });
    // Register ONLY proxy:open-session, NOT proxy:close-session.
    mocks.services['proxy:open-session'] = async () => ({
      proxyEndpoint: 'tcp://127.0.0.1:1',
      caCertPem: '',
      envMap: {},
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
    const endFires: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-half-wired'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('proxy-hooks-misconfigured');
    }
    expect(mocks.calls.sandboxOpen).toBe(0);
    expect(endFires).toHaveLength(1);
  });

  it('terminates with proxy-not-loaded when neither proxy hook is registered', async () => {
    // Phase 6 made @ax/credential-proxy mandatory. With both proxy hooks
    // missing, the orchestrator MUST refuse to open a sandbox at all and
    // surface a structured `proxy-not-loaded` outcome at agent:invoke time
    // — proceeding would force real credentials into the sandbox env (I1)
    // and the runner would fail at boot anyway with a worse error path.
    //
    // I7: this exit fires BEFORE proxyOpened can be set, so proxy:close-
    //     session must NOT be called. We register a close-only spy below
    //     and assert it was never invoked.
    // I18: distinct from `proxy-hooks-misconfigured` (skewed open/close).
    const mocks = buildMocks({ omitProxyStubs: true });
    // Register a close-only spy. open-session stays unregistered — that's
    // the gate's trigger. If the orchestrator wrongly tried to close, the
    // spy would catch it.
    let proxyCloseCalls = 0;
    mocks.services['proxy:close-session'] = async () => {
      proxyCloseCalls += 1;
      return {};
    };
    const endFires: AgentOutcome[] = [];

    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 1_000,
        }),
      ],
    });
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-not-loaded'),
      { message: { role: 'user', content: 'hi' } },
    );

    // First, the orchestrator should have hit the open/close skew gate
    // (open missing, close present) and returned `proxy-hooks-misconfigured`
    // — NOT `proxy-not-loaded`. Both diagnostics are valid, but the skew
    // path is checked first. So we re-run with neither hook registered to
    // assert the `proxy-not-loaded` path specifically.
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('proxy-hooks-misconfigured');
    }
    expect(proxyCloseCalls).toBe(0); // I7 — close never called
    expect(mocks.calls.sandboxOpen).toBe(0);
    expect(endFires).toHaveLength(1); // I1

    // Now the actual `proxy-not-loaded` case: drop the close-only spy too.
    delete mocks.services['proxy:close-session'];
    proxyCloseCalls = 0;
    endFires.length = 0;

    const h2 = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 1_000,
        }),
      ],
    });
    h2.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const outcome2 = await h2.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('proxy-not-loaded'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome2.kind).toBe('terminated');
    if (outcome2.kind === 'terminated') {
      expect(outcome2.reason).toBe('proxy-not-loaded');
      // I18: the new outcome is distinct from skew-misconfigured.
      expect(outcome2.reason).not.toBe('proxy-hooks-misconfigured');
    }
    // I7: sandbox never opened, so proxyOpened never set, so nothing to close.
    // (proxyCloseCalls is structurally zero here — no spy registered at all
    // means a stray close call would throw NoServiceError, even stronger.)
    expect(mocks.calls.sandboxOpen).toBe(0);
    // I1: chat:end fires exactly once on this exit path.
    expect(endFires).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // Phase 3 — proxy:rotate-session at turn boundaries (I10, I11)
  //
  // OAuth sessions need to pick up refreshed tokens between internal turns
  // (model→tool→model→tool). The orchestrator subscribes to chat:turn-end
  // and fires proxy:rotate-session for sessions whose agent has at least
  // one credential with kind != 'api-key'. api-key-only sessions skip the
  // rotation entirely (Phase 2 coarse mode is unchanged).
  // ---------------------------------------------------------------------

  function fireTurnEndAndChatEnd(
    busRef: { current: HookBus | null },
    sessionId: string,
    originatingReqId: string,
  ): void {
    setImmediate(() => {
      const turnCtx = makeAgentContext({
        sessionId,
        agentId: 'a',
        userId: 'u',
        reqId: originatingReqId,
        logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
      });
      void busRef
        .current!.fire('chat:turn-end', turnCtx, {})
        .then(() =>
          busRef.current!.fire('chat:end', turnCtx, {
            outcome: { kind: 'complete', messages: [] },
          }),
        );
    });
  }

  it('fires proxy:rotate-session at chat:turn-end for OAuth sessions (I10)', async () => {
    const proxy = buildProxyHooks({ includeRotate: true });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            CLAUDE_CODE_OAUTH_TOKEN: {
              ref: 'anthropic-personal',
              kind: 'anthropic-oauth',
            },
          },
        },
      }),
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        fireTurnEndAndChatEnd(busRef, sessionId, ctx.reqId);
        return {
          runnerEndpoint: 'unix:///tmp/x.sock',
          handle: {
            kill: async () => undefined,
            exited: new Promise(() => undefined),
          },
        };
      },
    });
    Object.assign(mocks.services, proxy.services);
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
      silentCtx('rotate-oauth-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(proxy.state.rotateCalls).toBe(1);
    expect((proxy.state.lastRotateInput as { sessionId?: string }).sessionId).toBe(
      'rotate-oauth-session',
    );
  });

  it('does NOT fire proxy:rotate-session for api-key-only sessions', async () => {
    const proxy = buildProxyHooks({ includeRotate: true });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
        },
      }),
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        fireTurnEndAndChatEnd(busRef, sessionId, ctx.reqId);
        return {
          runnerEndpoint: 'unix:///tmp/x.sock',
          handle: {
            kill: async () => undefined,
            exited: new Promise(() => undefined),
          },
        };
      },
    });
    Object.assign(mocks.services, proxy.services);
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
      silentCtx('apikey-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(proxy.state.rotateCalls).toBe(0);
  });

  it('survives proxy:rotate-session failure without aborting the chat', async () => {
    // I10 says rotate is fire-and-forget; a failing rotate must not surface
    // as a chat termination. The chat completes normally; the warning lives
    // in logs (we don't capture them in this test).
    const proxy = buildProxyHooks({
      includeRotate: true,
      rotateThrows: new Error('simulated rotate failure'),
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            CLAUDE_CODE_OAUTH_TOKEN: {
              ref: 'anthropic-personal',
              kind: 'anthropic-oauth',
            },
          },
        },
      }),
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        fireTurnEndAndChatEnd(busRef, sessionId, ctx.reqId);
        return {
          runnerEndpoint: 'unix:///tmp/x.sock',
          handle: {
            kill: async () => undefined,
            exited: new Promise(() => undefined),
          },
        };
      },
    });
    Object.assign(mocks.services, proxy.services);
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
      silentCtx('rotate-fails-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(proxy.state.rotateCalls).toBe(1);
  });

  it('does NOT fire proxy:rotate-session when the hook is not registered', async () => {
    // OAuth credential present but proxy:rotate-session is not loaded —
    // orchestrator must skip cleanly (Phase 2 coarse-mode behavior).
    const proxy = buildProxyHooks({ includeRotate: false });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            CLAUDE_CODE_OAUTH_TOKEN: {
              ref: 'anthropic-personal',
              kind: 'anthropic-oauth',
            },
          },
        },
      }),
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        fireTurnEndAndChatEnd(busRef, sessionId, ctx.reqId);
        return {
          runnerEndpoint: 'unix:///tmp/x.sock',
          handle: {
            kill: async () => undefined,
            exited: new Promise(() => undefined),
          },
        };
      },
    });
    Object.assign(mocks.services, proxy.services);
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
      silentCtx('no-rotate-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(proxy.state.rotateCalls).toBe(0);
  });

  it('multiple concurrent agent:invokes with different sessionIds do not cross-contaminate', async () => {
    let busRef: HookBus | null = null;

    const mocks = buildMocks({
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        const originatingReqId = ctx.reqId;
        // Each "runner" emits a distinct complete outcome echoing its sessionId
        // so we can verify the orchestrator routed the right outcome back to
        // the right caller.
        setImmediate(() => {
          void busRef!.fire(
            'chat:end',
            makeAgentContext({
              sessionId,
              agentId: 'a',
              userId: 'u',
              reqId: originatingReqId,
              logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
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
      h.bus.call<unknown, AgentOutcome>('agent:invoke', silentCtx('session-A'), {
        message: { role: 'user', content: 'hi-A' },
      }),
      h.bus.call<unknown, AgentOutcome>('agent:invoke', silentCtx('session-B'), {
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

  // ---------------------------------------------------------------------
  // Phase 1 (skill-install) — skill attachment union step
  //
  // The orchestrator resolves agent.skillAttachments via skills:resolve
  // before proxy:open-session, unions allowedHosts (set-dedup), and
  // merges credentialBindings (per slot) into the proxy call. Three new
  // termination outcomes: skill-resolve-failed, skill-binding-missing,
  // skill-slot-collision.
  // ---------------------------------------------------------------------

  interface ResolvedSkill {
    id: string;
    capabilities: {
      allowedHosts: string[];
      credentials: Array<{ slot: string; kind: string; description?: string }>;
      // Phase B — bundled MCP server specs. Optional in the test fixture for
      // back-compat with existing tests; the orchestrator's `?? []` defense
      // turns undefined into an empty array on the wire.
      mcpServers?: Array<{
        name: string;
        transport: 'stdio' | 'http';
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        allowedHosts: string[];
        credentials: Array<{ slot: string; kind: 'api-key' }>;
      }>;
      // D: optional in test fixtures so existing tests don't need to declare it.
      packages?: { npm?: string[]; pypi?: string[] };
    };
    bodyMd: string;
    manifestYaml: string;
    // JIT Phase 1a — extra (non-SKILL.md) bundle files. Optional in fixtures.
    files?: Array<{ path: string; contents: string }>;
    // TASK-111 — the skill's connector references. Optional in fixtures.
    connectors?: string[];
  }

  interface SkillsHookState {
    resolveCalls: number;
    lastResolveInput: unknown;
  }

  function buildSkillsHooks(opts: {
    resolveThrows?: unknown;
    skills?: Record<string, ResolvedSkill>;
  }): { state: SkillsHookState; services: Record<string, ServiceHandler> } {
    const state: SkillsHookState = {
      resolveCalls: 0,
      lastResolveInput: undefined,
    };
    const services: Record<string, ServiceHandler> = {
      'skills:resolve': async (_ctx, input) => {
        state.resolveCalls += 1;
        state.lastResolveInput = input;
        if (opts.resolveThrows !== undefined) throw opts.resolveThrows;
        const requested = (input as { skillIds: string[] }).skillIds;
        return {
          skills: requested
            .map((id) => opts.skills?.[id])
            .filter((s): s is ResolvedSkill => s !== undefined),
        };
      },
    };
    return { state, services };
  }

  // Builds a happy-path open-session that fires chat:end via the bus.
  function makeChatEndOpenSession(
    busRef: { current: HookBus | null },
  ): ServiceHandler {
    return async (ctx, input: unknown) => {
      const sessionId = (input as { sessionId: string }).sessionId;
      const originatingReqId = ctx.reqId;
      setImmediate(() => {
        void busRef.current!.fire(
          'chat:end',
          makeAgentContext({
            sessionId,
            agentId: 'a',
            userId: 'u',
            reqId: originatingReqId,
            logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
          }),
          { outcome: { kind: 'complete', messages: [] } },
        );
      });
      return {
        runnerEndpoint: 'unix:///tmp/x.sock',
        handle: {
          kill: async () => undefined,
          exited: new Promise(() => undefined),
        },
      };
    };
  }

  it('TASK-100: an attached skill contributes NO host/credential to proxy:open-session (its reach is its connector)', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        github: {
          id: 'github',
          connectors: [],
          bodyMd: 'Use the GitHub API.',
          manifestYaml: 'name: github\nversion: 1.0.0\n',
        },
      },
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [
            { skillId: 'github', credentialBindings: {} },
          ],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('skill-union-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(skillsHooks.state.resolveCalls).toBe(1);

    const openIn = proxy.state.lastOpenInput as {
      allowlist: string[];
      credentials: Record<string, { ref: string; kind: string }>;
    };
    // The AGENT's own host/cred reach the proxy.
    expect(openIn.allowlist).toContain('api.anthropic.com');
    expect(openIn.credentials).toMatchObject({
      ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
    });
    // TASK-100 — the SKILL declares no caps, so its (former) host/credential do
    // NOT reach the proxy. A skill's reach is the connectors it references
    // (folded via the connector path, covered by connector-union.test.ts).
    expect(openIn.allowlist).not.toContain('api.github.com');
    expect(openIn.credentials['skill:github:GITHUB_TOKEN']).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // TASK-111 — the skill→connector cap-resolution bridge. A skill declares
  // the connectors it uses via its top-level connectors[]; the orchestrator
  // resolves each via connectors:resolve and folds its reach through the
  // SAME path the agent effective connector set uses. The skill's own
  // capability block keeps materializing in parallel (no regression).
  // ---------------------------------------------------------------------

  /** A connectors:resolve stub: resolves each id from the supplied map; an id
   *  not in the map throws (exercises the NON-FATAL skip). Records resolve calls. */
  function buildConnectorResolveHook(
    connectors: Record<
      string,
      {
        allowedHosts: string[];
        credentials: Array<{ slot: string; kind: 'api-key'; account?: string }>;
        mcpServers?: unknown[];
        packages?: { npm?: string[]; pypi?: string[] };
      }
    >,
  ): { resolveCalls: string[]; services: Record<string, ServiceHandler> } {
    const resolveCalls: string[] = [];
    return {
      resolveCalls,
      services: {
        'connectors:resolve': async (_ctx, input) => {
          const id = (input as { connectorId: string }).connectorId;
          resolveCalls.push(id);
          const c = connectors[id];
          if (c === undefined) throw new Error(`connector '${id}' not found`);
          return {
            id,
            keyMode: 'personal',
            capabilities: {
              allowedHosts: c.allowedHosts,
              credentials: c.credentials,
              mcpServers: c.mcpServers ?? [],
              packages: c.packages ?? { npm: [], pypi: [] },
            },
            credentialPlan: [],
            requiresSharedKeyConsent: false,
          };
        },
      },
    };
  }

  it('TASK-111: resolves a skill\'s connectors[] into sandbox caps (hosts + creds + installed entry)', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        'linear-triage': {
          id: 'linear-triage',
          // The skill carries NO capability block of its own — its reach comes
          // entirely from the referenced connector (the connectors-first-class
          // shape). connectors[] used to be dead-on-arrival; this is the bridge.
          capabilities: { allowedHosts: [], credentials: [] },
          connectors: ['linear'],
          bodyMd: 'Triage the Linear cycle.',
          manifestYaml: 'name: linear-triage\nversion: 1\nconnectors: [linear]\n',
        },
      },
    });
    const connHook = buildConnectorResolveHook({
      linear: {
        allowedHosts: ['api.linear.app'],
        credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
      },
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [{ skillId: 'linear-triage', credentialBindings: {} }],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services, connHook.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('skill-connector-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    // The skill's referenced connector was resolved.
    expect(connHook.resolveCalls).toEqual(['linear']);

    const openIn = proxy.state.lastOpenInput as {
      allowlist: string[];
      credentials: Record<string, { ref: string; kind: string }>;
    };
    // The connector's host reached the proxy allowlist.
    expect(openIn.allowlist).toContain('api.linear.app');
    // The connector's credential slot reached the credential map under the
    // connector namespace (`connector:<id>:<slot>`), ref = account:<connectorId>.
    expect(openIn.credentials).toMatchObject({
      'connector:linear:LINEAR_API_KEY': { ref: 'account:linear', kind: 'api-key' },
    });

    // A synthetic connector installed-skill entry reached the sandbox spawn.
    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string }>;
    };
    const ids = (sandboxIn.installedSkills ?? []).map((s) => s.id);
    expect(ids.some((id) => id.startsWith('cx-linear-'))).toBe(true);
  });

  it('TASK-111: a connector that is BOTH a skill reference AND in the effective set is folded once', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        's': {
          id: 's',
          capabilities: { allowedHosts: [], credentials: [] },
          connectors: ['shared'],
          bodyMd: 'body',
          manifestYaml: 'name: s\nversion: 1\nconnectors: [shared]\n',
        },
      },
    });
    const connHook = buildConnectorResolveHook({
      shared: {
        allowedHosts: ['api.shared.example'],
        credentials: [],
      },
    });
    // The agent effective set ALSO carries `shared` (owner's own connector),
    // so the skill reference must dedup against it — resolved by the effective
    // path, NOT re-resolved by the skill path.
    const effectiveServices: Record<string, ServiceHandler> = {
      'connectors:list': async () => ({ connectors: [{ id: 'shared' }] }),
    };
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [{ skillId: 's', credentialBindings: {} }],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(
      mocks.services,
      proxy.services,
      skillsHooks.services,
      connHook.services,
      effectiveServices,
    );
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;
    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('skill-connector-dedup'),
      { message: { role: 'user', content: 'hi' } },
    );
    // `shared` resolved exactly once (via the effective `connectors:list` →
    // `connectors:resolve`); the skill path saw it in alreadyResolved and skipped.
    expect(connHook.resolveCalls.filter((id) => id === 'shared')).toHaveLength(1);
    // Folded once → exactly one installed entry for it.
    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string }>;
    };
    const sharedEntries = (sandboxIn.installedSkills ?? []).filter((s) =>
      s.id.startsWith(`cx-shared-`),
    );
    expect(sharedEntries).toHaveLength(1);
  });

  it('TASK-100: a skill that references no connectors contributes NO reach (instruction-only)', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        github: {
          id: 'github',
          connectors: [], // references no connectors → zero reach
          bodyMd: 'Use the GitHub API.',
          manifestYaml: 'name: github\nversion: 1\n',
        },
      },
    });
    // connectors:resolve registered but should NEVER be called (no references).
    const connHook = buildConnectorResolveHook({});
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [
            { skillId: 'github', credentialBindings: {} },
          ],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services, connHook.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('legacy-skill-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    // The skill declares no caps + references no connectors → no reach of its own.
    const openIn = proxy.state.lastOpenInput as {
      allowlist: string[];
      credentials: Record<string, { ref: string; kind: string }>;
    };
    expect(openIn.allowlist).not.toContain('api.github.com');
    expect(openIn.credentials['skill:github:GITHUB_TOKEN']).toBeUndefined();
    // No connector resolution happened (the skill referenced none).
    expect(connHook.resolveCalls).toEqual([]);
  });

  it('TASK-33: per-user attachment beats agent-global on id collision and unions a per-user-only skill', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        github: {
          id: 'github',
          capabilities: { allowedHosts: ['api.github.com'], credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }] },
          bodyMd: 'gh', manifestYaml: 'name: github\nversion: 1\n',
        },
        linear: {
          id: 'linear',
          capabilities: { allowedHosts: ['api.linear.app'], credentials: [] },
          bodyMd: 'ln', manifestYaml: 'name: linear\nversion: 1\n',
        },
      },
    });

    // Per-user attachments: github (overrides the agent-global binding) + a
    // per-user-only linear. Record the query args to assert (user, agent) scope.
    let listInput: unknown;
    skillsHooks.services['skills:list-user-attachments'] = async (_ctx, input) => {
      listInput = input;
      return {
        attachments: [
          { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'per-user-pat' } },
          { skillId: 'linear', credentialBindings: {} },
        ],
      };
    };

    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          // Agent-global attaches github with a DIFFERENT binding — per-user must win.
          skillAttachments: [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'agent-global-pat' } }],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('per-user-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    // Read hook queried per (user, agent).
    expect(listInput).toEqual({ userId: 'test-user', agentId: 'test-agent' });
    // resolve engaged the content-override path (ownerUserId threaded).
    expect((skillsHooks.state.lastResolveInput as { ownerUserId?: string }).ownerUserId).toBe('test-user');

    const openIn = proxy.state.lastOpenInput as {
      allowlist: string[];
      credentials: Record<string, { ref: string; kind: string }>;
    };
    // Per-user-only skill's host is unioned in.
    expect(openIn.allowlist).toContain('api.linear.app');
    expect(openIn.allowlist).toContain('api.github.com');
    // Per-user binding WINS over the agent-global binding for the same skill+slot
    // (TASK-86 — keyed by the per-skill namespace).
    expect(openIn.credentials['skill:github:GITHUB_TOKEN']).toEqual({ ref: 'per-user-pat', kind: 'api-key' });
  });

  it('TASK-33: with no per-user attachments, agent-global behavior is unchanged', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        github: {
          id: 'github',
          capabilities: { allowedHosts: ['api.github.com'], credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }] },
          bodyMd: 'gh', manifestYaml: 'name: github\nversion: 1\n',
        },
      },
    });
    // Read hook returns empty → behavior identical to pre-TASK-33.
    skillsHooks.services['skills:list-user-attachments'] = async () => ({ attachments: [] });

    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'agent-global-pat' } }],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('no-per-user-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    const openIn = proxy.state.lastOpenInput as {
      allowlist: string[];
      credentials: Record<string, { ref: string; kind: string }>;
    };
    expect(openIn.allowlist).toContain('api.github.com');
    // The agent-global binding is used unchanged when there's no per-user layer
    // (TASK-86 — keyed by the per-skill namespace).
    expect(openIn.credentials['skill:github:GITHUB_TOKEN']).toEqual({ ref: 'agent-global-pat', kind: 'api-key' });
  });

  it('TASK-33: a thrown skills:list-user-attachments FAILS CLOSED (does not silently use agent-global creds)', async () => {
    // Codex P1: list-user-attachments is credential-bearing — it decides which
    // refs reach proxy:open-session and the per-user > agent-global precedence.
    // A transient read failure must NOT silently fall back to the agent-global
    // binding for a slot the user meant to override; the turn must terminate
    // (matching the skills:resolve fail-closed precedent in the same function).
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        github: {
          id: 'github',
          capabilities: { allowedHosts: ['api.github.com'], credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }] },
          bodyMd: 'gh', manifestYaml: 'name: github\nversion: 1\n',
        },
      },
    });
    skillsHooks.services['skills:list-user-attachments'] = async () => {
      throw new Error('transient per-user read failure');
    };

    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'agent-global-pat' } }],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('per-user-read-fail-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    // Fail closed: terminated, and the session never opened with the fallback creds.
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('user-attachments-failed');
    }
    expect(proxy.state.lastOpenInput).toBeUndefined();
  });

  it('TASK-44: unions persisted host grants into the proxy:open-session allowlist', async () => {
    const proxy = buildProxyHooks();
    let listInput: unknown;
    const hostGrants: Record<string, ServiceHandler> = {
      'host-grants:list': async (_ctx, input) => {
        listInput = input;
        return { hosts: [{ host: 'persisted.example.com', grantedAt: new Date().toISOString() }] };
      },
    };
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, hostGrants);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('host-grants-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    // Keyed by (user, agent) — never a browser-supplied id.
    expect(listInput).toEqual({ ownerUserId: 'test-user', agentId: 'test-agent' });
    const openIn = proxy.state.lastOpenInput as { allowlist: string[] };
    expect(openIn.allowlist).toContain('persisted.example.com');
  });

  it('TASK-44: fails OPEN when host-grants:list throws — session still opens, host absent', async () => {
    const proxy = buildProxyHooks();
    const hostGrants: Record<string, ServiceHandler> = {
      'host-grants:list': async () => {
        throw new Error('db down');
      },
    };
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, hostGrants);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('host-grants-failopen-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    // Credential-free read: a throw FAILS OPEN — the turn completes and the
    // session opens; the persisted host is simply absent (fewer, never more).
    expect(outcome.kind).toBe('complete');
    const openIn = proxy.state.lastOpenInput as { allowlist: string[] };
    expect(openIn).toBeDefined();
    expect(openIn.allowlist).not.toContain('persisted.example.com');
  });

  it('auto-unions registry.npmjs.org when a skill declares packages.npm (D)', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        linear: {
          id: 'linear',
          capabilities: {
            allowedHosts: [],
            credentials: [],
            packages: { npm: ['@linear/cli'] },
          },
          bodyMd: 'Use the Linear CLI.',
          manifestYaml: 'name: linear\nversion: 1.0.0\n',
        },
      },
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [{ skillId: 'linear', credentialBindings: {} }],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;
    await h.bus.call<unknown, AgentOutcome>('agent:invoke', silentCtx('npm-pkg-session'), { message: { role: 'user', content: 'hi' } });
    const openIn = proxy.state.lastOpenInput as { allowlist: string[] };
    expect(openIn.allowlist).toContain('registry.npmjs.org');
  });

  it('auto-unions pypi.org + files.pythonhosted.org for packages.pypi (D)', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        pyskill: {
          id: 'pyskill',
          capabilities: {
            allowedHosts: [],
            credentials: [],
            packages: { pypi: ['some-tool'] },
          },
          bodyMd: 'Use the some-tool CLI.',
          manifestYaml: 'name: pyskill\nversion: 1.0.0\n',
        },
      },
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [{ skillId: 'pyskill', credentialBindings: {} }],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;
    await h.bus.call<unknown, AgentOutcome>('agent:invoke', silentCtx('pypi-pkg-session'), { message: { role: 'user', content: 'hi' } });
    const openIn = proxy.state.lastOpenInput as { allowlist: string[] };
    expect(openIn.allowlist).toEqual(expect.arrayContaining(['pypi.org', 'files.pythonhosted.org']));
  });

  it('unions no registry hosts when no packages are declared (D)', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        nopkgs: {
          id: 'nopkgs',
          capabilities: {
            allowedHosts: ['api.example.com'],
            credentials: [],
            packages: { npm: [], pypi: [] },
          },
          bodyMd: 'A skill with no packages.',
          manifestYaml: 'name: nopkgs\nversion: 1.0.0\n',
        },
      },
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [{ skillId: 'nopkgs', credentialBindings: {} }],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;
    await h.bus.call<unknown, AgentOutcome>('agent:invoke', silentCtx('nopkgs-session'), { message: { role: 'user', content: 'hi' } });
    const openIn = proxy.state.lastOpenInput as { allowlist: string[] };
    expect(openIn.allowlist).not.toContain('registry.npmjs.org');
    expect(openIn.allowlist).not.toContain('pypi.org');
  });

  it('auto-unions registry hosts for a DEFAULT-attached skill declaring packages (D)', async () => {
    // Regression: default-attached skills are materialized into the sandbox (their
    // SKILL.md instructs the agent to run the CLI), so a default skill's declared
    // ecosystem must reach the registry allowlist too — not only explicit attachments.
    const proxy = buildProxyHooks();
    const defaultSkill: ResolvedSkill = {
      id: 'default-cli',
      capabilities: {
        allowedHosts: [],
        credentials: [],
        packages: { npm: ['@linear/cli'], pypi: ['some-tool'] },
      },
      bodyMd: '# default-cli\n',
      manifestYaml: 'name: default-cli\ndescription: dc\n',
    };
    const defaults = buildDefaultsHook({ skills: [defaultSkill] });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          // No explicit skillAttachments — the packages come purely from defaults.
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, defaults.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;
    await h.bus.call<unknown, AgentOutcome>('agent:invoke', silentCtx('default-pkg-session'), { message: { role: 'user', content: 'hi' } });
    const openIn = proxy.state.lastOpenInput as { allowlist: string[] };
    expect(openIn.allowlist).toEqual(
      expect.arrayContaining(['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']),
    );
  });

  // -------------------------------------------------------------------------
  // TASK-97 — connector union into the sandbox. The orchestrator resolves the
  // agent's effective connector set (defaults + the owner's own) and folds each
  // connector's Capabilities through the SAME materialization path as skills.
  // -------------------------------------------------------------------------
  interface ConnectorCapsLike {
    allowedHosts: string[];
    credentials: Array<{ slot: string; kind: 'api-key'; account?: string }>;
    mcpServers: Array<Record<string, unknown>>;
    packages?: { npm?: string[]; pypi?: string[] };
  }
  /** Stubs the connector hooks the orchestrator soft-couples to. `defaults` are
   *  returned full from connectors:list-defaults; `owned` are listed (id-only)
   *  + resolved on demand. `listDefaultsThrows` exercises the non-fatal path. */
  function buildConnectorHooks(opts: {
    defaults?: Record<string, { capabilities: ConnectorCapsLike; usageNote?: string }>;
    owned?: Record<string, { capabilities: ConnectorCapsLike; usageNote?: string }>;
    listDefaultsThrows?: Error;
  }): Record<string, ServiceHandler> {
    const defaults = opts.defaults ?? {};
    const owned = opts.owned ?? {};
    return {
      'connectors:list-defaults': async () => {
        if (opts.listDefaultsThrows !== undefined) throw opts.listDefaultsThrows;
        return {
          connectors: Object.entries(defaults).map(([id, c]) => ({
            id,
            capabilities: c.capabilities,
            ...(c.usageNote !== undefined ? { usageNote: c.usageNote } : {}),
          })),
        };
      },
      'connectors:list': async () => ({
        connectors: Object.keys(owned).map((id) => ({ id })),
      }),
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        const c = owned[id];
        if (c === undefined) throw new Error(`no connector ${id}`);
        return {
          id,
          capabilities: c.capabilities,
          ...(c.usageNote !== undefined ? { usageNote: c.usageNote } : {}),
        };
      },
    };
  }

  it('TASK-97: unions default + owned connector hosts/creds/packages into proxy:open-session and mcpServers into sandbox installedSkills', async () => {
    const proxy = buildProxyHooks();
    const connectorHooks = buildConnectorHooks({
      defaults: {
        gdrive: {
          usageNote: 'Use this to read Drive docs.',
          capabilities: {
            allowedHosts: ['drive.googleapis.com'],
            credentials: [{ slot: 'GDRIVE', kind: 'api-key', account: 'google' }],
            mcpServers: [
              {
                name: 'gdrive',
                transport: 'http',
                url: 'https://mcp.example.com/gdrive',
                allowedHosts: ['mcp.example.com'],
                credentials: [],
              },
            ],
            packages: { npm: [], pypi: [] },
          },
        },
      },
      owned: {
        sf: {
          capabilities: {
            allowedHosts: ['login.salesforce.com'],
            credentials: [{ slot: 'SF_TOKEN', kind: 'api-key' }],
            mcpServers: [],
            packages: { npm: ['@salesforce/cli'], pypi: [] },
          },
        },
      },
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, connectorHooks);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('connector-union-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    const openIn = proxy.state.lastOpenInput as {
      allowlist: string[];
      credentials: Record<string, { ref: string; kind: string }>;
    };
    // Hosts from BOTH connectors land in the allowlist.
    expect(openIn.allowlist).toContain('drive.googleapis.com');
    expect(openIn.allowlist).toContain('login.salesforce.com');
    // The owned connector declared an npm package → registry auto-allowed.
    expect(openIn.allowlist).toContain('registry.npmjs.org');
    // Credential slot env-names are namespaced under the CONNECTOR namespace; the
    // REF is the `account:<service>` vault key TASK-96's connect flow writes —
    // account-tagged GDRIVE → account:google; untagged SF_TOKEN → account:sf
    // (the connector-id service-tag fallback, one source of truth).
    expect(openIn.credentials).toMatchObject({
      ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
      'connector:gdrive:GDRIVE': { ref: 'account:google', kind: 'api-key' },
      'connector:sf:SF_TOKEN': { ref: 'account:sf', kind: 'api-key' },
    });

    // The connector's mcpServers reach the sandbox as an installed-skill entry
    // (synthetic SKILL.md = usage note). The dir id is the sandbox-safe form.
    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{
        id: string;
        files: Array<{ path: string; contents: string }>;
        mcpServers: Array<unknown>;
      }>;
    };
    const entries = sandboxIn.installedSkills ?? [];
    const gdriveEntry = entries.find((e) => e.id.startsWith('cx-gdrive-'));
    expect(gdriveEntry).toBeTruthy();
    expect(gdriveEntry!.mcpServers).toHaveLength(1);
    const skillMd = gdriveEntry!.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd!.contents).toContain('Use this to read Drive docs.');
  });

  it('TASK-97: a connector host dedups against a skill host (one allowlist entry); shared bare slot coexists', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        gh: {
          id: 'gh',
          capabilities: {
            allowedHosts: ['api.shared.example.com'],
            credentials: [{ slot: 'SHARED_KEY', kind: 'api-key' }],
          },
          bodyMd: 'gh',
          manifestYaml: 'name: gh\nversion: 1\n',
        },
      },
    });
    const connectorHooks = buildConnectorHooks({
      defaults: {
        cx: {
          capabilities: {
            // Same host the skill declares → must dedup to ONE allowlist entry.
            allowedHosts: ['api.shared.example.com'],
            // Same BARE slot name the skill declares → must coexist (namespaced).
            credentials: [{ slot: 'SHARED_KEY', kind: 'api-key' }],
            mcpServers: [],
            packages: { npm: [], pypi: [] },
          },
        },
      },
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [{ skillId: 'gh', credentialBindings: { SHARED_KEY: 'skill-ref' } }],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services, connectorHooks);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('connector-dedup-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    const openIn = proxy.state.lastOpenInput as {
      allowlist: string[];
      credentials: Record<string, { ref: string; kind: string }>;
    };
    // Host dedups: appears exactly once despite both subjects declaring it.
    expect(openIn.allowlist.filter((h2) => h2 === 'api.shared.example.com')).toHaveLength(1);
    // The skill slot and the connector slot COEXIST under distinct namespaces;
    // the connector's REF is its `account:<connectorId>` vault key.
    expect(openIn.credentials).toMatchObject({
      'skill:gh:SHARED_KEY': { ref: 'skill-ref', kind: 'api-key' },
      'connector:cx:SHARED_KEY': { ref: 'account:cx', kind: 'api-key' },
    });
  });

  it('TASK-97: a throwing connectors:list-defaults is NON-FATAL — session opens, skill caps intact', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        gh: {
          id: 'gh',
          capabilities: { allowedHosts: ['api.github.com'], credentials: [] },
          bodyMd: 'gh',
          manifestYaml: 'name: gh\nversion: 1\n',
        },
      },
    });
    const connectorHooks = buildConnectorHooks({
      listDefaultsThrows: new Error('connectors db down'),
      // No owned connectors registered either — but list/resolve still present.
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [{ skillId: 'gh', credentialBindings: {} }],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services, connectorHooks);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('connector-nonfatal-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    // Session NOT terminated — the connector failure is non-fatal.
    expect(outcome.kind).toBe('complete');
    // The skill host still reached the sandbox (skill caps unaffected).
    const openIn = proxy.state.lastOpenInput as { allowlist: string[] };
    expect(openIn.allowlist).toContain('api.github.com');
  });

  it('threads installedSkills into sandbox:open-session with correct SKILL.md content', async () => {
    const proxy = buildProxyHooks();
    const manifestYaml = 'name: github\nversion: 1.0.0\n';
    const bodyMd = 'Use the GitHub API.';
    const skillsHooks = buildSkillsHooks({
      skills: {
        github: {
          id: 'github',
          capabilities: {
            allowedHosts: ['api.github.com'],
            credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
          },
          bodyMd,
          manifestYaml,
          files: [{ path: 'scripts/a.py', contents: 'print(1)' }],
        },
      },
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [
            { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'gh-pat' } },
          ],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('skill-sandbox-session'),
      { message: { role: 'user', content: 'hi' } },
    );

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{
        id: string;
        files: Array<{ path: string; contents: string }>;
        mcpServers: Array<unknown>;
      }>;
    };
    expect(sandboxIn.installedSkills).toHaveLength(1);
    const entry = sandboxIn.installedSkills![0]!;
    expect(entry.id).toBe('github');
    // JIT Phase 1a — the bundle is a file tree. SKILL.md is reconstructed from
    // the manifest columns; extra files ride alongside; the legacy `skillMd`
    // string field is gone.
    expect('skillMd' in entry).toBe(false);
    const skillMd = entry.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd).toBeTruthy();
    expect(skillMd!.contents).toMatch(/^---\nname: github\nversion: 1\.0\.0\n---\n/);
    expect(skillMd!.contents).toContain('Use the GitHub API.');
    // The resolved extra file is materialized verbatim alongside SKILL.md.
    expect(entry.files.find((f) => f.path === 'scripts/a.py')?.contents).toBe('print(1)');
    // Phase B regression — a skill that declares NO mcpServers still threads
    // an EMPTY ARRAY (not undefined) through to the sandbox so downstream
    // .mcp.json materialization can branch on `length > 0` cleanly.
    expect(entry.mcpServers).toEqual([]);
  });

  it('unions skill-bundled mcpServers into the sandbox open-session input', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        github: {
          id: 'github',
          capabilities: {
            allowedHosts: ['api.github.com'],
            credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
            mcpServers: [
              {
                name: 'github',
                transport: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
                env: { GITHUB_TOKEN: '$GITHUB_TOKEN' },
                allowedHosts: ['api.github.com'],
                credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
              },
            ],
          },
          bodyMd: 'Use the GitHub MCP server.',
          manifestYaml: 'name: github\nversion: 1.0.0\n',
        },
      },
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [
            { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'gh-pat' } },
          ],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('skill-mcp-session'),
      { message: { role: 'user', content: 'hi' } },
    );

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{
        id: string;
        files: Array<{ path: string; contents: string }>;
        mcpServers: Array<{ name: string; transport: string; command?: string }>;
      }>;
    };
    expect(sandboxIn.installedSkills).toHaveLength(1);
    expect(sandboxIn.installedSkills![0]!.mcpServers).toEqual([
      expect.objectContaining({ name: 'github', transport: 'stdio', command: 'npx' }),
    ]);
  });

  it('does NOT call skills:resolve when agent has no skillAttachments', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({ skills: {} });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          // No skillAttachments field — old agent row shape.
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('no-skills-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(skillsHooks.state.resolveCalls).toBe(0);
  });

  it('drops unknown skill ids silently (deleted-skill-still-attached) without terminating', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        github: {
          id: 'github',
          capabilities: {
            allowedHosts: ['api.github.com'],
            credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
          },
          bodyMd: 'GitHub',
          manifestYaml: 'name: github\n',
        },
        // 'vanished' is NOT in the resolved set
      },
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [
            { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'gh-pat' } },
            { skillId: 'vanished', credentialBindings: {} },
          ],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('deleted-skill-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    // Must succeed — the vanished skill is silently dropped.
    expect(outcome.kind).toBe('complete');
    expect(mocks.calls.sandboxOpen).toBe(1);

    const openIn = proxy.state.lastOpenInput as { allowlist: string[]; credentials: Record<string, unknown> };
    expect(openIn.allowlist).toContain('api.github.com');
    // TASK-86 — the skill slot is keyed by its per-skill namespace.
    expect(openIn.credentials).toHaveProperty('skill:github:GITHUB_TOKEN');
  });

  it('terminates with skill-binding-missing when a required slot has no binding', async () => {
    const proxy = buildProxyHooks();
    const skillsHooks = buildSkillsHooks({
      skills: {
        github: {
          id: 'github',
          capabilities: {
            allowedHosts: ['api.github.com'],
            credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
          },
          bodyMd: 'GitHub',
          manifestYaml: 'name: github\n',
        },
      },
    });
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [
            {
              skillId: 'github',
              credentialBindings: {}, // GITHUB_TOKEN binding is absent
            },
          ],
        },
      }),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });

    const endFires: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('binding-missing-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe('skill-binding-missing');
    // proxy:open-session must NOT be called — abort happens before the proxy step.
    expect(proxy.state.openCalls).toBe(0);
    expect(mocks.calls.sandboxOpen).toBe(0);
    expect(endFires).toHaveLength(1);
  });

  it('TASK-86: two catalog skills declaring the same slot COEXIST (no collision, namespaced creds)', async () => {
    // Namespaced envMap so the orchestrator's env projection has placeholders to
    // map back to bare names.
    const proxy = buildProxyHooks({
      openOutput: {
        proxyEndpoint: 'tcp://127.0.0.1:54321',
        caCertPem: 'TEST-CA-PEM',
        envMap: {
          ANTHROPIC_API_KEY: 'ax-cred:00000000000000000000000000000000',
          'skill:skill-a:OPENAI_API_KEY': 'ax-cred:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'skill:skill-b:OPENAI_API_KEY': 'ax-cred:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
    });
    const skillsHooks = buildSkillsHooks({
      skills: {
        'skill-a': {
          id: 'skill-a',
          capabilities: {
            allowedHosts: ['api.example.com'],
            credentials: [{ slot: 'OPENAI_API_KEY', kind: 'api-key' }],
          },
          bodyMd: 'A',
          manifestYaml: 'name: skill-a\n',
        },
        'skill-b': {
          id: 'skill-b',
          capabilities: {
            allowedHosts: ['api.other.com'],
            credentials: [{ slot: 'OPENAI_API_KEY', kind: 'api-key' }], // same slot
          },
          bodyMd: 'B',
          manifestYaml: 'name: skill-b\n',
        },
      },
    });
    let busRefA: HookBus | null = null;
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [
            { skillId: 'skill-a', credentialBindings: { OPENAI_API_KEY: 'ref-a' } },
            { skillId: 'skill-b', credentialBindings: { OPENAI_API_KEY: 'ref-b' } },
          ],
        },
      }),
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        const originatingReqId = ctx.reqId;
        setImmediate(() => {
          void busRefA!.fire(
            'chat:end',
            makeAgentContext({
              sessionId, agentId: 'a', userId: 'u', reqId: originatingReqId,
              logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
            }),
            { outcome: { kind: 'complete', messages: [] } },
          );
        });
        return {
          runnerEndpoint: 'unix:///tmp/x.sock',
          handle: { kill: async () => undefined, exited: new Promise(() => undefined) },
        };
      },
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRefA = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('slot-coexist-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    // No lockout: the turn completes instead of terminating.
    expect(outcome.kind).toBe('complete');
    expect(proxy.state.openCalls).toBe(1);
    // Each skill's credential is present under its OWN namespaced key, with its
    // OWN ref — each resolves its own credential.
    const openIn = proxy.state.lastOpenInput as {
      credentials: Record<string, { ref: string; kind: string }>;
    };
    expect(openIn.credentials['skill:skill-a:OPENAI_API_KEY']).toEqual({
      ref: 'ref-a',
      kind: 'api-key',
    });
    expect(openIn.credentials['skill:skill-b:OPENAI_API_KEY']).toEqual({
      ref: 'ref-b',
      kind: 'api-key',
    });
    // The sandbox sees the BARE env-var name (the skill reads $OPENAI_API_KEY).
    // Among two skills sharing the bare name, the FIRST (skill-a) wins the flat
    // env stamp; skill-b's credential still reached the proxy (above) and rides
    // its own per-skill git placeholder (asserted via installedSkills below).
    const sandboxIn = mocks.calls.lastSandboxInput as {
      proxyConfig?: { envMap: Record<string, string> };
      installedSkills?: Array<{
        id: string;
        credentials: Array<{ slot: string; placeholder?: string }>;
      }>;
    };
    expect(sandboxIn.proxyConfig?.envMap['OPENAI_API_KEY']).toBe(
      'ax-cred:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    // No namespaced key leaks into the flat sandbox env.
    expect(sandboxIn.proxyConfig?.envMap['skill:skill-a:OPENAI_API_KEY']).toBeUndefined();
    expect(sandboxIn.proxyConfig?.envMap['skill:skill-b:OPENAI_API_KEY']).toBeUndefined();
    // Each skill carries its OWN placeholder for per-skill git wiring.
    const skillB = sandboxIn.installedSkills?.find((s) => s.id === 'skill-b');
    expect(skillB?.credentials[0]?.placeholder).toBe(
      'ax-cred:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
  });

  it('TASK-86: a skill slot colliding with agent.requiredCredentials no longer terminates (trusted wins)', async () => {
    const proxy = buildProxyHooks({
      openOutput: {
        proxyEndpoint: 'tcp://127.0.0.1:54321',
        caCertPem: 'TEST-CA-PEM',
        envMap: {
          ANTHROPIC_API_KEY: 'ax-cred:00000000000000000000000000000000',
          'skill:badskill:ANTHROPIC_API_KEY': 'ax-cred:ffffffffffffffffffffffffffffffff',
        },
      },
    });
    const skillsHooks = buildSkillsHooks({
      skills: {
        badskill: {
          id: 'badskill',
          capabilities: {
            allowedHosts: ['api.example.com'],
            credentials: [
              { slot: 'ANTHROPIC_API_KEY', kind: 'api-key' }, // same name as agent default
            ],
          },
          bodyMd: 'Bad skill',
          manifestYaml: 'name: badskill\n',
        },
      },
    });
    let busRefB: HookBus | null = null;
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [
            {
              skillId: 'badskill',
              credentialBindings: { ANTHROPIC_API_KEY: 'some-other-ref' },
            },
          ],
        },
      }),
      openSession: async (ctx, input: unknown) => {
        const sessionId = (input as { sessionId: string }).sessionId;
        const originatingReqId = ctx.reqId;
        setImmediate(() => {
          void busRefB!.fire(
            'chat:end',
            makeAgentContext({
              sessionId, agentId: 'a', userId: 'u', reqId: originatingReqId,
              logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
            }),
            { outcome: { kind: 'complete', messages: [] } },
          );
        });
        return {
          runnerEndpoint: 'unix:///tmp/x.sock',
          handle: { kill: async () => undefined, exited: new Promise(() => undefined) },
        };
      },
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRefB = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('agent-slot-coexist-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    // No lockout — the trusted credential simply wins; the skill can't hijack it.
    expect(outcome.kind).toBe('complete');
    expect(proxy.state.openCalls).toBe(1);
    const openIn = proxy.state.lastOpenInput as {
      credentials: Record<string, { ref: string; kind: string }>;
    };
    // The trusted bare credential is untouched; the skill's slot lives under its
    // own namespaced key (so it can't overwrite the trusted one).
    expect(openIn.credentials['ANTHROPIC_API_KEY']).toEqual({
      ref: 'provider:anthropic',
      kind: 'api-key',
    });
    expect(openIn.credentials['skill:badskill:ANTHROPIC_API_KEY']).toEqual({
      ref: 'some-other-ref',
      kind: 'api-key',
    });
    // The sandbox's flat ANTHROPIC_API_KEY is the TRUSTED placeholder — never the
    // skill's. The skill cannot hijack the trusted credential.
    const sandboxIn = mocks.calls.lastSandboxInput as {
      proxyConfig?: { envMap: Record<string, string> };
    };
    expect(sandboxIn.proxyConfig?.envMap['ANTHROPIC_API_KEY']).toBe(
      'ax-cred:00000000000000000000000000000000',
    );
    expect(mocks.calls.sandboxOpen).toBe(1);
  });

  it('terminates with skill-resolve-failed when skills:resolve throws', async () => {
    const proxy = buildProxyHooks();
    const resolveError = new Error('skills store unreachable');
    const skillsHooks = buildSkillsHooks({ resolveThrows: resolveError });
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [
            { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref' } },
          ],
        },
      }),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });

    const endFires: AgentOutcome[] = [];
    h.bus.subscribe('chat:end', 'obs', async (_ctx, p: unknown) => {
      endFires.push((p as { outcome: AgentOutcome }).outcome);
      return undefined;
    });

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('resolve-failed-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe('skill-resolve-failed');
    expect((outcome as { error?: unknown }).error).toBeDefined();
    expect(proxy.state.openCalls).toBe(0);
    expect(mocks.calls.sandboxOpen).toBe(0);
    expect(endFires).toHaveLength(1);
  });

  it('skips skill resolution entirely when skills:resolve service is not registered', async () => {
    // Soft-coupling: a stripped preset (no @ax/skills) must not crash.
    // Agent has skillAttachments but no skills:resolve service → flow
    // proceeds with agent's own allowedHosts only.
    const proxy = buildProxyHooks();
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: {
            ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' },
          },
          skillAttachments: [
            { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref' } },
          ],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    // Only add proxy stubs — no skills:resolve service.
    Object.assign(mocks.services, proxy.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('no-resolve-service-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(mocks.calls.sandboxOpen).toBe(1);

    // Proxy was called with agent's own allowedHosts (no skill union).
    const openIn = proxy.state.lastOpenInput as { allowlist: string[] };
    expect(openIn.allowlist).toEqual(['api.anthropic.com']);
  });

  // -----------------------------------------------------------------
  // 2026-05-19 defaults — union of explicit attachments + defaults.
  // -----------------------------------------------------------------

  function buildDefaultsHook(opts: {
    listDefaultsThrows?: unknown;
    skills?: ResolvedSkill[];
  }): { listDefaultsCalls: { count: number }; services: Record<string, ServiceHandler> } {
    const counter = { count: 0 };
    const services: Record<string, ServiceHandler> = {
      'skills:list-defaults': async () => {
        counter.count += 1;
        if (opts.listDefaultsThrows !== undefined) throw opts.listDefaultsThrows;
        return { skills: opts.skills ?? [] };
      },
    };
    return { listDefaultsCalls: counter, services };
  }

  it('unions skills:list-defaults output into installedSkills (no explicit attachments)', async () => {
    const proxy = buildProxyHooks();
    const defaultSkill: ResolvedSkill = {
      id: 'heartbeat',
      capabilities: { allowedHosts: [], credentials: [] },
      bodyMd: '# heartbeat\n',
      manifestYaml: 'name: heartbeat\ndescription: hb\n',
    };
    const defaults = buildDefaultsHook({ skills: [defaultSkill] });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          // No explicit skillAttachments.
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, defaults.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('defaults-only-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(defaults.listDefaultsCalls.count).toBe(1);

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    expect(sandboxIn.installedSkills).toHaveLength(1);
    expect(sandboxIn.installedSkills![0]!.id).toBe('heartbeat');
  });

  it('explicit attachments win on id collision (defaults filtered out for same id)', async () => {
    const proxy = buildProxyHooks();
    const explicitSkill: ResolvedSkill = {
      id: 'shared',
      capabilities: { allowedHosts: ['api.example.com'], credentials: [{ slot: 'TOK', kind: 'api-key' }] },
      bodyMd: '# explicit body\n',
      manifestYaml: 'name: shared\ndescription: explicit\n',
    };
    const defaultSameId: ResolvedSkill = {
      id: 'shared',
      capabilities: { allowedHosts: [], credentials: [] },
      bodyMd: '# default body\n',
      manifestYaml: 'name: shared\ndescription: default\n',
    };
    const skillsHooks = buildSkillsHooks({ skills: { shared: explicitSkill } });
    const defaults = buildDefaultsHook({ skills: [defaultSameId] });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [
            { skillId: 'shared', credentialBindings: { TOK: 'my-tok' } },
          ],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services, defaults.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('explicit-wins-session'),
      { message: { role: 'user', content: 'hi' } },
    );

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    expect(sandboxIn.installedSkills).toHaveLength(1);
    // Explicit body wins. (SKILL.md is reconstructed as a bundle file.)
    const skillMd = sandboxIn.installedSkills[0]!.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd?.contents).toContain('# explicit body');
  });

  // -----------------------------------------------------------------
  // Phase 3 A3 — self-authored workspace drafts are the highest-precedence
  // discovery source (the agent's own current authoring wins over a stale
  // default/catalog of the same id). Instruction-only here (empty caps);
  // a throw FAILS OPEN (fewer skills, never wider reach).
  // -----------------------------------------------------------------

  it('authored drafts win over a default of the same id (highest precedence, de-duped)', async () => {
    const proxy = buildProxyHooks();
    // A default-attached skill of id 'linear' carrying a DIFFERENT body.
    const defaultSameId: ResolvedSkill = {
      id: 'linear',
      capabilities: { allowedHosts: [], credentials: [] },
      bodyMd: 'Default body',
      manifestYaml: 'name: linear\ndescription: default\n',
    };
    const defaults = buildDefaultsHook({ skills: [defaultSameId] });
    // The agent's own authored draft of id 'linear' — should win.
    const authoredDraft: ResolvedSkill = {
      id: 'linear',
      capabilities: {
        allowedHosts: [],
        credentials: [],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      bodyMd: 'Authored body',
      manifestYaml: 'name: linear\ndescription: authored\n',
      files: [],
    };
    const authoredCalls = { count: 0, lastInput: undefined as unknown };
    const authoredServices: Record<string, ServiceHandler> = {
      'agents:resolve-authored-skills': async (_ctx, input) => {
        authoredCalls.count += 1;
        authoredCalls.lastInput = input;
        return { skills: [authoredDraft] };
      },
    };
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          // No explicit skillAttachments — 'linear' arrives via default + draft.
          skillAttachments: [],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, defaults.services, authoredServices);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('authored-wins-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(authoredCalls.count).toBe(1);
    expect(authoredCalls.lastInput).toEqual({
      ownerUserId: 'test-user',
      agentId: TEST_AGENT.id,
    });

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    // De-duped: exactly one 'linear' in the projection.
    const linears = sandboxIn.installedSkills.filter((s) => s.id === 'linear');
    expect(linears).toHaveLength(1);
    // The DRAFT body won over the default.
    const skillMd = linears[0]!.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd?.contents).toContain('Authored body');
    expect(skillMd?.contents).not.toContain('Default body');
  });

  // -----------------------------------------------------------------
  // TASK-76 (§D3) — "no bytes project" for a PENDING authored skill.
  // A pending draft (caps the user hasn't approved) must contribute
  // NOTHING to the spawn: no SKILL.md body, no name/description in the
  // projection. Only `active` drafts materialize. (The approval card is
  // a separate path — exercised in the upfront-card tests — and reads
  // description+proposalDelta, never the body.)
  // -----------------------------------------------------------------
  it('§D3: a PENDING authored skill projects NO bytes into the sandbox', async () => {
    const proxy = buildProxyHooks();
    const pendingDraft = {
      id: 'linear',
      capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
      proposalDelta: {
        allowedHosts: ['api.linear.app'],
        credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' as const }],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      description: 'Work with Linear issues.',
      bodyMd: 'SECRET PENDING BODY the model must not see yet',
      manifestYaml: 'name: linear\ndescription: Work with Linear issues.\nversion: 1\n',
      files: [{ path: 'helper.md', contents: 'pending helper bytes' }],
      status: 'pending' as const,
    };
    const authoredServices: Record<string, ServiceHandler> = {
      'agents:resolve-authored-skills': async () => ({ skills: [pendingDraft] }),
    };
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, authoredServices);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('pending-no-bytes-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    // The pending draft is absent from the spawn projection entirely. With no
    // other skills, installedSkills is omitted (the orchestrator only sets it
    // when non-empty) — either way, no 'linear' and no pending bytes.
    const installed = sandboxIn.installedSkills ?? [];
    expect(installed.some((s) => s.id === 'linear')).toBe(false);
    const allBytes = JSON.stringify(installed);
    expect(allBytes).not.toContain('SECRET PENDING BODY');
    expect(allBytes).not.toContain('pending helper bytes');
    // §D3 "no caps inject": the unapproved host never reaches the allowlist.
    const openIn = proxy.state.lastOpenInput as { allowlist: string[] };
    expect(openIn.allowlist).not.toContain('api.linear.app');
  });

  it('TASK-86: a PENDING cap-skill card fires ONLY in its proposing conversation', async () => {
    const proxy = buildProxyHooks();
    const pendingDraft = {
      id: 'linear',
      capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
      proposalDelta: {
        allowedHosts: ['api.linear.app'],
        credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' as const }],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      description: 'Work with Linear issues.',
      bodyMd: 'pending body',
      manifestYaml: 'name: linear\ndescription: Work with Linear issues.\nversion: 1\n',
      files: [],
      status: 'pending' as const,
    };
    const authoredServices: Record<string, ServiceHandler> = {
      'agents:resolve-authored-skills': async () => ({ skills: [pendingDraft] }),
    };
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, authoredServices);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    // Capture skill cards per conversation.
    const cardConvs: string[] = [];
    h.bus.subscribe('chat:permission-request', 'test/capture', async (c, p) => {
      if ((p as { kind?: string }).kind === 'skill') cardConvs.push(c.conversationId ?? '');
      return undefined;
    });

    const ctxIn = (sessionId: string, conversationId: string) =>
      makeAgentContext({
        sessionId, agentId: 'test-agent', userId: 'test-user', conversationId,
        logger: createLogger({ reqId: `req-${sessionId}`, writer: () => undefined }),
      });

    // The skill was proposed in conversation A (the runner fires skills:proposed
    // on the proposing ctx; status pending).
    await h.bus.fire('skills:proposed', ctxIn('sess-a', 'conv-A'), {
      ownerUserId: 'test-user', agentId: 'test-agent', skillId: 'linear', status: 'pending',
    });

    // A turn in conversation A fires the card...
    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke', ctxIn('sess-a2', 'conv-A'),
      { message: { role: 'user', content: 'hi' } },
    );
    // ...a turn in an UNRELATED conversation B does NOT.
    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke', ctxIn('sess-b', 'conv-B'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(cardConvs).toEqual(['conv-A']);
  });

  it('§D3: an ACTIVE authored skill DOES project its bytes (the flip target)', async () => {
    const proxy = buildProxyHooks();
    const activeDraft = {
      id: 'commit-style',
      capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
      proposalDelta: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
      description: 'How we write commits.',
      bodyMd: 'ACTIVE BODY the model should see',
      manifestYaml: 'name: commit-style\ndescription: How we write commits.\nversion: 1\n',
      files: [],
      status: 'active' as const,
    };
    const authoredServices: Record<string, ServiceHandler> = {
      'agents:resolve-authored-skills': async () => ({ skills: [activeDraft] }),
    };
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, authoredServices);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('active-projects-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    const entry = sandboxIn.installedSkills.find((s) => s.id === 'commit-style');
    expect(entry).toBeDefined();
    const skillMd = entry!.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd?.contents).toContain('ACTIVE BODY the model should see');
  });

  it('TASK-86 regression: two ACTIVE authored skills sharing a slot name → turn succeeds, each resolves its own credential', async () => {
    // The exact TASK-72 walk repro: two approved authored skills both declare
    // `LINEAR_API_KEY`. Before the fix this terminated EVERY turn with
    // skill-slot-collision (the all-chat lockout).
    const proxy = buildProxyHooks({
      openOutput: {
        proxyEndpoint: 'tcp://127.0.0.1:54321',
        caCertPem: 'TEST-CA-PEM',
        envMap: {
          ANTHROPIC_API_KEY: 'ax-cred:00000000000000000000000000000000',
          'skill:linear-issues-helper:LINEAR_API_KEY':
            'ax-cred:11111111111111111111111111111111',
          'skill:walk4-linear:LINEAR_API_KEY':
            'ax-cred:22222222222222222222222222222222',
        },
      },
    });
    const mkDraft = (id: string) => ({
      id,
      capabilities: {
        allowedHosts: ['api.linear.app'],
        credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      proposalDelta: {
        allowedHosts: [],
        credentials: [],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      description: `${id} body`,
      bodyMd: `${id} instructions`,
      manifestYaml: `name: ${id}\ndescription: ${id}\nversion: 1\n`,
      files: [],
      status: 'active' as const,
    });
    const authoredServices: Record<string, ServiceHandler> = {
      'agents:resolve-authored-skills': async () => ({
        skills: [mkDraft('linear-issues-helper'), mkDraft('walk4-linear')],
      }),
    };
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, authoredServices);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('two-authored-linear-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    // No lockout — the turn completes.
    expect(outcome.kind).toBe('complete');
    expect(proxy.state.openCalls).toBe(1);
    // Each authored skill's credential is present under its OWN namespaced key
    // with its OWN per-skill ref — each resolves its own credential.
    const openIn = proxy.state.lastOpenInput as {
      credentials: Record<string, { ref: string; kind: string }>;
    };
    expect(openIn.credentials['skill:linear-issues-helper:LINEAR_API_KEY']).toEqual({
      ref: 'skill:linear-issues-helper:LINEAR_API_KEY',
      kind: 'api-key',
    });
    expect(openIn.credentials['skill:walk4-linear:LINEAR_API_KEY']).toEqual({
      ref: 'skill:walk4-linear:LINEAR_API_KEY',
      kind: 'api-key',
    });
    // The sandbox sees the BARE LINEAR_API_KEY (first authored skill wins the
    // flat-env stamp); the other skill carries its own git placeholder.
    const sandboxIn = mocks.calls.lastSandboxInput as {
      proxyConfig?: { envMap: Record<string, string> };
      installedSkills?: Array<{ id: string; credentials: Array<{ slot: string; placeholder?: string }> }>;
    };
    expect(sandboxIn.proxyConfig?.envMap['LINEAR_API_KEY']).toBe(
      'ax-cred:11111111111111111111111111111111',
    );
    const walk4 = sandboxIn.installedSkills?.find((s) => s.id === 'walk4-linear');
    expect(walk4?.credentials[0]?.placeholder).toBe(
      'ax-cred:22222222222222222222222222222222',
    );
  });

  it('§D3: a PENDING draft does NOT suppress a same-id default attachment', async () => {
    const proxy = buildProxyHooks();
    // A default-attached skill of id 'linear' that SHOULD still project.
    const defaultSameId: ResolvedSkill = {
      id: 'linear',
      capabilities: { allowedHosts: [], credentials: [] },
      bodyMd: 'Default linear body',
      manifestYaml: 'name: linear\ndescription: default\n',
    };
    const defaults = buildDefaultsHook({ skills: [defaultSameId] });
    const pendingDraft = {
      id: 'linear',
      capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
      proposalDelta: {
        allowedHosts: ['api.linear.app'],
        credentials: [],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      description: 'pending draft',
      bodyMd: 'PENDING DRAFT BODY',
      manifestYaml: 'name: linear\ndescription: pending\n',
      files: [],
      status: 'pending' as const,
    };
    const authoredServices: Record<string, ServiceHandler> = {
      'agents:resolve-authored-skills': async () => ({ skills: [pendingDraft] }),
    };
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, defaults.services, authoredServices);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('pending-no-suppress-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    // The DEFAULT linear still projects (the pending draft didn't shadow it),
    // and it carries the default body, NOT the pending draft's body.
    const linear = sandboxIn.installedSkills.find((s) => s.id === 'linear');
    expect(linear).toBeDefined();
    const skillMd = linear!.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd?.contents).toContain('Default linear body');
    expect(skillMd?.contents).not.toContain('PENDING DRAFT BODY');
  });

  // M3-1: agents:resolve-authored-skills THROWING must fail OPEN — the turn
  // still completes (sandbox opens with non-draft skills only). Regression
  // test: a bad workspace read must never kill the chat.
  it('agents:resolve-authored-skills throwing fails OPEN (warn + empty drafts, session completes)', async () => {
    const proxy = buildProxyHooks();
    // Use a capturing logger writer so we can verify the warning is emitted.
    const logLines: string[] = [];
    const capturingCtx = makeAgentContext({
      sessionId: 'authored-throw-session',
      agentId: 'test-agent',
      userId: 'test-user',
      logger: createLogger({ reqId: 'orch-test', writer: (line) => logLines.push(line) }),
    });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    // Register a throwing agents:resolve-authored-skills mock.
    mocks.services['agents:resolve-authored-skills'] = async () => {
      throw new Error('workspace backend unavailable');
    };
    Object.assign(mocks.services, proxy.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      capturingCtx,
      { message: { role: 'user', content: 'hi' } },
    );
    // Must NOT terminate — fail-open means fewer skills, never a dead session.
    expect(outcome.kind).toBe('complete');

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string }>;
    };
    // No authored drafts were projected (the throw was caught + swallowed).
    expect(sandboxIn.installedSkills ?? []).toHaveLength(0);
    // The warning must have been emitted so the failure is observable in logs.
    const warnLine = logLines.find((l) => l.includes('resolve_authored_skills_failed'));
    expect(warnLine).toBeDefined();
  });

  it('skips defaults entirely when skills:list-defaults service is not registered', async () => {
    // Stripped-preset compatibility (I-S6).
    const proxy = buildProxyHooks();
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services);
    // NO defaults.services — service absent.
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('no-defaults-service-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    expect(sandboxIn.installedSkills ?? []).toHaveLength(0);
  });

  it('skills:list-defaults throwing does NOT terminate the session (non-fatal, I-S5)', async () => {
    const proxy = buildProxyHooks();
    const defaults = buildDefaultsHook({ listDefaultsThrows: new Error('boom') });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, defaults.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('defaults-throw-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete'); // NOT terminated.

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    expect(sandboxIn.installedSkills ?? []).toHaveLength(0);
  });

  // 2026-05-19 defaults — end-to-end canary closing I-S7's half-wired window.
  // Default-attached instruction-only skill flows: db row → skills:list-defaults
  // → orchestrator union → sandbox:open-session installedSkills payload.
  it('CANARY: default-attached instruction skill is delivered to sandbox:open-session with intact SKILL.md', async () => {
    const proxy = buildProxyHooks();
    const defaultSkill: ResolvedSkill = {
      id: 'greeter',
      capabilities: { allowedHosts: [], credentials: [] },
      bodyMd: '# Greeter\n\nSay hi.\n',
      manifestYaml: 'name: greeter\ndescription: Greets every agent.\nversion: 1\n',
    };
    const defaults = buildDefaultsHook({ skills: [defaultSkill] });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          // Critical: agent has ZERO explicit skillAttachments. The skill
          // gets there only because it is default-attached.
          skillAttachments: [],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, defaults.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('defaults-canary-session'),
      { message: { role: 'user', content: 'hi' } },
    );

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    expect(sandboxIn.installedSkills).toHaveLength(1);
    const entry = sandboxIn.installedSkills[0]!;
    expect(entry.id).toBe('greeter');
    // SKILL.md framing: --- yaml --- body (reconstructed as a bundle file).
    const skillMd = entry.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd?.contents).toContain('---\nname: greeter\n');
    expect(skillMd?.contents).toContain('---\n# Greeter');
  });

  // -----------------------------------------------------------------
  // Task 5 — builtinSkills config: lowest-precedence materialization.
  // -----------------------------------------------------------------

  it('materializes a config builtin skill into the sandbox at lowest precedence', async () => {
    const proxy = buildProxyHooks();
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          // No explicit skillAttachments.
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services);
    // No skills:list-defaults — only the builtin.
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
          builtinSkills: [
            {
              id: 'ax-skill-creator',
              manifestYaml: 'name: ax-skill-creator\ndescription: d\nversion: 1\n',
              bodyMd: '# body',
              files: [],
              capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
            },
          ],
        }),
      ],
    });
    busRef.current = h.bus;

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('builtin-only-session'),
      { message: { role: 'user', content: 'hi' } },
    );

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    // Builtin materialized as an installed skill entry.
    expect(sandboxIn.installedSkills).toHaveLength(1);
    const entry = sandboxIn.installedSkills![0]!;
    expect(entry.id).toBe('ax-skill-creator');
    const skillMd = entry.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd).toBeTruthy();
    expect(skillMd!.contents).toContain('name: ax-skill-creator');
    expect(skillMd!.contents).toContain('# body');

    // Empty capabilities → no egress hosts added from the builtin.
    const openIn = proxy.state.lastOpenInput as { allowlist: string[] };
    expect(openIn.allowlist).not.toContain('registry.npmjs.org');
    expect(openIn.allowlist).not.toContain('pypi.org');
  });

  it('a default/explicit skill with the same id wins over the builtin (builtin dropped)', async () => {
    const proxy = buildProxyHooks();
    // A default-attached skill with the same id but different bodyMd.
    const defaultSkill: ResolvedSkill = {
      id: 'ax-skill-creator',
      capabilities: { allowedHosts: [], credentials: [] },
      bodyMd: '# real default body\n',
      manifestYaml: 'name: ax-skill-creator\ndescription: real\nversion: 2\n',
    };
    const defaults = buildDefaultsHook({ skills: [defaultSkill] });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          // No explicit skillAttachments — the default wins over the builtin.
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, defaults.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
          builtinSkills: [
            {
              id: 'ax-skill-creator',
              manifestYaml: 'name: ax-skill-creator\ndescription: builtin\nversion: 1\n',
              bodyMd: '# builtin body',
              files: [],
              capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
            },
          ],
        }),
      ],
    });
    busRef.current = h.bus;

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('default-wins-over-builtin-session'),
      { message: { role: 'user', content: 'hi' } },
    );

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills: Array<{ id: string; files: Array<{ path: string; contents: string }> }>;
    };
    // Only ONE entry — the builtin is deduped out.
    expect(sandboxIn.installedSkills).toHaveLength(1);
    expect(sandboxIn.installedSkills[0]!.id).toBe('ax-skill-creator');
    // The default (not the builtin) wins — identified by bodyMd.
    const skillMd = sandboxIn.installedSkills[0]!.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd?.contents).toContain('# real default body');
    expect(skillMd?.contents).not.toContain('# builtin body');
  });

  it('TASK-94: a PENDING authored connector draft fires ONE chat:permission-request connector card', async () => {
    const proxy = buildProxyHooks();
    const connectorDraft = {
      connectorId: 'linear',
      name: 'Linear',
      usageNote: 'Drive the Linear API',
      keyMode: 'personal' as const,
      status: 'pending' as const,
      proposal: {
        allowedHosts: ['api.linear.app'],
        credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' as const }],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
    };
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
          skillAttachments: [],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, {
      'connectors:list-authored': async () => ({ drafts: [connectorDraft] }),
    } satisfies Record<string, ServiceHandler>);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;

    const cards: Array<Record<string, unknown>> = [];
    h.bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      if ((p as { kind?: string }).kind === 'connector') cards.push(p as Record<string, unknown>);
      return undefined;
    });

    const ctxIn = (sessionId: string, conversationId: string) =>
      makeAgentContext({
        sessionId, agentId: 'test-agent', userId: 'test-user', conversationId,
        logger: createLogger({ reqId: `req-${sessionId}`, writer: () => undefined }),
      });

    // First turn fires the connector card; a second turn in the SAME
    // conversation is deduped (no second card for the same shown surface).
    await h.bus.call<unknown, AgentOutcome>('agent:invoke', ctxIn('s1', 'conv-A'), { message: { role: 'user', content: 'hi' } });
    await h.bus.call<unknown, AgentOutcome>('agent:invoke', ctxIn('s2', 'conv-A'), { message: { role: 'user', content: 'hi' } });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual({
      kind: 'connector', connectorId: 'linear', name: 'Linear', authored: true,
      hosts: ['api.linear.app'],
      slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', haveExisting: false }],
      packages: { npm: [], pypi: [] },
    });
  });

  it('TASK-94: an ACTIVE authored connector draft fires NO card (already approved)', async () => {
    const proxy = buildProxyHooks();
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: { ...TEST_AGENT, allowedHosts: ['api.anthropic.com'], requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } }, skillAttachments: [] },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, {
      'connectors:list-authored': async () => ({
        drafts: [{
          connectorId: 'linear', name: 'Linear', usageNote: '', keyMode: 'personal', status: 'active',
          proposal: { allowedHosts: ['api.linear.app'], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
        }],
      }),
    } satisfies Record<string, ServiceHandler>);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });
    busRef.current = h.bus;
    const cards: unknown[] = [];
    h.bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      if ((p as { kind?: string }).kind === 'connector') cards.push(p);
      return undefined;
    });
    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      makeAgentContext({ sessionId: 's1', agentId: 'test-agent', userId: 'test-user', conversationId: 'conv-A', logger: createLogger({ reqId: 'r', writer: () => undefined }) }),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(cards).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reactive egress wall (TASK-37) — an allowlist-MISS 403 the credential proxy
// fired on `event.http-egress` (now carrying a real sessionId via TASK-52's
// per-session token) becomes an in-chat host-grant permission card. The
// orchestrator resolves the block's sessionId → in-flight reqId via the SAME
// reqIdsBySession map Fault A uses, dedups per (session, host), and fires the
// TASK-35 `chat:permission-request` hook with the `{ kind: 'host' }` variant
// stamped with reqId so the SSE matches the precise turn.
// ---------------------------------------------------------------------------

describe('chat-orchestrator — reactive egress wall (TASK-37)', () => {
  // Drive an agent:invoke into the in-flight state (sandbox open + message
  // enqueued + waiter registered) and leave it pending, returning the bus +
  // the still-pending invoke promise + a teardown that settles it. The default
  // mock's `exited` never resolves and no chat:end fires, so the turn stays
  // in-flight (the waiter sits in reqIdsBySession keyed by ctx.sessionId).
  async function inFlightTurn(sessionId: string, reqId: string) {
    const mocks = buildMocks();
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 10_000,
        }),
      ],
    });
    const ctx = makeAgentContext({
      sessionId,
      agentId: 'test-agent',
      userId: 'test-user',
      reqId,
      logger: createLogger({ reqId, writer: () => undefined }),
    });
    const invokePromise = h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctx,
      { message: { role: 'user', content: 'hi' } },
    );
    while (mocks.calls.sessionQueueWork === 0) {
      await new Promise((r) => setImmediate(r));
    }
    async function settle(): Promise<void> {
      await h.bus.fire('chat:end', ctx, {
        outcome: { kind: 'terminated', reason: 'sandbox-terminated' },
      });
      await invokePromise;
    }
    return { bus: h.bus, ctx, settle };
  }

  const egress = (over: {
    sessionId: string;
    userId: string;
    host: string;
    blockedReason?: string;
  }) => ({
    method: 'GET',
    path: '/',
    status: 403,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 1,
    credentialInjected: false,
    classification: 'other' as const,
    timestamp: Date.now(),
    ...over,
  });

  it('fires a host-grant chat:permission-request when an allowlist-block carries an in-flight session', async () => {
    const { bus, settle } = await inFlightTurn('s1', 'r1');
    const cards: unknown[] = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p);
      return undefined;
    });

    await bus.fire(
      'event.http-egress',
      makeAgentContext({ sessionId: 's1', userId: 'u1', agentId: '' }),
      egress({ sessionId: 's1', userId: 'u1', host: 'blocked.example.com', blockedReason: 'allowlist' }),
    );

    expect(cards).toEqual([
      { kind: 'host', host: 'blocked.example.com', sessionId: 's1', reqId: 'r1' },
    ]);
    await settle();
  });

  it('does NOT fire for a non-allowlist block, an empty sessionId, or a session with no in-flight turn', async () => {
    const { bus, settle } = await inFlightTurn('s1', 'r1');
    const cards: unknown[] = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p);
      return undefined;
    });
    const fire = (sessionId: string, userId: string, host: string, blockedReason?: string) =>
      bus.fire(
        'event.http-egress',
        makeAgentContext({ sessionId: sessionId || 'x', userId: userId || 'x', agentId: '' }),
        egress({ sessionId, userId, host, blockedReason }),
      );
    await fire('s1', 'u1', 'h', 'private-ip'); // wrong reason
    await fire('', '', 'h', 'allowlist'); // unattributed
    await fire('s-noturn', 'u1', 'h', 'allowlist'); // no in-flight turn
    expect(cards).toEqual([]);
    await settle();
  });

  it('dedups repeated blocks for the same (session, host)', async () => {
    const { bus, settle } = await inFlightTurn('s1', 'r1');
    const cards: unknown[] = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p);
      return undefined;
    });
    const fire = (host: string) =>
      bus.fire(
        'event.http-egress',
        makeAgentContext({ sessionId: 's1', userId: 'u1', agentId: '' }),
        egress({ sessionId: 's1', userId: 'u1', host, blockedReason: 'allowlist' }),
      );
    await fire('h.example.com');
    await fire('h.example.com'); // same host → deduped
    await fire('other.example.com'); // distinct host → new card
    expect(cards).toHaveLength(2);
    await settle();
  });
});

// ---------------------------------------------------------------------------
// withBrokerDefaults — pure unit tests for the TASK-51 smart-defaults helper.
// The integration tests above prove it's wired into session-open; these pin
// the helper's contract directly (wildcard preservation, append-only, dedup).
// ---------------------------------------------------------------------------
describe('withBrokerDefaults', () => {
  // TASK-76 — skill_propose joins the always-on set so a non-wildcard tenant
  // agent can author skills too. TASK-95 — connector_propose joins for the same
  // reason (connector authoring), kept last in the append order.
  const BROKER = ['search_catalog', 'request_capability', 'skill_propose', 'connector_propose'];

  it('returns the empty-empty wildcard unchanged', () => {
    expect(withBrokerDefaults([], [])).toEqual([]);
  });

  it('appends all broker tools to a non-wildcard allowedTools (order-stable)', () => {
    expect(withBrokerDefaults(['file.read'], [])).toEqual(['file.read', ...BROKER]);
  });

  it('injects skill_propose for a non-wildcard agent (TASK-76)', () => {
    expect(withBrokerDefaults(['file.read'], [])).toContain('skill_propose');
  });

  it('does NOT inject skill_propose into a wildcard agent (it already sees the catalog)', () => {
    expect(withBrokerDefaults([], [])).not.toContain('skill_propose');
  });

  it('treats an mcpConfigIds-only scope as non-wildcard', () => {
    expect(withBrokerDefaults([], ['mcp-1'])).toEqual([...BROKER]);
  });

  it('dedups a broker tool the agent already lists', () => {
    expect(withBrokerDefaults(['request_capability'], [])).toEqual([
      'request_capability',
      'search_catalog',
      'skill_propose',
      'connector_propose',
    ]);
  });

  it('dedups skill_propose the agent already lists', () => {
    expect(withBrokerDefaults(['skill_propose'], [])).toEqual([
      'skill_propose',
      'search_catalog',
      'request_capability',
      'connector_propose',
    ]);
  });

  it('injects connector_propose for a non-wildcard agent (TASK-95)', () => {
    expect(withBrokerDefaults(['file.read'], [])).toContain('connector_propose');
  });

  it('does NOT inject connector_propose into a wildcard agent', () => {
    expect(withBrokerDefaults([], [])).not.toContain('connector_propose');
  });

  it('is idempotent — re-applying does not duplicate', () => {
    const once = withBrokerDefaults(['file.read'], []);
    expect(withBrokerDefaults(once, [])).toEqual(once);
  });

  it('does not mutate the input array', () => {
    const input = ['file.read'];
    withBrokerDefaults(input, []);
    expect(input).toEqual(['file.read']);
  });
});

// ---------------------------------------------------------------------------
// TASK-74 — session-dirty → next-turn re-spawn on skills:proposed.
//
// Under keepalive a warm session reuses a frozen skill projection. When a turn
// proposes a skill (skill_propose → skills:propose → skills:proposed), the
// `skills:proposed` subscriber marks the PROPOSING session dirty (mark-ONLY —
// terminating there would wedge the in-flight turn / hang the SSE, the Fault-A
// class bug). The dirty session is retired at the NEXT turn's routing decision
// (safely between turns), forcing a fresh spawn that re-derives the projection
// so the freshly-active skill is visible (design §D6). A turn that proposed
// NOTHING must NOT trigger a re-spawn — else keepalive is defeated every turn.
//
// We drive turns through the bus harness and fire `skills:proposed` through the
// bus on the proposing session's ctx, exercising the real plugin.ts wiring →
// orchestrator.onSkillsProposed → the shared dirty-set the routing reads. (This
// replaced the old workspace:applied .ax/draft-skills trigger.)
// ---------------------------------------------------------------------------
describe('chat-orchestrator session-dirty re-spawn (skills:proposed)', () => {
  function ctxWith(o: { sessionId: string; conversationId?: string; reqId: string }) {
    return makeAgentContext({
      sessionId: o.sessionId,
      agentId: 'test-agent',
      userId: 'test-user',
      ...(o.conversationId !== undefined ? { conversationId: o.conversationId } : {}),
      reqId: o.reqId,
      logger: createLogger({ reqId: o.reqId, writer: () => undefined }),
    });
  }

  // Fire chat:turn-end carrying the originating reqId (the runner stamps it).
  function fireTurnEnd(bus: HookBus, sessionId: string, reqId: string) {
    setImmediate(() => {
      void bus.fire(
        'chat:turn-end',
        makeAgentContext({
          sessionId,
          agentId: 'a',
          userId: 'u',
          reqId: 'ipc-fresh',
          logger: createLogger({ reqId: 'ipc-fresh', writer: () => undefined }),
        }),
        { reason: 'user-message-wait', reqId },
      );
    });
  }

  // A keepalive harness: one conversation, one warm sandbox handle, a
  // bind-session that marks the bound session alive (so turn 2 routes warm
  // unless the dirty-set forces a fresh spawn). Tracks open / terminate counts.
  async function makeKeepaliveHarness() {
    const conv: Record<string, { activeSessionId: string | null }> = {
      'conv-1': { activeSessionId: null },
    };
    const live = new Set<string>();
    const counters = { opens: 0, terminates: [] as string[] };

    // Each spawn gets a distinct trivial handle (kill resolves exited).
    function makeHandle() {
      let resolveExit!: () => void;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
        resolveExit = () => res({ code: 0, signal: null });
      });
      return { kill: async () => { resolveExit(); }, exited };
    }

    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
      'session:queue-work': async () => ({ cursor: 0 }),
      'session:terminate': async (_c, input: unknown) => {
        const sid = (input as { sessionId: string }).sessionId;
        counters.terminates.push(sid);
        live.delete(sid);
        conv['conv-1']!.activeSessionId = null;
        return {};
      },
      'session:is-alive': async (_c, input: unknown) => ({
        alive: live.has((input as { sessionId: string }).sessionId),
      }),
      'conversations:get': async (_c, input: unknown) => {
        const i = input as { conversationId: string; userId: string };
        return {
          conversation: {
            conversationId: i.conversationId,
            userId: i.userId,
            agentId: 'test-agent',
            activeSessionId: conv[i.conversationId]!.activeSessionId,
            activeReqId: null,
          },
        };
      },
      'conversations:bind-session': async (_c, input: unknown) => {
        const i = input as { sessionId: string };
        conv['conv-1']!.activeSessionId = i.sessionId; // simulate the row write
        live.add(i.sessionId); // and mark it alive
        return undefined;
      },
      'sandbox:open-session': async () => {
        counters.opens += 1;
        return { runnerEndpoint: 'unix:///tmp/m.sock', handle: makeHandle() };
      },
      'proxy:open-session': async () => ({
        proxyEndpoint: 'tcp://127.0.0.1:1',
        caCertPem: 'CA',
        envMap: {},
      }),
      'proxy:close-session': async () => ({}),
    };

    const h = await createTestHarness({
      services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
          keepAlive: true,
          idleWindowMs: 60_000,
          idleGraceMs: 1_000,
        }),
      ],
    });
    return { h, counters };
  }

  // Fire skills:proposed on the proposing session's ctx (the host stamps the
  // runner's session onto ctx; the orchestrator marks ctx.sessionId dirty).
  async function fireProposed(bus: HookBus, sessionId: string) {
    await bus.fire(
      'skills:proposed',
      ctxWith({ sessionId, reqId: 'sp-1' }),
      { ownerUserId: 'test-user', agentId: 'test-agent', skillId: 'linear', status: 'active' },
    );
  }

  it('re-spawns after a turn that proposed a skill', async () => {
    const { h, counters } = await makeKeepaliveHarness();

    // Turn 1 — fresh spawn, binds 's-1' as the conversation's active session.
    fireTurnEnd(h.bus, 's-1', 'req-1');
    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-1' }),
      { message: { role: 'user', content: 'author a skill' } },
    );
    expect(counters.opens).toBe(1);

    // 's-1' proposed a skill this turn → skills:proposed fires (BEFORE the next
    // turn) on its ctx → marks 's-1' dirty.
    await fireProposed(h.bus, 's-1');

    // Turn 2 — same conversation. 's-1' is still alive, BUT it's dirty → routing
    // must decline warm-reuse, terminate 's-1', and re-spawn (a 2nd open).
    fireTurnEnd(h.bus, 's-1', 'req-2');
    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-2' }),
      { message: { role: 'user', content: 'use it' } },
    );

    expect(counters.opens).toBe(2); // re-spawned, did NOT reuse 's-1'
    expect(counters.terminates).toContain('s-1'); // stale session retired
  });

  it('reuses the warm session when the turn proposed nothing', async () => {
    const { h, counters } = await makeKeepaliveHarness();

    // Turn 1 — fresh spawn, binds 's-1'.
    fireTurnEnd(h.bus, 's-1', 'req-1');
    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-1' }),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(counters.opens).toBe(1);

    // No skills:proposed fires — 's-1' stays clean (keepalive must hold).

    // Turn 2 — 's-1' alive + clean → routed warm, NO second open.
    fireTurnEnd(h.bus, 's-1', 'req-2');
    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-2' }),
      { message: { role: 'user', content: 'again' } },
    );

    expect(counters.opens).toBe(1); // warm reuse — keepalive intact
    expect(counters.terminates).not.toContain('s-1');
  });

  it('still re-spawns when session:terminate throws during dirty-session retire (F4 — degraded path)', async () => {
    // B3 terminate-failure branch (~orchestrator.ts:1022-1029): if the retire
    // call throws, the orchestrator logs `respawn_terminate_failed` and falls
    // through to a fresh spawn. This test asserts the throw does NOT block the
    // spawn — the second agent:invoke must still open a new sandbox.

    // Build a harness where session:terminate throws on the first call (the
    // retire during dirty-session routing). Mirror makeKeepaliveHarness exactly,
    // overriding only session:terminate.
    const conv: Record<string, { activeSessionId: string | null }> = {
      'conv-1': { activeSessionId: null },
    };
    const live = new Set<string>();
    const counters = { opens: 0, terminateAttempts: 0 };

    function makeHandle() {
      let resolveExit!: () => void;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
        resolveExit = () => res({ code: 0, signal: null });
      });
      return { kill: async () => { resolveExit(); }, exited };
    }

    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
      'session:queue-work': async () => ({ cursor: 0 }),
      'session:terminate': async () => {
        counters.terminateAttempts += 1;
        // Always throw — simulates a transient store failure mid-retire.
        throw new Error('simulated terminate failure');
        // (unreachable — live and conv are NOT updated, so 's-1' stays alive
        // in the mock; the fresh spawn still opens because routedSessionId
        // remains null after the failed retire.)
      },
      'session:is-alive': async (_c, input: unknown) => ({
        alive: live.has((input as { sessionId: string }).sessionId),
      }),
      'conversations:get': async (_c, input: unknown) => {
        const i = input as { conversationId: string; userId: string };
        return {
          conversation: {
            conversationId: i.conversationId,
            userId: i.userId,
            agentId: 'test-agent',
            activeSessionId: conv[i.conversationId]!.activeSessionId,
            activeReqId: null,
          },
        };
      },
      'conversations:bind-session': async (_c, input: unknown) => {
        const i = input as { sessionId: string };
        conv['conv-1']!.activeSessionId = i.sessionId;
        live.add(i.sessionId);
        return undefined;
      },
      'sandbox:open-session': async () => {
        counters.opens += 1;
        return { runnerEndpoint: 'unix:///tmp/m.sock', handle: makeHandle() };
      },
      'proxy:open-session': async () => ({
        proxyEndpoint: 'tcp://127.0.0.1:1',
        caCertPem: 'CA',
        envMap: {},
      }),
      'proxy:close-session': async () => ({}),
    };

    const h = await createTestHarness({
      services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
          keepAlive: true,
          idleWindowMs: 60_000,
          idleGraceMs: 1_000,
        }),
      ],
    });

    // Turn 1 — fresh spawn, binds 's-1'.
    fireTurnEnd(h.bus, 's-1', 'req-1');
    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-1' }),
      { message: { role: 'user', content: 'author a skill' } },
    );
    expect(counters.opens).toBe(1);

    // Mark 's-1' dirty via a skills:proposed notify (the agent proposed a skill).
    await h.bus.fire(
      'skills:proposed',
      ctxWith({ sessionId: 's-1', reqId: 'sp-1' }),
      { ownerUserId: 'test-user', agentId: 'test-agent', skillId: 'linear', status: 'active' },
    );

    // Turn 2 — dirty-session retire throws. The orchestrator must NOT propagate
    // the error; it must log and fall through to a fresh spawn.
    fireTurnEnd(h.bus, 's-1', 'req-2');
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-2' }),
      { message: { role: 'user', content: 'use it' } },
    );

    // The throw was attempted (degraded path exercised).
    expect(counters.terminateAttempts).toBeGreaterThanOrEqual(1);
    // A fresh sandbox was still opened — the throw did NOT block re-spawn.
    expect(counters.opens).toBe(2);
    // The outcome is a normal agent outcome (not a thrown error propagated out).
    expect(outcome).toBeDefined();
    expect((outcome as AgentOutcome).kind).toBeDefined();
  });
});
