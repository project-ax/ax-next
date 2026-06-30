import { describe, it, expect, vi } from 'vitest';
import { runAnswerLoop, type MemorySearchResult } from '../e2e-answer.js';

describe('e2e answer loop (TASK-189)', () => {
  it('drives a memory_search round-trip then returns the final text answer', async () => {
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'preference/cortados', category: 'preference', slug: 'cortados', summary: 'User loves cortados.', score: 1 },
    ]);

    // Turn 1: model asks to search. Turn 2: model answers from the result.
    const create = vi.fn()
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'memory_search', input: { query: 'coffee preference' } },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'You prefer cortados.' }],
        usage: { input_tokens: 150, output_tokens: 10 },
      });

    const out = await runAnswerLoop({
      client: { messages: { create } },
      model: 'claude-sonnet-4-6',
      maxToolTurns: 4,
      system: 'sys',
      question: 'What coffee do I like?',
      search,
    });

    expect(out.text).toBe('You prefer cortados.');
    expect(out.toolCalls).toBe(1);
    expect(out.usage).toEqual({ in: 250, out: 30 });
    expect(search).toHaveBeenCalledWith({ query: 'coffee preference' });

    // Second create call must echo the assistant tool_use + a tool_result user turn.
    const secondReq = create.mock.calls[1]![0];
    expect(secondReq.messages).toHaveLength(3);
    expect(secondReq.messages[1].role).toBe('assistant');
    expect(secondReq.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
    });
  });

  it('answers directly without searching when the model emits text immediately', async () => {
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => []);
    const create = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text', text: "I don't know." }],
      usage: { input_tokens: 80, output_tokens: 5 },
    });

    const out = await runAnswerLoop({
      client: { messages: { create } },
      model: 'claude-sonnet-4-6',
      maxToolTurns: 4,
      system: 'sys',
      question: 'What is my hamster named?',
      search,
    });

    expect(out.text).toBe("I don't know.");
    expect(out.toolCalls).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('disables tools on the final turn so a runaway searcher still answers', async () => {
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'episodes/x', category: 'episode', slug: 'x', summary: 's', score: 1 },
    ]);
    // Always tries to search; with maxToolTurns=2 the loop forces a tools-off
    // final turn where we make the model answer.
    const create = vi.fn().mockImplementation((req: { tools?: unknown }) => {
      if (req.tools) {
        return Promise.resolve({
          content: [{ type: 'tool_use', id: 'tu', name: 'memory_search', input: { query: 'q' } }],
          usage: { input_tokens: 10, output_tokens: 2 },
        });
      }
      return Promise.resolve({
        content: [{ type: 'text', text: 'final answer' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    });

    const out = await runAnswerLoop({
      client: { messages: { create } },
      model: 'claude-sonnet-4-6',
      maxToolTurns: 2,
      system: 'sys',
      question: 'q?',
      search,
    });

    expect(out.text).toBe('final answer');
    // 2 tool turns + 1 final tools-off turn = 3 create calls; 2 searches.
    expect(create).toHaveBeenCalledTimes(3);
    expect(out.toolCalls).toBe(2);
    // The last request must NOT carry tools.
    expect(create.mock.calls.at(-1)![0].tools).toBeUndefined();
  });
});
