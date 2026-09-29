import { describe, expect, it } from 'vitest';
import { createTurnUsageAccumulator } from '../turn-usage.js';

// TASK-692. One Anthropic API response reaches this runner as SEVERAL SDK
// `assistant` messages (one per content block), all carrying the same
// `message.id` and the same `usage`. Summing them naively bills a thinking +
// text + tool_use response three times. The accumulator must count each
// response once.

const MODEL = 'anthropic/claude-sonnet-4-6';

function msg(
  id: string | undefined,
  usage: Record<string, number | null | undefined> | undefined,
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'assistant' as const,
    parent_tool_use_id: null,
    message: { ...(id !== undefined ? { id } : {}), ...(usage !== undefined ? { usage } : {}) },
    ...extra,
  };
}

describe('createTurnUsageAccumulator', () => {
  it('returns null when nothing was observed', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    expect(acc.drain()).toBeNull();
  });

  it('reports a single response with the model and all four buckets', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(
      msg('msg_1', {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 300,
      }),
    );
    expect(acc.drain()).toEqual({
      model: MODEL,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 5000,
      cacheWriteTokens: 300,
    });
  });

  it('counts a response once when several SDK messages share its id (identical usage)', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    const usage = {
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 20,
    };
    // thinking block, text block, tool_use block of ONE response
    acc.observeAssistant(msg('msg_1', usage));
    acc.observeAssistant(msg('msg_1', usage));
    acc.observeAssistant(msg('msg_1', usage));
    expect(acc.drain()).toEqual({
      model: MODEL,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 20,
    });
  });

  it('keeps the MAX per field per id: a later message may carry the final output_tokens', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(msg('msg_1', { input_tokens: 100, output_tokens: 1 }));
    acc.observeAssistant(msg('msg_1', { input_tokens: 100, output_tokens: 250 }));
    // A stale/smaller repeat must not lower it.
    acc.observeAssistant(msg('msg_1', { input_tokens: 100, output_tokens: 7 }));
    expect(acc.drain()).toMatchObject({ inputTokens: 100, outputTokens: 250 });
  });

  it('takes the max independently per field', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(msg('msg_1', { input_tokens: 10, output_tokens: 90 }));
    acc.observeAssistant(msg('msg_1', { input_tokens: 30, output_tokens: 20 }));
    expect(acc.drain()).toMatchObject({ inputTokens: 30, outputTokens: 90 });
  });

  it('sums distinct ids (a multi-step turn bills every API round trip)', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(
      msg('msg_1', {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
      }),
    );
    acc.observeAssistant(
      msg('msg_2', {
        input_tokens: 7,
        output_tokens: 30,
        cache_read_input_tokens: 1050,
        cache_creation_input_tokens: 0,
      }),
    );
    expect(acc.drain()).toEqual({
      model: MODEL,
      inputTokens: 107,
      outputTokens: 40,
      cacheReadTokens: 2050,
      cacheWriteTokens: 50,
    });
  });

  it('treats missing and null fields as 0', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(
      msg('msg_1', {
        input_tokens: 12,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: undefined,
      }),
    );
    expect(acc.drain()).toEqual({
      model: MODEL,
      inputTokens: 12,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('ignores garbage field values instead of poisoning the sum', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(
      msg('msg_1', {
        input_tokens: Number.NaN,
        output_tokens: -4,
        cache_read_input_tokens: Number.POSITIVE_INFINITY,
        cache_creation_input_tokens: 9,
      }),
    );
    expect(acc.drain()).toEqual({
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 9,
    });
  });

  it('counts a message with no id as its own entry (never merged with another)', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(msg(undefined, { input_tokens: 10, output_tokens: 1 }));
    acc.observeAssistant(msg(undefined, { input_tokens: 10, output_tokens: 1 }));
    expect(acc.drain()).toMatchObject({ inputTokens: 20, outputTokens: 2 });
  });

  it('does not merge an empty-string id with another empty-string id', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(msg('', { input_tokens: 5, output_tokens: 5 }));
    acc.observeAssistant(msg('', { input_tokens: 5, output_tokens: 5 }));
    expect(acc.drain()).toMatchObject({ inputTokens: 10, outputTokens: 10 });
  });

  it('includes sub-agent messages (parent_tool_use_id set): they cost money too', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(msg('msg_main', { input_tokens: 100, output_tokens: 10 }));
    acc.observeAssistant(
      msg('msg_sub', { input_tokens: 400, output_tokens: 60 }, { parent_tool_use_id: 'toolu_1' }),
    );
    expect(acc.drain()).toMatchObject({ inputTokens: 500, outputTokens: 70 });
  });

  it('skips a message with no usage object at all (nothing to count)', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(msg('msg_1', undefined));
    // Nothing usable was observed, so the loop reports "cannot tell" (null),
    // which the host charges a flat assumed cost, rather than a free zero.
    expect(acc.drain()).toBeNull();
  });

  it('drain() resets: the next turn starts from zero and does not inherit ids', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant(msg('msg_1', { input_tokens: 100, output_tokens: 10 }));
    expect(acc.drain()).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(acc.drain()).toBeNull();
    // Same id in the next turn is a NEW response and must count again.
    acc.observeAssistant(msg('msg_1', { input_tokens: 3, output_tokens: 4 }));
    expect(acc.drain()).toMatchObject({ inputTokens: 3, outputTokens: 4 });
  });

  it('tolerates a message with no `message` payload', () => {
    const acc = createTurnUsageAccumulator(MODEL);
    acc.observeAssistant({} as never);
    acc.observeAssistant({ message: null } as never);
    expect(acc.drain()).toBeNull();
  });
});
