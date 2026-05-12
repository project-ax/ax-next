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

import { transformLoCoMoSample } from '../corpora/locomo.js';

describe('LoCoMo transform', () => {
  it('emits a Strata-shaped memory tree from a sample row', () => {
    const sample = {
      sample_id: 'lc-1',
      conversation: [
        { speaker: 'Alice', text: 'My birthday is March 5.' },
        { speaker: 'Bob', text: 'Got it.' },
      ],
      qa: [{ question: "What is Alice's birthday?", answer: 'March 5' }],
    };
    const out = transformLoCoMoSample(sample);
    expect(out.docs.size).toBeGreaterThan(0);
    expect(out.questions[0]!.text).toContain('birthday');
    expect(out.questions[0]!.goldAnswer).toBe('March 5');
  });
});

import { loadInternalCorpusFromJson } from '../corpora/internal.js';

describe('internal corpus loader', () => {
  it('reads the committed internal-corpus.json into a BenchCorpus', () => {
    const json = JSON.stringify({
      docs: [
        {
          path: 'knowledge/architecture/plugin-bus',
          category: 'knowledge',
          slug: 'plugin-bus',
          summary: 'How the hook bus works',
          factType: 'knowledge',
          headers: '## Overview',
          body: '# Plugin bus\n## Overview\nplugins talk through the bus.',
        },
      ],
      questions: [
        {
          id: 'q1',
          text: 'How do plugins communicate?',
          goldAnswer: 'Through the hook bus.',
          goldDocIds: ['knowledge/architecture/plugin-bus'],
        },
      ],
    });
    const corpus = loadInternalCorpusFromJson(json);
    expect(corpus.name).toBe('internal');
    expect(corpus.memoryTree.size).toBe(1);
    expect(corpus.questions[0]!.id).toBe('q1');
  });
});
