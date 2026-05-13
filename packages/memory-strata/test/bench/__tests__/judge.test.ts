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

  it('returns abstained-correctly when question is unanswerable and answer is "I don\'t know"', async () => {
    const stub: JudgeClient = {
      async complete() {
        return { text: 'VERDICT: abstained-correctly\nREASON: agent abstained on unanswerable q', usage: { in: 5, out: 5 } };
      },
    };
    const r = await judgeAnswer(stub, 'q', 'You did not mention this information.', "I don't know.", { unanswerable: true });
    expect(r.verdict).toBe('abstained-correctly');
  });

  it('returns abstained-incorrectly when question is answerable but agent abstains', async () => {
    const stub: JudgeClient = {
      async complete() {
        return { text: 'VERDICT: abstained-incorrectly\nREASON: agent declined answerable q', usage: { in: 5, out: 5 } };
      },
    };
    const r = await judgeAnswer(stub, 'q', 'Business Administration', "I don't know.", { unanswerable: false });
    expect(r.verdict).toBe('abstained-incorrectly');
  });

  it('still parses correct/incorrect/uncertain (back-compat)', async () => {
    const stub: JudgeClient = {
      async complete() {
        return { text: 'VERDICT: correct\nREASON: ok', usage: { in: 5, out: 5 } };
      },
    };
    const r = await judgeAnswer(stub, 'q', 'a', 'a', { unanswerable: false });
    expect(r.verdict).toBe('correct');
  });

  it('passes unanswerable signal to the judge prompt', async () => {
    let capturedUser: string | null = null;
    const stub: JudgeClient = {
      async complete({ user }) {
        capturedUser = user;
        return { text: 'VERDICT: uncertain\nREASON: x', usage: { in: 1, out: 1 } };
      },
    };
    await judgeAnswer(stub, 'q', 'gold', 'a', { unanswerable: true });
    expect(capturedUser).toContain('Unanswerable: true');
  });
});
