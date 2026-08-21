import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} from '../compaction/context-window.js';
import {
  estimateMessageTokens,
  estimatePromptOverheadTokens,
  estimateTextTokens,
} from '../compaction/estimate.js';
import {
  maskStaleToolOutputs,
  preservedMessageCount,
  pruneOldToolCalls,
} from '../compaction/ladder.js';
import {
  ContextWindowExceededError,
  createCompactor,
  findContextWindowExceeded,
} from '../compaction/compactor.js';
import type { SummarizeText } from '../compaction/summarize.js';

// ---------------------------------------------------------------------------
// Compaction — rungs 1 and 2 plus the ceiling (design §7).
//
// The two properties worth stating up front, because most of what follows is
// checking one of them:
//
//   - NOTHING IS MUTATED. These functions run over the same `ModelMessage`
//     objects the in-memory transcript holds, and the transcript's bytes are
//     the host's source of truth. An in-place edit here would change the
//     shipped prefix and force a resync on every resume.
//   - TOOL CALLS STAY PAIRED. An orphaned tool_use or tool_result is a 400
//     from Anthropic, not a degraded answer.
// ---------------------------------------------------------------------------

// ---- fixtures --------------------------------------------------------------

function userMsg(text: string): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantToolCall(id: string, text = ''): ModelMessage {
  return {
    role: 'assistant',
    content: [
      ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
      { type: 'tool-call', toolCallId: id, toolName: 'Bash', input: { command: 'ls' } },
    ],
  };
}

function toolResult(id: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'Bash',
        output: { type: 'text', value },
      },
    ],
  };
}

/** A conversation of `pairs` tool round-trips, each output `chars` long. */
function conversation(pairs: number, chars: number): ModelMessage[] {
  const out: ModelMessage[] = [userMsg('do the thing')];
  for (let i = 0; i < pairs; i++) {
    out.push(assistantToolCall(`c${i}`), toolResult(`c${i}`, `${i}:`.padEnd(chars, 'x')));
  }
  return out;
}

/** A deep structural snapshot, for the no-mutation assertions. */
function snapshot(messages: readonly ModelMessage[]): string {
  return JSON.stringify(messages);
}

const toolResultValues = (messages: readonly ModelMessage[]): string[] =>
  messages.flatMap((m) =>
    typeof m.content === 'string'
      ? []
      : m.content.flatMap((p) =>
          p.type === 'tool-result' && p.output.type === 'text' ? [p.output.value] : [],
        ),
  );

const toolCallIds = (messages: readonly ModelMessage[]): string[] =>
  messages.flatMap((m) =>
    typeof m.content === 'string'
      ? []
      : m.content.flatMap((p) => (p.type === 'tool-call' ? [p.toolCallId] : [])),
  );

const toolResultIds = (messages: readonly ModelMessage[]): string[] =>
  messages.flatMap((m) =>
    typeof m.content === 'string'
      ? []
      : m.content.flatMap((p) => (p.type === 'tool-result' ? [p.toolCallId] : [])),
  );

// ---- context window --------------------------------------------------------

describe('contextWindowFor', () => {
  it('gives every Anthropic model the 200k window, including unlisted ones', () => {
    expect(contextWindowFor('anthropic/claude-sonnet-4-6')).toBe(200_000);
    // The case a per-model map handles worst: a model released after this
    // table was written.
    expect(contextWindowFor('anthropic/claude-something-not-yet-shipped')).toBe(200_000);
  });

  it('knows the two OpenRouter models the provider gate names', () => {
    expect(contextWindowFor('openrouter/x-ai/grok-4.6')).toBe(500_000);
    expect(contextWindowFor('openrouter/moonshotai/kimi-k3')).toBe(1_000_000);
  });

  it('shares a window across OpenRouter variant suffixes', () => {
    // `:free` / `:batch` select a routing flavour of the same model — same
    // window, and listing every variant would be a table nobody maintains.
    expect(contextWindowFor('openrouter/x-ai/grok-4.6:free')).toBe(500_000);
    expect(contextWindowFor('openrouter/x-ai/grok-4.6:batch')).toBe(500_000);
  });

  it('falls back conservatively for an unknown model or provider', () => {
    expect(contextWindowFor('openrouter/some-vendor/some-model')).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    expect(contextWindowFor('vertex/gemini-3-pro')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it('does not resolve prototype keys to a window', () => {
    // `CONTEXT_WINDOWS['constructor']` is not undefined without an own-property
    // guard, and both halves of the ref are ultimately admin-supplied.
    expect(contextWindowFor('constructor/toString')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(contextWindowFor('__proto__/x')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(contextWindowFor('anthropic/constructor')).toBe(200_000);
  });

  it('returns the default rather than throwing on a malformed ref', () => {
    // A size lookup must never be the thing that kills a turn.
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(contextWindowFor('')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});

// ---- estimator -------------------------------------------------------------

describe('the fallback estimator', () => {
  it('scales with text length', () => {
    const small = estimateMessageTokens([userMsg('hi')]);
    const big = estimateMessageTokens([userMsg('x'.repeat(3500))]);
    expect(big).toBeGreaterThan(small * 100);
  });

  it('charges a flat allowance for binary parts instead of their base64 length', () => {
    // The failure this exists to prevent: a 1 MB base64 image reading as
    // ~285k tokens when it is really ~1.5k.
    const oneMegabyteOfBase64 = 'A'.repeat(1_000_000);
    const withImage = estimateMessageTokens([
      {
        role: 'user',
        content: [{ type: 'image', image: oneMegabyteOfBase64, mediaType: 'image/png' }],
      },
    ]);
    expect(withImage).toBeLessThan(10_000);
  });

  it('counts tool call inputs and tool result outputs', () => {
    const withOutput = estimateMessageTokens([toolResult('c1', 'y'.repeat(7000))]);
    expect(withOutput).toBeGreaterThan(1_500);
    const withInput = estimateMessageTokens([assistantToolCall('c1')]);
    expect(withInput).toBeGreaterThan(0);
  });

  it('never returns zero for a part shape it does not recognise', () => {
    // The SDK adds part types between minors; an estimator that silently
    // returns 0 for a new one under-reads exactly when something large lands.
    const exotic = estimateMessageTokens([
      {
        role: 'assistant',
        content: [{ type: 'not-a-real-part-type', payload: 'z'.repeat(3500) }] as never,
      },
    ]);
    expect(exotic).toBeGreaterThan(500);
  });

  it('charges the system prompt and the tool definitions as fixed overhead', () => {
    const none = estimatePromptOverheadTokens({ instructions: '', toolCount: 0 });
    const some = estimatePromptOverheadTokens({
      instructions: 'x'.repeat(350),
      toolCount: 10,
    });
    expect(none).toBe(0);
    expect(some).toBeGreaterThan(estimateTextTokens('x'.repeat(350)));
  });
});

// ---- rung 1: mask ----------------------------------------------------------

describe('rung 1 — masking stale tool outputs', () => {
  it('masks outputs older than the preserved window and leaves the newest alone', () => {
    const messages = conversation(6, 4000);
    const before = snapshot(messages);
    const out = maskStaleToolOutputs(messages);

    const preserved = preservedMessageCount(messages.length);
    const kept = out.slice(out.length - preserved);
    // Nothing in the preserved window was touched — same object identity.
    for (let i = 0; i < preserved; i++) {
      expect(kept[i]).toBe(messages[messages.length - preserved + i]);
    }
    const older = toolResultValues(out.slice(0, out.length - preserved));
    expect(older.length).toBeGreaterThan(0);
    for (const value of older) {
      expect(value).toContain('more characters were dropped');
      expect(value.length).toBeLessThan(1_000);
    }
    expect(snapshot(messages)).toBe(before);
  });

  it('leaves outputs that are already small alone', () => {
    const messages = conversation(6, 20);
    const out = maskStaleToolOutputs(messages);
    expect(out).toEqual(messages);
    for (const value of toolResultValues(out)) {
      expect(value).not.toContain('dropped');
    }
  });

  it('keeps every tool call paired with its result', () => {
    // Masking rewrites CONTENT only; it must never drop a part or a message.
    const messages = conversation(6, 4000);
    const out = maskStaleToolOutputs(messages);
    expect(out).toHaveLength(messages.length);
    expect(toolCallIds(out)).toEqual(toolCallIds(messages));
    expect(toolResultIds(out)).toEqual(toolResultIds(messages));
  });

  it('is idempotent, because its output carries forward into the next step', () => {
    const once = maskStaleToolOutputs(conversation(6, 4000));
    const twice = maskStaleToolOutputs(once);
    expect(twice).toEqual(once);
  });

  it('does nothing when everything fits in the preserved window', () => {
    const messages = conversation(1, 9000);
    expect(maskStaleToolOutputs(messages)).toEqual(messages);
  });

  it('renders a JSON output as elided text rather than as truncated JSON', () => {
    const messages: ModelMessage[] = [
      userMsg('go'),
      assistantToolCall('c1'),
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'Bash',
            output: { type: 'json', value: { blob: 'q'.repeat(4000) } },
          },
        ],
      },
      userMsg('and again'),
      assistantToolCall('c2'),
      toolResult('c2', 'small'),
    ];
    const out = maskStaleToolOutputs(messages);
    const first = out[2];
    if (first === undefined || typeof first.content === 'string') throw new Error('shape');
    const part = first.content[0];
    if (part === undefined || part.type !== 'tool-result') throw new Error('shape');
    // Truncated JSON labelled as JSON would invite the model to parse it.
    expect(part.output.type).toBe('text');
  });

  it('keeps a failed tool call looking failed', () => {
    // The provider renders the error flag (Anthropic's `is_error`). Masking an
    // `error-text` down to plain `text` would quietly turn an old failed
    // command into one the model reads as having succeeded.
    const messages: ModelMessage[] = [
      userMsg('go'),
      assistantToolCall('c1'),
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'Bash',
            output: { type: 'error-text', value: `boom: ${'e'.repeat(4000)}` },
          },
        ],
      },
      userMsg('and again'),
      assistantToolCall('c2'),
      toolResult('c2', 'small'),
    ];
    const out = maskStaleToolOutputs(messages);
    const first = out[2];
    if (first === undefined || typeof first.content === 'string') throw new Error('shape');
    const part = first.content[0];
    if (part === undefined || part.type !== 'tool-result') throw new Error('shape');
    expect(part.output.type).toBe('error-text');
    expect(JSON.stringify(part.output)).toContain('were dropped');
  });
});

// ---- rung 2: prune ---------------------------------------------------------

describe('rung 2 — pruning old tool calls', () => {
  it('drops old call/result pairs together and keeps the recent ones', () => {
    const messages = conversation(6, 4000);
    const before = snapshot(messages);
    const out = pruneOldToolCalls(messages);

    // Both halves go together — no orphan on either side.
    expect(toolCallIds(out)).toEqual(toolResultIds(out));
    expect(toolCallIds(out).length).toBeLessThan(toolCallIds(messages).length);
    expect(toolCallIds(out).length).toBeGreaterThan(0);
    expect(snapshot(messages)).toBe(before);
  });

  it('removes the messages it empties instead of sending empty content', () => {
    const messages = conversation(6, 4000);
    const out = pruneOldToolCalls(messages);
    for (const m of out) {
      expect(typeof m.content === 'string' || m.content.length > 0).toBe(true);
    }
    expect(out.length).toBeLessThan(messages.length);
  });

  it('keeps assistant text that shared a message with a pruned tool call', () => {
    const messages: ModelMessage[] = [
      userMsg('go'),
      assistantToolCall('c0', 'let me look'),
      toolResult('c0', 'x'.repeat(4000)),
      userMsg('again'),
      assistantToolCall('c1', 'looking'),
      toolResult('c1', 'y'.repeat(4000)),
      userMsg('once more'),
      assistantToolCall('c2', 'still looking'),
      toolResult('c2', 'z'.repeat(4000)),
    ];
    const out = pruneOldToolCalls(messages);
    expect(JSON.stringify(out)).toContain('let me look');
  });

  it('leaves reasoning alone — provider.ts owns that policy', () => {
    // Doing it here too would be a second owner of one decision, and
    // `before-last-message` mid-tool-loop would strip the signed thinking block
    // Anthropic requires alongside the tool_use.
    const messages: ModelMessage[] = [
      userMsg('go'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking about it' },
          { type: 'tool-call', toolCallId: 'c0', toolName: 'Bash', input: {} },
        ],
      },
      toolResult('c0', 'x'.repeat(4000)),
      userMsg('again'),
      assistantToolCall('c1'),
      toolResult('c1', 'y'.repeat(4000)),
      userMsg('more'),
      assistantToolCall('c2'),
      toolResult('c2', 'z'.repeat(4000)),
    ];
    expect(JSON.stringify(pruneOldToolCalls(messages))).toContain('thinking about it');
  });
});

// ---- the policy ------------------------------------------------------------

/** Enough conversation to sit near a share of the 128k default window. */
function bigConversation(pairs: number): ModelMessage[] {
  return conversation(pairs, 20_000);
}

const UNKNOWN_MODEL = 'openrouter/some-vendor/some-model'; // 128k default window

function compactorFor(log = vi.fn()) {
  return {
    compactor: createCompactor({
      modelRef: UNKNOWN_MODEL,
      instructions: 'be helpful',
      toolCount: 10,
      log,
    }),
    log,
  };
}

const stepsWith = (inputTokens: number | undefined) => [{ usage: { inputTokens } }];

/** The fixed overhead `compactorFor`'s compactors charge. */
const OVERHEAD = estimatePromptOverheadTokens({
  instructions: 'be helpful',
  toolCount: 10,
});

describe('the compaction policy', () => {
  it('sizes itself from the model ref', () => {
    expect(
      createCompactor({
        modelRef: 'openrouter/moonshotai/kimi-k3',
        instructions: '',
        toolCount: 0,
      }).contextWindowTokens,
    ).toBe(1_000_000);
  });

  it('leaves a step alone while the conversation is small', () => {
    const { compactor, log } = compactorFor();
    expect(
      compactor.step({ steps: stepsWith(1_000), messages: bigConversation(6) }),
    ).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('compacts once the reported usage crosses the threshold', () => {
    const { compactor, log } = compactorFor();
    const messages = bigConversation(6);
    // 0.7 of the 128k default window.
    const result = compactor.step({ steps: stepsWith(90_000), messages });

    expect(result).toBeDefined();
    expect(JSON.stringify(result?.messages)).toContain('more characters were dropped');
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('compaction:');
  });

  it('runs at step 0 of a turn, where no usage has been reported yet', () => {
    // Every turn is a fresh `stream()` call, so step 0 NEVER has a previous
    // step. Without the estimator the first request of every turn — the one a
    // resumed long conversation fails on — would go out uncompacted.
    const { compactor } = compactorFor();
    const result = compactor.step({ steps: [], messages: bigConversation(16) });
    expect(result).toBeDefined();
    expect(JSON.stringify(result?.messages)).toContain('more characters were dropped');
  });

  it('escalates to rung 2 when masking alone is not enough', () => {
    const { compactor, log } = compactorFor();
    // The bulk sits in the PRESERVED window, which rung 1 may not touch, so
    // masking reclaims nothing and the ladder has to take the next rung.
    const messages: ModelMessage[] = [
      ...conversation(14, 300),
      assistantToolCall('big1'),
      toolResult('big1', 'x'.repeat(250_000)),
      assistantToolCall('big2'),
      toolResult('big2', 'y'.repeat(250_000)),
    ];
    const compacted = compactor.step({ steps: stepsWith(80_000), messages });
    expect(String(log.mock.calls[0]?.[0])).toContain('mask+prune');
    // Rung 2's signature: whole messages gone, not just shorter ones.
    expect(compacted?.messages.length).toBeLessThan(messages.length);
  });

  it('fails the turn when a fully compacted conversation still does not fit', () => {
    const { compactor } = compactorFor();
    // One enormous tool result inside the preserved window: nothing the ladder
    // can reclaim, and the provider says we are at 96% of the window.
    const messages = [
      userMsg('go'),
      assistantToolCall('c0'),
      toolResult('c0', 'x'.repeat(400_000)),
    ];
    expect(() => compactor.step({ steps: stepsWith(123_000), messages })).toThrow(
      ContextWindowExceededError,
    );
    try {
      compactor.step({ steps: stepsWith(123_000), messages });
      expect.unreachable('the ceiling should have thrown');
    } catch (err) {
      // Written for the person reading the retry card.
      expect((err as Error).message).toContain('no longer fits');
      expect((err as Error).message).toContain('Starting a new conversation');
    }
  });

  it('never fails a turn on the strength of an estimate alone', () => {
    // Same hopeless shape, but no provider-reported number. Ending a
    // conversation on a chars-per-token guess would be the worst false
    // positive available; the provider's own error is the better backstop.
    const { compactor } = compactorFor();
    const messages = [
      userMsg('go'),
      assistantToolCall('c0'),
      toolResult('c0', 'x'.repeat(900_000)),
    ];
    expect(() => compactor.step({ steps: [], messages })).not.toThrow();
  });

  it('hands back the original step when there is nothing left to reclaim', () => {
    const { compactor, log } = compactorFor();
    // Over the threshold, under the ceiling, and nothing older than the
    // preserved window to mask.
    const messages = [
      userMsg('go'),
      assistantToolCall('c0'),
      toolResult('c0', 'x'.repeat(30_000)),
    ];
    expect(compactor.step({ steps: stepsWith(80_000), messages })).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('does not mutate the messages it was handed', () => {
    // They are the same objects the transcript holds, and the transcript's
    // bytes are the host's source of truth.
    const { compactor } = compactorFor();
    const messages = bigConversation(12);
    const before = snapshot(messages);
    compactor.step({ steps: stepsWith(90_000), messages });
    expect(snapshot(messages)).toBe(before);
  });

  it('is stable when its own output is fed back in, as it is every step', () => {
    const { compactor } = compactorFor();
    const first = compactor.step({
      steps: stepsWith(90_000),
      messages: bigConversation(12),
    });
    expect(first).toBeDefined();
    const second = compactor.step({
      steps: stepsWith(40_000),
      messages: first?.messages ?? [],
    });
    // Already compacted and now well under the threshold: nothing further.
    expect(second).toBeUndefined();
  });
});

describe('findContextWindowExceeded', () => {
  const ceiling = new ContextWindowExceededError('too long');

  it('finds it directly, and through the cause chain the SDK wraps it in', () => {
    expect(findContextWindowExceeded(ceiling)).toBe(ceiling);
    const wrapped = new Error('No output generated.', {
      cause: new Error('step failed', { cause: ceiling }),
    });
    expect(findContextWindowExceeded(wrapped)).toBe(ceiling);
  });

  it('returns undefined for unrelated errors and non-errors', () => {
    expect(findContextWindowExceeded(new Error('rate limited'))).toBeUndefined();
    expect(findContextWindowExceeded(undefined)).toBeUndefined();
    expect(findContextWindowExceeded('a string')).toBeUndefined();
  });

  it('terminates on a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(findContextWindowExceeded(a)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rung 3 at the turn boundary (design §7, PR 7).
//
// `turn()` is where the ladder's cheapest-first ordering is enforced ACROSS the
// two entry points: it must decline whenever rungs 1-2 would have carried the
// turn on their own, because the alternative is paying for a model call to
// solve a problem two pure functions already solved.
// ---------------------------------------------------------------------------

/** A compactor with rung 3 armed. `summarizeText` records what it was sent. */
function summarizingCompactorFor(
  summarizeText: SummarizeText = async () => 'a short summary',
  log = vi.fn(),
) {
  return {
    compactor: createCompactor({
      modelRef: UNKNOWN_MODEL,
      instructions: 'be helpful',
      toolCount: 10,
      summarizeText,
      log,
    }),
    log,
  };
}

/**
 * A conversation of `turns` user→tool→result→answer exchanges with `chars` of
 * tool output each — the shape rung 3 exists for (growth across turns), as
 * opposed to `bigConversation`'s single runaway turn.
 */
function longChat(turns: number, chars: number): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(
      userMsg(`ask ${i}`),
      assistantToolCall(`t${i}`),
      toolResult(`t${i}`, `${i}:`.padEnd(chars, 'x')),
      { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] },
    );
  }
  return out;
}

describe('rung 3 at the turn boundary', () => {
  it('declines while the conversation is small', async () => {
    const summarizeText = vi.fn<SummarizeText>(async () => 'summary');
    const { compactor } = summarizingCompactorFor(summarizeText);

    const result = await compactor.turn({ messages: longChat(4, 1_000) });

    expect(result).toEqual({ summarized: false, reason: 'below-threshold' });
    expect(summarizeText).not.toHaveBeenCalled();
  });

  it('declines when masking and pruning would carry the turn on their own', async () => {
    // The ladder is cheapest-first. This conversation is over the rung-3
    // threshold as stored, but its bulk is one turn's tool output — exactly
    // what rungs 1-2 reclaim for free at the send site.
    const summarizeText = vi.fn<SummarizeText>(async () => 'summary');
    const { compactor } = summarizingCompactorFor(summarizeText);
    const messages = bigConversation(20); // ~400k chars, all in tool results

    const asStored = estimateMessageTokens(messages);
    expect(asStored).toBeGreaterThan(0.75 * 128_000);

    expect(await compactor.turn({ messages })).toEqual({
      summarized: false,
      reason: 'below-threshold',
    });
    expect(summarizeText).not.toHaveBeenCalled();
  });

  it('summarizes when even a masked-and-pruned conversation is too big', async () => {
    const summarizeText = vi.fn<SummarizeText>(async () => 'the user wants X');
    const { compactor, log } = summarizingCompactorFor(summarizeText);
    // Bulk in the PROSE of many turns, which neither mask nor prune touches.
    const messages = longChat(60, 40).map((m) =>
      m.role === 'assistant' && typeof m.content !== 'string' && m.content[0]?.type === 'text'
        ? ({
            role: 'assistant',
            content: [{ type: 'text', text: 'x'.repeat(9_000) }],
          } as ModelMessage)
        : m,
    );

    const result = await compactor.turn({ messages });

    expect(result.summarized).toBe(true);
    if (!result.summarized) return;
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(summarizeText).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('compaction: summarize');
  });

  it('is disabled, not broken, when no summarizer is supplied', async () => {
    // Rungs 1-2 plus the ceiling are a complete compactor on their own; a
    // caller with no model to spend gets that, not a crash.
    const { compactor } = compactorFor();
    expect(await compactor.turn({ messages: longChat(60, 9_000) })).toEqual({
      summarized: false,
      reason: 'below-threshold',
    });
  });

  it('falls through when the summarizer fails, and says so loudly', async () => {
    const { compactor, log } = summarizingCompactorFor(async () => {
      throw new Error('provider exploded');
    });

    const result = await compactor.turn({ messages: proseHeavyChat() });

    expect(result).toEqual({ summarized: false, reason: 'model-call-failed' });
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('summarize FAILED');
  });

  it('does not re-attempt after a failure until the conversation has grown', async () => {
    // §7's no-thrashing rule in its cross-turn form: a deterministic failure
    // must not buy a model call at the top of every remaining turn.
    const summarizeText = vi.fn<SummarizeText>(async () => '');
    const { compactor } = summarizingCompactorFor(summarizeText);
    const messages = proseHeavyChat();

    expect(await compactor.turn({ messages })).toEqual({
      summarized: false,
      reason: 'empty-summary',
    });
    expect(await compactor.turn({ messages })).toEqual({
      summarized: false,
      reason: 'backoff',
    });
    expect(summarizeText).toHaveBeenCalledTimes(1);

    // Grown by more than 25%: the input is materially different now, so trying
    // again is a new attempt rather than a retry.
    const grown = [...messages, ...proseHeavyChat().slice(0, messages.length)];
    await compactor.turn({ messages: grown });
    expect(summarizeText).toHaveBeenCalledTimes(2);
  });

  it('re-arms after a success, so one bad turn does not disable rung 3', async () => {
    let calls = 0;
    const summarizeText = vi.fn<SummarizeText>(async () => {
      calls++;
      return calls === 1 ? '' : 'a real summary';
    });
    const { compactor } = summarizingCompactorFor(summarizeText);
    const first = proseHeavyChat();

    expect((await compactor.turn({ messages: first })).summarized).toBe(false);
    const grown = [...first, ...proseHeavyChat()];
    expect((await compactor.turn({ messages: grown })).summarized).toBe(true);
    // Back to zero: the next oversized turn tries immediately.
    expect((await compactor.turn({ messages: grown })).summarized).toBe(true);
  });

  it('calibrates the turn-boundary estimate against reported usage', async () => {
    // The turn boundary has no previous step to read usage from, so the
    // estimator stands in — scaled by how wrong it last proved to be. Here the
    // provider says the request was a QUARTER of what the estimator thought, so
    // a conversation the raw estimate would summarize is left alone.
    const summarizeText = vi.fn<SummarizeText>(async () => 'summary');
    const { compactor } = summarizingCompactorFor(summarizeText);
    const messages = proseHeavyChat();
    const raw = estimateMessageTokens(messages) + OVERHEAD;

    // Two steps, because that is how the pairing works: the first hands off a
    // request and remembers its estimate, the second carries the provider's
    // count OF that request.
    compactor.step({ steps: stepsWith(undefined), messages });
    compactor.step({ steps: stepsWith(Math.round(raw / 4)), messages });

    expect(await compactor.turn({ messages })).toEqual({
      summarized: false,
      reason: 'below-threshold',
    });
    expect(summarizeText).not.toHaveBeenCalled();
  });

  it('pairs a report with the request it counted, not with the next one', async () => {
    // The subtle one. `reported` arrives one step AFTER the request it measures,
    // and by then `messages` has grown by that step's response — which on a step
    // whose tool printed 200 KB is most of the list. Dividing the report by the
    // BIGGER list understates the scale factor, and understating it is invisible
    // (rung 3 just fires later than it should).
    const summarizeText = vi.fn<SummarizeText>(async () => 'summary');
    const { compactor } = summarizingCompactorFor(summarizeText);

    // Half-size, so that doubling the reported figure lands above the 0.75
    // rung-3 threshold but below the 0.9 ceiling — the band this test needs.
    const sent = proseHeavyChat(20);
    const sentEstimate = estimateMessageTokens(sent) + OVERHEAD;
    compactor.step({ steps: stepsWith(undefined), messages: sent });

    // A 200 KB tool result lands, and the provider reports 2x the estimate for
    // the request it actually counted.
    const grown = [...sent, toolResult('big', 'x'.repeat(200_000))];
    compactor.step({ steps: stepsWith(sentEstimate * 2), messages: grown });

    // Calibration must be 2, so the turn-boundary read of `sent` is 2x its raw
    // estimate — comfortably over the 0.75 threshold, and rung 3 fires. Paired
    // against `grown` it would have been well under 2 and this would decline.
    const result = await compactor.turn({ messages: sent });
    expect(result.summarized).toBe(true);
    expect(summarizeText).toHaveBeenCalledTimes(1);
  });

  it('never lets the estimate alone end a conversation', async () => {
    // The ceiling is the one decision an estimate may not make (compactor.ts).
    // Rung 3 is allowed to spend a model call on an estimate; it is not allowed
    // to throw, and a failing summarizer must not become a turn-ending error.
    const { compactor } = summarizingCompactorFor(async () => {
      throw new Error('nope');
    });
    await expect(compactor.turn({ messages: proseHeavyChat() })).resolves.toEqual({
      summarized: false,
      reason: 'model-call-failed',
    });
  });
});

/** A conversation whose bulk is prose — the shape mask and prune cannot shrink. */
function proseHeavyChat(turns = 40): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(
      userMsg(`ask ${i}`),
      { role: 'assistant', content: [{ type: 'text', text: `${i}:`.padEnd(9_000, 'x') }] },
    );
  }
  return out;
}
