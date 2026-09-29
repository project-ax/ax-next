import { describe, it, expect } from 'vitest';
import { costMicros } from '../pricing.js';

const M = 1_000_000;

describe('costMicros', () => {
  it('prices opus at {15, 75} per million in/out', () => {
    expect(costMicros('anthropic/claude-opus-4-1', { inputTokens: M, outputTokens: 0 })).toBe(15 * M);
    expect(costMicros('anthropic/claude-opus-4-1', { inputTokens: 0, outputTokens: M })).toBe(75 * M);
  });

  it('prices sonnet at {3, 15} and matches provider-prefixed refs', () => {
    expect(costMicros('anthropic/claude-sonnet-4-6', { inputTokens: M, outputTokens: M })).toBe(18 * M);
    expect(
      costMicros('openrouter/anthropic/claude-sonnet-4.5', { inputTokens: M, outputTokens: M }),
    ).toBe(18 * M);
    expect(costMicros('Anthropic/Claude-SONNET-4', { inputTokens: M, outputTokens: 0 })).toBe(3 * M);
  });

  it('prices haiku at {1, 5}', () => {
    expect(costMicros('anthropic/claude-haiku-4-5', { inputTokens: M, outputTokens: M })).toBe(6 * M);
  });

  it('prices cache tokens at the cache rates', () => {
    const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: M, cacheWriteTokens: M };
    expect(costMicros('anthropic/claude-opus-4', u)).toBe(1.5 * M + 18.75 * M);
    expect(costMicros('anthropic/claude-sonnet-4', u)).toBe(0.3 * M + 3.75 * M);
    expect(costMicros('anthropic/claude-haiku-4', u)).toBe(0.1 * M + 1.25 * M);
  });

  it('prices an unknown or missing model at the opus (top-tier) rate', () => {
    const u = { inputTokens: M, outputTokens: M };
    const opus = costMicros('anthropic/claude-opus-4', u);
    expect(costMicros(undefined, u)).toBe(opus);
    expect(costMicros('openai/gpt-5', u)).toBe(opus);
    expect(costMicros('', u)).toBe(opus);
    // A family word without "claude" is not trusted to be cheap.
    expect(costMicros('someone/sonnet-knockoff', u)).toBe(opus);
  });

  it('treats negative, NaN and non-finite counts as zero', () => {
    const bad = {
      inputTokens: -5,
      outputTokens: Number.NaN,
      cacheReadTokens: Number.POSITIVE_INFINITY,
      cacheWriteTokens: Number.NEGATIVE_INFINITY,
    };
    expect(costMicros('anthropic/claude-opus-4', bad)).toBe(0);
  });

  it('rounds up to a whole micro-dollar, exactly (no float drift)', () => {
    // 1 haiku cache-read token = 0.1 micro-USD -> 1.
    expect(costMicros('anthropic/claude-haiku-4', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1 })).toBe(1);
    // 10 sonnet cache-read tokens = exactly 3 micro-USD. Naive float math
    // gives 3.0000000000000004 and ceil would say 4.
    expect(costMicros('anthropic/claude-sonnet-4', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 10 })).toBe(3);
    expect(costMicros('anthropic/claude-sonnet-4', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('returns an integer for fractional token counts', () => {
    const c = costMicros('anthropic/claude-sonnet-4', { inputTokens: 1.7, outputTokens: 0 });
    expect(Number.isInteger(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(3);
  });
});
