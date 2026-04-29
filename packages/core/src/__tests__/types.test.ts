import { describe, it, expect } from 'vitest';
import type { AgentMessage, AgentOutcome } from '../index.js';

describe('AgentMessage / AgentOutcome', () => {
  it('AgentMessage accepts all three roles (user, assistant, system)', () => {
    // Pins the 3-role union deliberately. Phase 4 keeps `'system'` so
    // LlmRequest/LlmResponse callers still type-check; Phase 7 narrows
    // to 2 roles when those types die. If this test stops compiling,
    // the union has drifted ahead of schedule.
    const user: AgentMessage = { role: 'user', content: 'hi' };
    const assistant: AgentMessage = { role: 'assistant', content: 'hello' };
    const system: AgentMessage = { role: 'system', content: 'be brief' };
    expect(user.role).toBe('user');
    expect(assistant.role).toBe('assistant');
    expect(system.role).toBe('system');
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
