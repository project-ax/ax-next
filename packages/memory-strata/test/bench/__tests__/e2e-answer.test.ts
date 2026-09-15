import { describe, it, expect, vi } from 'vitest';
import { runAnswerLoop, buildAnswerSystem, type MemorySearchResult, type ReadSectionFn } from '../e2e-answer.js';

/** A no-op read_section stub for tests that don't exercise the drill-in path. */
const noReadSection = (): ReturnType<ReadSectionFn> => Promise.resolve({ body: '' });

describe('e2e answer loop (TASK-189)', () => {
  it('drills into a doc via memory_read_section after search, then answers from the body', async () => {
    // Reproduces the harness bug the first live run surfaced: with only
    // memory_search (summaries) the agent abstains; it needs memory_read_section
    // to read the fact BODY. This asserts the two-step shipped retrieval flow.
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'entity/degree', category: 'entity', slug: 'degree', summary: 'User education background.', snippet: 'education background', matchedFacts: [], score: 1 },
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
      { docId: 'preference/cortados', category: 'preference', slug: 'cortados', summary: 'User loves cortados.', snippet: 'loves cortados', matchedFacts: [], score: 1 },
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
        summary: "User's decisions", snippet: 'graduated with a B.A. in Business Administration', matchedFacts: [], score: 1 },
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
        summary: "User's decisions", snippet: '', matchedFacts: [], score: 1 },
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

  it('renders matchedFacts as a facts: block under the hit', async () => {
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'episode/festivals', category: 'episode', slug: 'festivals',
        summary: 'Film festivals attended', snippet: 'festival',
        matchedFacts: [
          '(2026-02-01) went to Austin Film Festival',
          'volunteered at Portland Film Festival',
        ],
        score: 1 },
    ]);
    const create = vi.fn()
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'memory_search', input: { query: 'film festivals' } }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'You attended two festivals.' }],
        usage: { input_tokens: 150, output_tokens: 10 },
      });

    await runAnswerLoop({
      client: { messages: { create } }, model: 'm', maxToolTurns: 4,
      system: 'sys', question: 'How many film festivals did I attend?', search, readSection: noReadSection,
    });

    const toolResult = create.mock.calls[1]![0].messages.at(-1).content[0];
    // Pin the exact facts: block with its precise indentation so a wrong
    // indent or order regression is caught, not just the bare fact text.
    expect(toolResult.content).toContain(
      '\n    facts:\n' +
        '      - (2026-02-01) went to Austin Film Festival\n' +
        '      - volunteered at Portland Film Festival',
    );
  });

  it('renders the facts: block even when the snippet is empty (orchestrator <load> row)', async () => {
    // The orchestrator-mode <load> row shape: snippet: '' (no query-matched
    // excerpt) but matchedFacts carried from the index (Task 3). The facts
    // block must still render, and no `match:` line should appear.
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'episode/festivals', category: 'episode', slug: 'festivals',
        summary: 'Film festivals attended', snippet: '',
        matchedFacts: ['(2026-02-01) went to Austin Film Festival'],
        score: 1 },
    ]);
    const create = vi.fn()
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'memory_search', input: { query: 'film festivals' } }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'You attended a festival.' }],
        usage: { input_tokens: 150, output_tokens: 10 },
      });

    await runAnswerLoop({
      client: { messages: { create } }, model: 'm', maxToolTurns: 4,
      system: 'sys', question: 'What festivals?', search, readSection: noReadSection,
    });

    const toolResult = create.mock.calls[1]![0].messages.at(-1).content[0];
    expect(toolResult.content).toContain('\n    facts:\n      - (2026-02-01) went to Austin Film Festival');
    expect(toolResult.content).not.toContain('match:');
  });

  it('omits the facts: block when matchedFacts is empty', async () => {
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'decision/user', category: 'decision', slug: 'user',
        summary: "User's decisions", snippet: 'graduated', matchedFacts: [], score: 1 },
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
    expect(toolResult.content).not.toContain('facts:');
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
      { docId: 'episodes/x', category: 'episode', slug: 'x', summary: 's', snippet: 's', matchedFacts: [], score: 1 },
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

// Bench temporal fidelity (Task 5): the questionDate→system-prompt append lives
// in makeAnthropicAnswerClient.answer, which the driver test can't cover (its
// stub reconstructs the string itself). buildAnswerSystem is the extracted pure
// fn so the exact format is pinned here — a dropped .trim(), a single-newline
// separator, or a misspelled label fails LOUDLY instead of slipping through.
describe('buildAnswerSystem (answer system-prompt assembly)', () => {
  it('appends "Today\'s date: <date>" as the exact suffix when a questionDate is given', () => {
    const system = buildAnswerSystem('', '2023-06-01');
    // Pin the exact suffix, including BOTH newline separators.
    expect(system.endsWith("\n\nToday's date: 2023-06-01")).toBe(true);
  });

  it('trims surrounding whitespace off the questionDate before appending', () => {
    const system = buildAnswerSystem('', '  2023-06-01  ');
    expect(system.endsWith("\n\nToday's date: 2023-06-01")).toBe(true);
  });

  it('omits the date line entirely when questionDate is undefined', () => {
    const system = buildAnswerSystem('some memory', undefined);
    expect(system).not.toContain("Today's date:");
  });

  it('omits the date line when questionDate is whitespace-only', () => {
    const system = buildAnswerSystem('some memory', '   ');
    expect(system).not.toContain("Today's date:");
  });

  it('wraps non-empty injected memory in a "# Injected memory" block', () => {
    const system = buildAnswerSystem('User loves cortados.', undefined);
    expect(system).toContain('\n\n# Injected memory\nUser loves cortados.');
  });

  it('uses the bare preamble (no injected-memory block) when memory is empty/whitespace', () => {
    const system = buildAnswerSystem('   ', undefined);
    expect(system).not.toContain('# Injected memory');
  });
});

describe('answer-stage arms (TASK-370 scaffold / TASK-371 thinking)', () => {
  it('omits the recall scaffold by default, so the control arm is unchanged', () => {
    const system = buildAnswerSystem('mem', undefined);
    expect(system).not.toContain('An intention is not an occurrence');
    expect(system).not.toContain('The newest dated value wins');
  });

  it('appends the recall scaffold when asked, before the injected-memory block', () => {
    const system = buildAnswerSystem('User loves cortados.', undefined, true);
    expect(system).toContain('An intention is not an occurrence');
    expect(system).toContain('The newest dated value wins');
    // Order matters: the rules must precede the memory they govern.
    expect(system.indexOf('An intention is not an occurrence')).toBeLessThan(
      system.indexOf('# Injected memory'),
    );
  });

  it('sends NO thinking or output_config by default — on Sonnet 4.6 that means thinking is off', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: async (req: Record<string, unknown>) => {
          seen.push(req);
          return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    };
    await runAnswerLoop({
      client: client as never, model: 'm', maxToolTurns: 0, system: 's', question: 'q',
      search: async () => [] as MemorySearchResult[], readSection: (async () => '') as ReadSectionFn,
    });
    expect(seen[0]).not.toHaveProperty('thinking');
    expect(seen[0]).not.toHaveProperty('output_config');
    // The control ceiling, which the 2026-09-15 measurement showed is not binding.
    expect(seen[0]?.max_tokens).toBe(512);
  });

  it('sends adaptive thinking + effort when an effort is given (never budget_tokens)', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: async (req: Record<string, unknown>) => {
          seen.push(req);
          return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    };
    await runAnswerLoop({
      client: client as never, model: 'm', maxToolTurns: 0, system: 's', question: 'q',
      search: async () => [] as MemorySearchResult[], readSection: (async () => '') as ReadSectionFn,
      effort: 'high', maxTokens: 4096,
    });
    // budget_tokens is DEPRECATED on Sonnet 4.6; adaptive is the current surface.
    expect(seen[0]?.thinking).toEqual({ type: 'adaptive' });
    expect(seen[0]?.output_config).toEqual({ effort: 'high' });
    expect(seen[0]?.thinking).not.toHaveProperty('budget_tokens');
    // Thinking tokens bill against max_tokens, so the ceiling must rise with it.
    expect(seen[0]?.max_tokens).toBe(4096);
  });
});
