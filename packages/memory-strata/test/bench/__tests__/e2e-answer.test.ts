import { describe, it, expect, vi } from 'vitest';
import { runAnswerLoop, type MemorySearchResult, type ReadSectionFn } from '../e2e-answer.js';

/** A no-op read_section stub for tests that don't exercise the drill-in path. */
const noReadSection = (): ReturnType<ReadSectionFn> => Promise.resolve({ body: '' });

describe('e2e answer loop (TASK-189)', () => {
  it('drills into a doc via memory_read_section after search, then answers from the body', async () => {
    // Reproduces the harness bug the first live run surfaced: with only
    // memory_search (summaries) the agent abstains; it needs memory_read_section
    // to read the fact BODY. This asserts the two-step shipped retrieval flow.
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'entity/degree', category: 'entity', slug: 'degree', summary: 'User education background.', snippet: 'education background', score: 1 },
    ]);
    const readSection = vi.fn(
      async (): Promise<{ body: string } | { error: string }> => ({
        body: '# Education\n\nGraduated with a B.A. in Business Administration.',
      }),
    );

    // Turn 1: search → summary only. Turn 2: read_section the found doc → body.
    // Turn 3: answer from the body.
    const create = vi.fn()
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'memory_search', input: { query: 'degree' } }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_2', name: 'memory_read_section', input: { docId: 'entity/degree' } }],
        usage: { input_tokens: 120, output_tokens: 15 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'You graduated with a B.A. in Business Administration.' }],
        usage: { input_tokens: 150, output_tokens: 12 },
      });

    const out = await runAnswerLoop({
      client: { messages: { create } },
      model: 'claude-sonnet-4-6',
      maxToolTurns: 4,
      system: 'sys',
      question: 'What degree did I graduate with?',
      search,
      readSection,
    });

    expect(out.text).toContain('Business Administration');
    expect(out.toolCalls).toBe(2);
    expect(readSection).toHaveBeenCalledWith({ docId: 'entity/degree' });

    // memory_read_section must be advertised to the model alongside memory_search.
    const offeredTools = (create.mock.calls[0]![0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(offeredTools).toContain('memory_search');
    expect(offeredTools).toContain('memory_read_section');

    // The read_section tool_result must carry the doc BODY back to the model.
    const thirdReq = create.mock.calls[2]![0];
    const toolResult = thirdReq.messages.at(-1).content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_2' });
    expect(toolResult.content).toContain('Business Administration');
  });

  it('drives a memory_search round-trip then returns the final text answer', async () => {
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'preference/cortados', category: 'preference', slug: 'cortados', summary: 'User loves cortados.', snippet: 'loves cortados', score: 1 },
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
      readSection: noReadSection,
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

  it('includes the result snippet in the tool_result shown to the model', async () => {
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'decision/user', category: 'decision', slug: 'user',
        summary: "User's decisions", snippet: 'graduated with a B.A. in Business Administration', score: 1 },
    ]);
    const create = vi.fn()
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'memory_search', input: { query: 'degree' } }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'You graduated in Business Administration.' }],
        usage: { input_tokens: 150, output_tokens: 10 },
      });

    await runAnswerLoop({
      client: { messages: { create } }, model: 'm', maxToolTurns: 4,
      system: 'sys', question: 'What degree?', search, readSection: noReadSection,
    });

    const toolResult = create.mock.calls[1]![0].messages.at(-1).content[0];
    expect(toolResult.content).toContain('Business Administration');
  });

  it('omits the match: line when a result snippet is empty', async () => {
    // Orchestrator mode returns map-<load> rows with snippet: '' (orchestrator.ts).
    // Rendering `match: ""` verbatim would tell the model those docs — the ones
    // the orchestrator judged most relevant — matched nothing.
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'decision/user', category: 'decision', slug: 'user',
        summary: "User's decisions", snippet: '', score: 1 },
    ]);
    const create = vi.fn()
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'memory_search', input: { query: 'degree' } }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'You graduated in Business Administration.' }],
        usage: { input_tokens: 150, output_tokens: 10 },
      });

    await runAnswerLoop({
      client: { messages: { create } }, model: 'm', maxToolTurns: 4,
      system: 'sys', question: 'What degree?', search, readSection: noReadSection,
    });

    const toolResult = create.mock.calls[1]![0].messages.at(-1).content[0];
    expect(toolResult.content).toBe("[1] (decision/user) User's decisions");
    expect(toolResult.content).not.toContain('match:');
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
      readSection: noReadSection,
    });

    expect(out.text).toBe("I don't know.");
    expect(out.toolCalls).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('disables tools on the final turn so a runaway searcher still answers', async () => {
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'episodes/x', category: 'episode', slug: 'x', summary: 's', snippet: 's', score: 1 },
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
      readSection: noReadSection,
    });

    expect(out.text).toBe('final answer');
    // 2 tool turns + 1 final tools-off turn = 3 create calls; 2 searches.
    expect(create).toHaveBeenCalledTimes(3);
    expect(out.toolCalls).toBe(2);
    // The last request must NOT carry tools.
    expect(create.mock.calls.at(-1)![0].tools).toBeUndefined();
  });
});
