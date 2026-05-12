import { describe, it, expect } from 'vitest';
import { transformLongMemEvalSample } from '../corpora/longmemeval-s.js';

describe('LongMemEval-S transform', () => {
  it('emits a Strata-shaped memory tree from a sample row', () => {
    const sample = {
      question_id: 'q1',
      question: 'What did the user say about coffee?',
      answer: 'They like cortados.',
      haystack_sessions: [
        {
          session_id: 's0',
          turns: [
            { role: 'user' as const, content: 'I love cortados.' },
            { role: 'assistant' as const, content: 'Noted.' },
          ],
        },
      ],
      relevant_session_ids: ['s0'],
    };
    const out = transformLongMemEvalSample(sample);
    expect(out.question).toMatchObject({
      id: 'q1',
      text: expect.stringContaining('coffee'),
      goldAnswer: 'They like cortados.',
      goldDocIds: ['episodes/s0'],
    });
    const doc = out.docs.get('episodes/s0');
    expect(doc).toBeDefined();
    expect(doc!.body).toMatch(/cortado/);
    expect(doc!.category).toBe('episodes');
    expect(doc!.slug).toBe('s0');
  });
});
