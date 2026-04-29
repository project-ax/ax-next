import { describe, it, expect } from 'vitest';
import type { AgentMessage, AgentOutcome } from '../index.js';

describe('AgentMessage / AgentOutcome', () => {
  it('AgentMessage accepts user and assistant roles', () => {
    const user: AgentMessage = { role: 'user', content: 'hi' };
    const assistant: AgentMessage = { role: 'assistant', content: 'hello' };
    expect(user.role).toBe('user');
    expect(assistant.role).toBe('assistant');
  });

  it('AgentOutcome.complete carries AgentMessage[]', () => {
    const o: AgentOutcome = {
      kind: 'complete',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };
    expect(o.kind).toBe('complete');
    if (o.kind === 'complete') {
      expect(o.messages).toHaveLength(2);
    }
  });
});
