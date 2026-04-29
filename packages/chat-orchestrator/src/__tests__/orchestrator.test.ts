import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  makeAgentContext,
  createLogger,
  reject,
  type ChatMessage,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

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
  lastQueuedMessage(): ChatMessage | undefined;
}

// Builds a default mock bundle. Callers can override individual services.
// The orchestrator itself does NOT call session:create (sandbox:open-session
// does), so we don't mock session:create here. agents:resolve IS mocked
// because Week 9.5's orchestrator hard-depends on it.
function buildMocks(opts: {
  openSession?: ServiceHandler;
  queueWork?: ServiceHandler;
  agentsResolve?: ServiceHandler;
} = {}): MockBundle {
  const calls = {
    sessionQueueWork: 0,
    sessionTerminate: 0,
    sandboxOpen: 0,
    killCalls: 0,
    agentsResolve: 0,
    lastSandboxInput: undefined as unknown,
  };
  let lastQueued: ChatMessage | undefined;

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

  it('chat:end fires exactly once across all exit paths', async () => {
    // We already assert single-fire in each scenario above; this is a
    // parametrized sweep so a regression in any one path lights up loudly.
    const scenarios: Array<{
      name: string;
      setup: (services: Record<string, ServiceHandler>) => ServiceHandler | undefined;
      input: ChatMessage;
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
      allowedTools: ['file.read', 'bash.exec'],
      mcpConfigIds: ['mcp-1'],
      model: 'claude-opus-4-7',
    });
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
            ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' },
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
      ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' },
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

  it('terminates with proxy-hooks-misconfigured when only proxy:open-session is registered', async () => {
    // A skewed preset that wires open without close would leak sessions
    // on every invoke. We refuse to enable proxy mode in that case and
    // surface a clear `proxy-hooks-misconfigured` outcome so audit-log
    // and operators see the misconfiguration immediately.
    const mocks = buildMocks();
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

  it('skips the proxy lifecycle when proxy:open-session is not registered', async () => {
    // Default mocks (no proxy hooks) — bus.hasService('proxy:open-session')
    // returns false. The orchestrator must NOT throw and the sandbox call
    // sees no proxyConfig.
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
      silentCtx('proxy-not-loaded'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    const sb = mocks.calls.lastSandboxInput as { proxyConfig?: unknown };
    expect(sb.proxyConfig).toBeUndefined();
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
            ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' },
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
});
