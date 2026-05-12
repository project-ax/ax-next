import { describe, it, expect, vi } from 'vitest';
import { runAgent, type AgentClient } from '../agent.js';

describe('runAgent', () => {
  it('composes a system prompt with retrieved summaries and returns the model answer', async () => {
    const stub: AgentClient = {
      complete: vi.fn().mockResolvedValue({ text: 'The answer is 42.', usage: { in: 100, out: 5 } }),
    };
    const result = await runAgent(
      stub,
      { id: 'q1', text: 'What is the answer?', goldAnswer: '42' },
      [{ path: 'k/a', score: 1, summary: 'The number 42 is special.' }],
    );
    expect(result.text).toBe('The answer is 42.');
    expect(stub.complete).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const [args] = vi.mocked(stub.complete).mock.calls[0]!;
    expect(args.system).toContain('The number 42 is special');
    expect(args.user).toContain('What is the answer?');
  });
});
