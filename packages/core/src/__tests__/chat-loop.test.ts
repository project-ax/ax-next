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
});
