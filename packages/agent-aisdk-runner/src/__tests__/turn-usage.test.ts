import { describe, expect, it } from 'vitest';
import { sumStepUsage } from '../turn-usage.js';

// TASK-692. `ai@7` reports per-step `LanguageModelUsage`: `inputTokens` is the
// TOTAL input (cache reads and writes included); `inputTokenDetails` breaks it
// down; `outputTokens` is the total output INCLUDING reasoning. The wire wants
// disjoint buckets (standard input / cache read / cache write / output), so the
// input side needs care: naive `inputTokens` would bill cached tokens at the
// full rate as well as the cache rate.

const MODEL = 'anthropic/claude-sonnet-4-6';

const step = (usage: {
  inputTokens?: number | undefined;
  inputTokenDetails?:
    | {
        noCacheTokens?: number | undefined;
        cacheReadTokens?: number | undefined;
        cacheWriteTokens?: number | undefined;
      }
    | undefined;
  outputTokens?: number | undefined;
}) => ({ usage });

describe('sumStepUsage', () => {
  it('returns null for undefined or empty steps (nothing to report: the host charges its flat assumption)', () => {
    expect(sumStepUsage(MODEL, undefined)).toBeNull();
    expect(sumStepUsage(MODEL, [])).toBeNull();
  });

  it('uses noCacheTokens as the standard-rate input when the provider reports it', () => {
    const out = sumStepUsage(MODEL, [
      step({
        inputTokens: 1000,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 850, cacheWriteTokens: 50 },
        outputTokens: 30,
      }),
    ]);
    expect(out).toEqual({
      model: MODEL,
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 850,
      cacheWriteTokens: 50,
    });
  });

  it('derives standard input as total - cacheRead - cacheWrite when noCacheTokens is absent', () => {
    const out = sumStepUsage(MODEL, [
      step({
        inputTokens: 1000,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: 850,
          cacheWriteTokens: 50,
        },
        outputTokens: 5,
      }),
    ]);
    expect(out).toMatchObject({ inputTokens: 100, cacheReadTokens: 850, cacheWriteTokens: 50 });
  });

  it('never derives a negative input (cache figures larger than the total)', () => {
    const out = sumStepUsage(MODEL, [
      step({
        inputTokens: 10,
        inputTokenDetails: { cacheReadTokens: 850, cacheWriteTokens: 50 },
        outputTokens: 1,
      }),
    ]);
    expect(out).toMatchObject({ inputTokens: 0, cacheReadTokens: 850, cacheWriteTokens: 50 });
  });

  it('treats a step with no inputTokenDetails as all standard-rate input', () => {
    const out = sumStepUsage(MODEL, [step({ inputTokens: 321, outputTokens: 7 })]);
    expect(out).toEqual({
      model: MODEL,
      inputTokens: 321,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('sums across steps, mixing the reported and derived input forms', () => {
    const out = sumStepUsage(MODEL, [
      step({
        inputTokens: 1000,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 850, cacheWriteTokens: 50 },
        outputTokens: 30,
      }),
      step({
        inputTokens: 1100,
        inputTokenDetails: { cacheReadTokens: 900, cacheWriteTokens: 0 },
        outputTokens: 45,
      }),
      step({ inputTokens: 40, outputTokens: 2 }),
    ]);
    expect(out).toEqual({
      model: MODEL,
      inputTokens: 100 + (1100 - 900) + 40,
      outputTokens: 30 + 45 + 2,
      cacheReadTokens: 850 + 900,
      cacheWriteTokens: 50,
    });
  });

  it('reads outputTokens as the total (reasoning is already inside it, so it is not added twice)', () => {
    const out = sumStepUsage(MODEL, [
      // extra fields ai@7 carries must not be re-added
      {
        usage: {
          inputTokens: 10,
          outputTokens: 100,
          outputTokenDetails: { textTokens: 40, reasoningTokens: 60 },
        },
      } as never,
    ]);
    expect(out).toMatchObject({ outputTokens: 100 });
  });

  it('returns null when no step reported any usage figure (unknown is never free)', () => {
    // A provider that streams no usage yields all-undefined figures. Reporting
    // that as zeros would tell the host the turn was free.
    const out = sumStepUsage(MODEL, [
      step({ inputTokens: undefined, outputTokens: undefined }),
      step({ inputTokenDetails: {} }),
    ]);
    expect(out).toBeNull();
  });

  it('counts a step that reported only output tokens', () => {
    const out = sumStepUsage(MODEL, [step({ outputTokens: 12 })]);
    expect(out).toEqual({
      model: MODEL,
      inputTokens: 0,
      outputTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('ignores garbage numbers instead of poisoning the sum', () => {
    const out = sumStepUsage(MODEL, [
      step({ inputTokens: Number.NaN, outputTokens: -3 }),
      step({ inputTokens: 20, outputTokens: 4 }),
    ]);
    expect(out).toMatchObject({ inputTokens: 20, outputTokens: 4 });
  });
});
