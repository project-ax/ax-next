import { describe, it, expect, vi } from 'vitest';
import { judgeAnswer, type JudgeClient } from '../judge.js';

describe('judgeAnswer', () => {
  it('parses correct/incorrect/uncertain verdicts from the model response', async () => {
    const stub: JudgeClient = {
      complete: vi.fn()
        .mockResolvedValueOnce({ text: 'VERDICT: correct\nREASON: matches gold.', usage: { in: 50, out: 10 } })
        .mockResolvedValueOnce({ text: 'VERDICT: incorrect\nREASON: wrong number.', usage: { in: 50, out: 10 } })
        .mockResolvedValueOnce({ text: 'VERDICT: uncertain\nREASON: ambiguous.', usage: { in: 50, out: 10 } }),
    };
    const a = await judgeAnswer(stub, 'q?', 'gold', 'gold');
    const b = await judgeAnswer(stub, 'q?', 'gold', 'wrong');
    const c = await judgeAnswer(stub, 'q?', 'gold', 'maybe');
    expect(a.verdict).toBe('correct');
    expect(b.verdict).toBe('incorrect');
    expect(c.verdict).toBe('uncertain');
  });

  it('defaults to uncertain when the verdict line is malformed', async () => {
    const stub: JudgeClient = {
      complete: vi.fn().mockResolvedValue({ text: 'gibberish', usage: { in: 50, out: 5 } }),
    };
    const r = await judgeAnswer(stub, 'q?', 'gold', 'answer');
    expect(r.verdict).toBe('uncertain');
  });
});
