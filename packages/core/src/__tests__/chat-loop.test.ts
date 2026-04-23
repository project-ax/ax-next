import { describe, it, expect } from 'vitest';
import { HookBus } from '../hook-bus.js';
import { registerChatLoop } from '../chat-loop.js';
import { makeChatContext, createLogger } from '../context.js';
import type { ChatMessage, ChatOutcome, LlmRequest, LlmResponse, ToolCall } from '../types.js';
import { reject } from '../errors.js';

const ctx = () =>
  makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
  });

describe('chat:run', () => {
  it('returns terminated with reason no-service:llm:call when llm:call is not registered', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    const outcome = await bus.call<{ message: ChatMessage }, ChatOutcome>(
      'chat:run',
      ctx(),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('no-service:llm:call');
    }
  });

  it('completes a single turn with a registered llm:call (no tool calls)', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => ({
      assistantMessage: { role: 'assistant', content: 'hello' },
      toolCalls: [],
    }));
    const outcome = await bus.call<{ message: ChatMessage }, ChatOutcome>(
      'chat:run',
      ctx(),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    if (outcome.kind === 'complete') {
      expect(outcome.messages).toHaveLength(2);
      expect(outcome.messages[1]).toEqual({ role: 'assistant', content: 'hello' });
    }
  });

  it('fires chat:start and chat:end subscribers', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => ({
      assistantMessage: { role: 'assistant', content: 'ok' },
      toolCalls: [],
    }));
    const events: string[] = [];
    bus.subscribe('chat:start', 'obs', async () => { events.push('start'); return undefined; });
    bus.subscribe('chat:end', 'obs', async () => { events.push('end'); return undefined; });
    await bus.call('chat:run', ctx(), { message: { role: 'user', content: 'hi' } });
    expect(events).toEqual(['start', 'end']);
  });

  it('llm:pre-call subscriber can transform the request', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    let seen: LlmRequest | undefined;
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async (_ctx, req) => {
      seen = req;
      return { assistantMessage: { role: 'assistant', content: 'ok' }, toolCalls: [] };
    });
    bus.subscribe<LlmRequest>('llm:pre-call', 'prep', async (_ctx, p) => ({
      ...p,
      messages: [...p.messages, { role: 'system', content: 'injected' }],
    }));
    await bus.call('chat:run', ctx(), { message: { role: 'user', content: 'hi' } });
    expect(seen?.messages.some(m => m.role === 'system' && m.content === 'injected')).toBe(true);
  });

  it('tool:pre-call rejection skips the tool and appends a rejection message', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    const toolCall: ToolCall = { id: 't1', name: 'bash', input: { cmd: 'rm -rf /' } };
    let llmCalls = 0;
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return { assistantMessage: { role: 'assistant', content: '' }, toolCalls: [toolCall] };
      }
      return { assistantMessage: { role: 'assistant', content: 'done' }, toolCalls: [] };
    });
    bus.subscribe('tool:pre-call', 'security', async () => reject({ reason: 'bash is blocked' }));
    let toolExecCalled = false;
    bus.registerService('tool:execute', 'tools', async () => {
      toolExecCalled = true;
      return { output: 'x' };
    });
    const outcome = await bus.call<{ message: ChatMessage }, ChatOutcome>(
      'chat:run', ctx(), { message: { role: 'user', content: 'do it' } },
    );
    expect(toolExecCalled).toBe(false);
    expect(outcome.kind).toBe('complete');
    if (outcome.kind === 'complete') {
      const rejectionMsg = outcome.messages.find(m => m.content.includes('bash is blocked'));
      expect(rejectionMsg).toBeDefined();
    }
  });

  it('service-hook error inside chat:run is classified in outcome.reason', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => {
      throw new Error('upstream down');
    });
    const outcome = await bus.call<{ message: ChatMessage }, ChatOutcome>(
      'chat:run', ctx(), { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
  });

  it('tool:post-call rejection vetoes the output without terminating the chat', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    const toolCall: ToolCall = { id: 't1', name: 'readFile', input: { path: '/etc/shadow' } };
    let llmCalls = 0;
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return { assistantMessage: { role: 'assistant', content: '' }, toolCalls: [toolCall] };
      }
      return { assistantMessage: { role: 'assistant', content: 'done' }, toolCalls: [] };
    });
    bus.registerService('tool:execute', 'tools', async () => ({
      output: 'SECRET_TOKEN=abc123',
    }));
    bus.subscribe('tool:post-call', 'output-scanner', async () =>
      reject({ reason: 'contains secret' }),
    );
    const outcome = await bus.call<{ message: ChatMessage }, ChatOutcome>(
      'chat:run', ctx(), { message: { role: 'user', content: 'read it' } },
    );
    expect(outcome.kind).toBe('complete');
    if (outcome.kind === 'complete') {
      const leak = outcome.messages.find(m => m.content.includes('SECRET_TOKEN'));
      expect(leak).toBeUndefined();
      const veto = outcome.messages.find(m => m.content.includes('output vetoed'));
      expect(veto).toBeDefined();
      expect(veto!.content).toContain('contains secret');
    }
  });

  it('terminates with max-turns-exceeded when the model keeps emitting tool calls', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    let llmCalls = 0;
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => {
      llmCalls += 1;
      return {
        assistantMessage: { role: 'assistant', content: '' },
        toolCalls: [{ id: `t${llmCalls}`, name: 'echo', input: {} }],
      };
    });
    bus.registerService('tool:execute', 'tools', async () => ({ output: 'ok' }));
    const outcome = await bus.call<{ message: ChatMessage; maxTurns?: number }, ChatOutcome>(
      'chat:run',
      ctx(),
      { message: { role: 'user', content: 'spin' }, maxTurns: 3 },
    );
    expect(llmCalls).toBe(3);
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('max-turns-exceeded:3');
    }
  });

  it('chat:end fires exactly once across all exit paths', async () => {
    const scenarios: Array<{
      name: string;
      setup: (bus: HookBus) => void;
    }> = [
      {
        name: 'chat:start rejection',
        setup: (bus) => {
          bus.subscribe('chat:start', 'block', async () => reject({ reason: 'blocked' }));
        },
      },
      {
        name: 'llm:pre-call rejection',
        setup: (bus) => {
          bus.subscribe('llm:pre-call', 'block', async () => reject({ reason: 'nope' }));
          bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm', async () => ({
            assistantMessage: { role: 'assistant', content: 'x' },
            toolCalls: [],
          }));
        },
      },
      {
        name: 'llm:post-call rejection',
        setup: (bus) => {
          bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm', async () => ({
            assistantMessage: { role: 'assistant', content: 'x' },
            toolCalls: [],
          }));
          bus.subscribe('llm:post-call', 'block', async () => reject({ reason: 'nope' }));
        },
      },
      {
        name: 'llm:call missing (no-service)',
        setup: () => {},
      },
      {
        name: 'llm:call throws',
        setup: (bus) => {
          bus.registerService('llm:call', 'llm', async () => { throw new Error('down'); });
        },
      },
      {
        name: 'tool:execute missing',
        setup: (bus) => {
          const toolCall: ToolCall = { id: 't1', name: 'bash', input: {} };
          let n = 0;
          bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm', async () => {
            n += 1;
            if (n === 1) return { assistantMessage: { role: 'assistant', content: '' }, toolCalls: [toolCall] };
            return { assistantMessage: { role: 'assistant', content: 'done' }, toolCalls: [] };
          });
        },
      },
      {
        name: 'normal completion',
        setup: (bus) => {
          bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm', async () => ({
            assistantMessage: { role: 'assistant', content: 'hi' },
            toolCalls: [],
          }));
        },
      },
    ];

    for (const s of scenarios) {
      const bus = new HookBus();
      registerChatLoop(bus);
      let endCount = 0;
      bus.subscribe('chat:end', 'counter', async () => { endCount += 1; return undefined; });
      s.setup(bus);
      await bus.call('chat:run', ctx(), { message: { role: 'user', content: 'x' } });
      expect(endCount, `scenario: ${s.name}`).toBe(1);
    }
  });
});
