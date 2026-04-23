import {
  HookBus,
  makeChatContext,
  registerChatLoop,
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
  withChatLoop?: boolean;
}

export async function createTestHarness(opts: CreateTestHarnessOptions = {}): Promise<TestHarness> {
  const bus = new HookBus();

  if (opts.withChatLoop !== false) {
    registerChatLoop(bus);
  }

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
