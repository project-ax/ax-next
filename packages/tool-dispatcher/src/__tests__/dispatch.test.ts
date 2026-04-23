import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeChatContext,
  createLogger,
  registerChatLoop,
  type ChatContext,
  type ChatMessage,
  type ChatOutcome,
  type LlmRequest,
  type LlmResponse,
  type Plugin,
  type ToolCall,
} from '@ax/core';
import { toolDispatcherPlugin } from '../plugin.js';

const ctx = (): ChatContext =>
  makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
  });

describe('@ax/tool-dispatcher', () => {
  it('registers the tool:execute service', async () => {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [toolDispatcherPlugin()], config: {} });
    expect(bus.hasService('tool:execute')).toBe(true);
  });

  it('routes to tool:execute:<name> and passes the inner input', async () => {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [toolDispatcherPlugin()], config: {} });
    let received: unknown;
    bus.registerService<unknown, { stdout: string }>(
      'tool:execute:bash',
      'stub',
      async (_c, input) => {
        received = input;
        return { stdout: 'ok' };
      },
    );
    const result = await bus.call<ToolCall, { stdout: string }>(
      'tool:execute',
      ctx(),
      { id: 'x', name: 'bash', input: { command: 'ls' } },
    );
    expect(result).toEqual({ stdout: 'ok' });
    expect(received).toEqual({ command: 'ls' });
  });

  it('throws PluginError{no-service} with hookName for unknown tool names', async () => {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [toolDispatcherPlugin()], config: {} });
    try {
      await bus.call<ToolCall, unknown>('tool:execute', ctx(), {
        id: 'x',
        name: 'nonexistent',
        input: {},
      });
      throw new Error('expected dispatch to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      const pe = err as PluginError;
      expect(pe.code).toBe('no-service');
      expect(pe.hookName).toBe('tool:execute:nonexistent');
    }
  });

  it('chat loop terminates with reason no-service:tool:execute:<name> for missing tool', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);

    const chatLoopPlugin: Plugin = {
      manifest: {
        name: 'test:chat-loop-noop',
        version: '0.0.0',
        registers: [],
        calls: [],
        subscribes: [],
      },
      init() {},
    };

    // Bootstrap dispatcher via the real bootstrap path, alongside a no-op plugin.
    await bootstrap({
      bus,
      plugins: [toolDispatcherPlugin(), chatLoopPlugin],
      config: {},
    });

    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => ({
      assistantMessage: { role: 'assistant', content: 'calling tool' },
      toolCalls: [{ id: 't1', name: 'missing', input: {} }],
    }));

    const outcome = await bus.call<{ message: ChatMessage }, ChatOutcome>(
      'chat:run',
      ctx(),
      { message: { role: 'user', content: 'run the thing' } },
    );

    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('no-service:tool:execute:missing');
    }
  });
});
