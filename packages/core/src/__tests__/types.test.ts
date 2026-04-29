import { describe, it, expect } from 'vitest';
import type { AgentMessage, AgentOutcome } from '../index.js';

describe('AgentMessage / AgentOutcome', () => {
  it('AgentMessage has the expected shape', () => {
    const m: AgentMessage = { role: 'user', content: 'hi' };
    expect(m.role).toBe('user');
    expect(m.content).toBe('hi');
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
