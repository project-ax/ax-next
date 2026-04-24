import {
  HookBus,
  makeChatContext,
  bootstrap,
  type ChatContext,
  type Plugin,
  type ServiceHandler,
} from '@ax/core';

export interface TestHarness {
  bus: HookBus;
  ctx(overrides?: Partial<Parameters<typeof makeChatContext>[0]>): ChatContext;
}

export interface CreateTestHarnessOptions {
  services?: Record<string, ServiceHandler>;
  plugins?: Plugin[];
}

// ---------------------------------------------------------------------------
// createTestHarness
//
// Spins up a bare bus + ctx factory, optionally with service-hook mocks and
// real plugins booted through `bootstrap`. The Week 1-2 `withChatLoop`
// option is GONE — chat:run is no longer a kernel primitive. Tests that
// want chat:run construct `@ax/chat-orchestrator` explicitly and pass it
// via `plugins:`.
// ---------------------------------------------------------------------------

export async function createTestHarness(opts: CreateTestHarnessOptions = {}): Promise<TestHarness> {
  const bus = new HookBus();

  if (opts.services) {
    for (const [hook, handler] of Object.entries(opts.services)) {
      if (!bus.hasService(hook)) {
        bus.registerService(hook, 'mock', handler);
      }
    }
  }

  if (opts.plugins && opts.plugins.length > 0) {
    await bootstrap({ bus, plugins: opts.plugins, config: {} });
  }

  return {
    bus,
    ctx(overrides) {
      return makeChatContext({
        sessionId: 'test-session',
        agentId: 'test-agent',
        userId: 'test-user',
        ...overrides,
      });
    },
  };
}
