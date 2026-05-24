import { describe, it, expect } from 'vitest';
import { LlmCallOutputSchema } from '../llm.js';
import type { LlmCallOutput } from '../types.js';

// ARCH-13 drift guard for the `llm:call:anthropic` returns schema. The shape
// lives in @ax/core because `LlmCallOutput` does. A fully-populated value must
// round-trip without losing a field.

describe('LlmCallOutputSchema', () => {
  it('round-trips a fully-populated LlmCallOutput', () => {
    const full: LlmCallOutput = {
      text: 'hello',
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 34 },
    };
    expect(LlmCallOutputSchema.parse(full)).toEqual(full);
  });

  it('accepts every normalized stopReason', () => {
    for (const stopReason of ['end_turn', 'max_tokens', 'tool_use', 'stop_sequence', 'unknown'] as const) {
      expect(
        LlmCallOutputSchema.safeParse({
          text: '',
          stopReason,
          usage: { inputTokens: 0, outputTokens: 0 },
        }).success,
      ).toBe(true);
    }
  });

  it('rejects an out-of-union stopReason (e.g. a raw provider value)', () => {
    expect(
      LlmCallOutputSchema.safeParse({
        text: 'x',
        stopReason: 'pause_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }).success,
    ).toBe(false);
  });

  it('rejects a missing usage field', () => {
    expect(LlmCallOutputSchema.safeParse({ text: 'x', stopReason: 'unknown' }).success).toBe(false);
  });

  it('rejects a non-number token count', () => {
    expect(
      LlmCallOutputSchema.safeParse({
        text: 'x',
        stopReason: 'unknown',
        usage: { inputTokens: '1', outputTokens: 1 },
      }).success,
    ).toBe(false);
  });
});
