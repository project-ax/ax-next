import { describe, it, expect } from 'vitest';
import {
  HookBus,
  registerChatLoop,
  makeChatContext,
  createLogger,
  type ChatOutcome,
} from '../index.js';

describe('Week 1-2 acceptance', () => {
  it('chat:run returns a clean terminated outcome when no llm:call is registered', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    const ctx = makeChatContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u',
      logger: createLogger({ reqId: 'acceptance', writer: () => {} }),
      workspaceRoot: process.cwd(),
    });
    const outcome: ChatOutcome = await bus.call(
      'chat:run',
      ctx,
      { message: { role: 'user', content: 'hello' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('no-service:llm:call');
      expect(outcome.error).toBeDefined();
    }
  });
});
