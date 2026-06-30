import { describe, it, expect } from 'vitest';
import {
  transformLongMemEvalSample,
  isUnanswerable,
  loadLongMemEvalSSamples,
  type LongMemEvalSample,
} from '../corpora/longmemeval-s.js';
import { BenchCache } from '../cache.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('LongMemEval-S transform', () => {
  it('emits one doc per haystack session with parallel session ids', () => {
    const sample = {
      question_id: 'q1',
      question_type: 'single-session-user',
      question: 'What did the user say about coffee?',
      answer: 'They like cortados.',
      answer_session_ids: ['sess-0'],
      haystack_session_ids: ['sess-0', 'sess-1'],
      haystack_sessions: [
        [
          { role: 'user' as const, content: 'I love cortados.' },
          { role: 'assistant' as const, content: 'Noted.' },
        ],
        [
          { role: 'user' as const, content: 'Unrelated chatter.' },
        ],
      ],
    };
    const out = transformLongMemEvalSample(sample);
    expect(out.question).toMatchObject({
      id: 'q1',
      text: expect.stringContaining('coffee'),
      goldAnswer: 'They like cortados.',
      goldDocIds: ['episodes/sess-0'],
      metadata: { question_type: 'single-session-user' },
    });
    expect(out.docs.size).toBe(2);
    const gold = out.docs.get('episodes/sess-0');
    expect(gold).toBeDefined();
    expect(gold!.body).toMatch(/cortado/);
    expect(gold!.category).toBe('episodes');
    expect(gold!.slug).toBe('sess-0');
    const distractor = out.docs.get('episodes/sess-1');
    expect(distractor).toBeDefined();
    expect(distractor!.body).toMatch(/Unrelated/);
  });

  it('tolerates missing answer_session_ids by producing empty goldDocIds', () => {
    const sample = {
      question_id: 'q2',
      question: 'anything?',
      answer: 'something',
      haystack_session_ids: ['s0'],
      haystack_sessions: [[{ role: 'user' as const, content: 'hi' }]],
    };
    const out = transformLongMemEvalSample(sample);
    expect(out.question.goldDocIds).toEqual([]);
  });

  it('flags _abs question_id as metadata.unanswerable', () => {
    const sample = {
      question_id: 'abc123_abs',
      question_type: 'single-session-user',
      question: 'What did I name my hamster?',
      answer: 'You did not mention this information. You mentioned your cat Luna but not your hamster.',
      haystack_session_ids: ['s1'],
      haystack_sessions: [[{ role: 'user', content: 'I love my cat Luna' } as const]],
      answer_session_ids: ['s1'],
    };
    const { question } = transformLongMemEvalSample(sample);
    expect(question.metadata?.unanswerable).toBe(true);
  });

  it('leaves answerable questions without an unanswerable flag', () => {
    const sample = {
      question_id: 'abc123',
      question_type: 'single-session-user',
      question: 'What degree did I graduate with?',
      answer: 'Business Administration',
      haystack_session_ids: ['s1'],
      haystack_sessions: [[{ role: 'user', content: 'I graduated with a BBA' } as const]],
      answer_session_ids: ['s1'],
    };
    const { question } = transformLongMemEvalSample(sample);
    expect(question.metadata?.unanswerable).toBeUndefined();
  });
});

describe('LongMemEval-S e2e raw-sample loader (TASK-189)', () => {
  it('isUnanswerable flags the _abs split', () => {
    expect(isUnanswerable('abc123_abs')).toBe(true);
    expect(isUnanswerable('abc123')).toBe(false);
    expect(isUnanswerable('')).toBe(false);
  });

  it('loads RAW samples with haystack sessions intact from the cache (no network)', async () => {
    // Seed a cache hit so the loader never hits the network.
    const root = mkdtempSync(join(tmpdir(), 'lme-e2e-cache-'));
    try {
      const cache = new BenchCache(root);
      const samples: LongMemEvalSample[] = [
        {
          question_id: 'q1_abs',
          question_type: 'single-session-user',
          question: 'What is my hamster named?',
          answer: 'You did not mention this information.',
          haystack_session_ids: ['s0', 's1'],
          haystack_sessions: [
            [
              { role: 'user', content: 'I love my cat Luna.' },
              { role: 'assistant', content: 'Lovely!' },
            ],
            [{ role: 'user', content: 'Unrelated chatter.' }],
          ],
        },
      ];
      await cache.write(
        'longmemeval-s',
        'longmemeval_s_cleaned.json',
        Buffer.from(JSON.stringify(samples)),
      );
      const loaded = await loadLongMemEvalSSamples(cache);
      expect(loaded).toHaveLength(1);
      const s = loaded[0]!;
      // Raw multi-turn sessions survive — NOT collapsed into a single doc body.
      expect(s.haystack_sessions).toHaveLength(2);
      expect(s.haystack_sessions[0]).toHaveLength(2);
      expect(s.haystack_sessions[0]![0]).toEqual({
        role: 'user',
        content: 'I love my cat Luna.',
      });
      expect(isUnanswerable(s.question_id)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { transformLoCoMoSample } from '../corpora/locomo.js';

describe('LoCoMo transform', () => {
  it('emits one doc per session and resolves evidence dia_ids to session paths', () => {
    const sample = {
      sample_id: 'conv-26',
      conversation: {
        session_1_date_time: '2:00pm on 1 May, 2023',
        session_1: [
          { speaker: 'Alice', dia_id: 'D1:1', text: 'My birthday is March 5.' },
          { speaker: 'Bob', dia_id: 'D1:2', text: 'Got it.' },
        ],
        session_2_date_time: '3:00pm on 2 May, 2023',
        session_2: [
          { speaker: 'Alice', dia_id: 'D2:1', text: 'I love hiking.' },
        ],
      },
      qa: [
        {
          question: "What is Alice's birthday?",
          answer: 'March 5',
          evidence: ['D1:1'],
          category: 1,
        },
        {
          question: 'When was each session?',
          answer: 'session 1 and session 2',
          evidence: ['D1:2', 'D2:1'],
          category: 3,
        },
      ],
    };
    const out = transformLoCoMoSample(sample);
    expect(out.docs.size).toBe(2);
    expect(out.docs.get('episodes/conv-26-s1')).toBeDefined();
    expect(out.docs.get('episodes/conv-26-s2')).toBeDefined();
    expect(out.docs.get('episodes/conv-26-s1')!.body).toMatch(/birthday is March 5/);
    expect(out.questions).toHaveLength(2);
    expect(out.questions[0]).toMatchObject({
      id: 'conv-26-q0',
      text: expect.stringContaining('birthday'),
      goldAnswer: 'March 5',
      goldDocIds: ['episodes/conv-26-s1'],
      metadata: { category: 1 },
    });
    expect(new Set(out.questions[1]!.goldDocIds)).toEqual(
      new Set(['episodes/conv-26-s1', 'episodes/conv-26-s2']),
    );
  });

  it('coerces numeric answer fields to string', () => {
    const sample = {
      sample_id: 'conv-x',
      conversation: {
        session_1: [{ speaker: 'A', text: 'painted in 2022' }],
      },
      qa: [{ question: 'When?', answer: 2022, evidence: [] }],
    };
    const out = transformLoCoMoSample(sample);
    expect(out.questions[0]!.goldAnswer).toBe('2022');
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
