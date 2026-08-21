import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { planSummarization } from '../../../src/compaction/summarize.js';
import { buildConversation, questionMessage } from '../corpus.js';
import { runConversation } from '../driver.js';
import { parseVerdict, JUDGE_INSTRUCTIONS } from '../judge.js';
import { DEFAULT_GATES, checkGates, renderReport, score } from '../report.js';
import { requireKeys } from '../env.js';

// ---------------------------------------------------------------------------
// The bench's own tests — the part of the eval CI can run.
//
// The eval itself needs a real model and a real key, so it lives behind `pnpm
// bench`. What is testable without one is everything AROUND the model, and
// those parts are where a bench usually goes quietly wrong: a corpus that
// plants its facts where they survive for free, a judge parser that scores its
// own confusion as a failure, a gate that changes meaning when an arm is
// missing.
//
// A bench nobody checks reports whatever it reports.
// ---------------------------------------------------------------------------

const SMALL = { exchanges: 20, toolOutputChars: 200, facts: 4 };

describe('the corpus', () => {
  it('plants every answerable fact in the region that gets summarized', () => {
    // The whole eval rests on this. A fact in the preserved head or tail is
    // recalled by the anchors, not by the summary, and would inflate the score
    // for free.
    const conversation = buildConversation(SMALL);
    const plan = planSummarization(conversation.messages)!;
    const preserved = JSON.stringify([...plan.head, ...plan.tail]);
    const middle = JSON.stringify(plan.middle);

    const answerable = conversation.needles.filter((n) => !n.unanswerable);
    expect(answerable.length).toBe(SMALL.facts);
    for (const needle of answerable) {
      expect(needle.marker).toBeDefined();
      expect(middle).toContain(needle.marker!);
      expect(preserved).not.toContain(needle.marker!);
    }
  });

  it('spreads the facts out instead of clustering them', () => {
    // "Kept the first thing and dropped the rest" and "kept a random third" are
    // different failures, and only spread facts distinguish them.
    const conversation = buildConversation({ ...SMALL, facts: 4 });
    const depths = conversation.needles
      .filter((n) => !n.unanswerable)
      .map((n) => n.depth!);

    expect(depths).toHaveLength(4);
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]!).toBeGreaterThan(depths[i - 1]!);
    }
    // The last one is not crammed up against the first.
    expect(depths.at(-1)! - depths[0]!).toBeGreaterThan(depths.length * 4);
  });

  it('states each fact exactly once', () => {
    // Repetition is how a summary keeps something by accident.
    const conversation = buildConversation(SMALL);
    const serialized = JSON.stringify(conversation.messages);
    for (const needle of conversation.needles.filter((n) => !n.unanswerable)) {
      expect(serialized.split(needle.marker!).length - 1).toBe(1);
    }
  });

  it('includes unanswerable questions as the confabulation control', () => {
    const conversation = buildConversation(SMALL);
    const absent = conversation.needles.filter((n) => n.unanswerable);
    expect(absent.length).toBeGreaterThan(0);
    // ...and they really are absent from the conversation.
    const serialized = JSON.stringify(conversation.messages).toLowerCase();
    expect(serialized).not.toContain('mobile app');
    expect(serialized).not.toContain('cache cluster');
  });

  it('lets the model abstain instead of forcing an answer', () => {
    // Without this the abstention arm measures nothing: a question phrased as a
    // demand gets a guess from any model.
    expect(JSON.stringify(questionMessage('where is it?'))).toContain(
      "say \\\"I don't know\\\"",
    );
  });

  it('grows with the knobs the CLI exposes', () => {
    const small = buildConversation(SMALL);
    const big = buildConversation({ ...SMALL, exchanges: 60 });
    expect(big.messages.length).toBeGreaterThan(small.messages.length * 2);
    const wide = buildConversation({ ...SMALL, toolOutputChars: 4_000 });
    expect(JSON.stringify(wide.messages).length).toBeGreaterThan(
      JSON.stringify(small.messages).length * 2,
    );
  });
});

describe('the judge parser', () => {
  it('reads a well-formed verdict', () => {
    expect(
      parseVerdict('VERDICT: correct\nREASON: names the same host and port'),
    ).toEqual({ verdict: 'correct', reason: 'names the same host and port' });
  });

  it('reads every verdict the instructions promise', () => {
    for (const v of [
      'correct',
      'incorrect',
      'abstained-correctly',
      'abstained-incorrectly',
      'uncertain',
    ]) {
      expect(JUDGE_INSTRUCTIONS).toContain(v);
      expect(parseVerdict(`VERDICT: ${v}\nREASON: x`).verdict).toBe(v);
    }
  });

  it('scores its own confusion as uncertain, never as a failure', () => {
    // Charging judge flakiness to the thing being judged is how a bench stops
    // being trusted.
    expect(parseVerdict('I think it is probably fine?').verdict).toBe('uncertain');
    expect(parseVerdict('').verdict).toBe('uncertain');
  });
});

describe('scoring', () => {
  const conv = (results: Array<[string, string, string]>) => [
    {
      conversation: 'c1',
      tokensBefore: 1000,
      tokensAfter: 250,
      messagesBefore: 40,
      messagesAfter: 10,
      summary: 'a summary',
      results: results.map(([arm, needleId, verdict]) => ({
        conversation: 'c1',
        arm: arm as 'compacted' | 'verbatim',
        needleId,
        question: 'q',
        answer: 'a',
        verdict: verdict as never,
        reason: 'r',
      })),
    },
  ];

  it('charges compaction only for what verbatim got right', () => {
    // fact-1 is wrong in BOTH arms — the model cannot answer it from the full
    // conversation either, so it is the filler's difficulty, not compaction's.
    const s = score(
      conv([
        ['verbatim', 'fact-0', 'correct'],
        ['verbatim', 'fact-1', 'incorrect'],
        ['compacted', 'fact-0', 'correct'],
        ['compacted', 'fact-1', 'incorrect'],
      ]),
    );
    expect(s.recallLoss).toBe(0);
  });

  it('counts a fact verbatim recalled and compacted lost', () => {
    const s = score(
      conv([
        ['verbatim', 'fact-0', 'correct'],
        ['verbatim', 'fact-1', 'correct'],
        ['compacted', 'fact-0', 'correct'],
        ['compacted', 'fact-1', 'abstained-incorrectly'],
      ]),
    );
    expect(s.recallLoss).toBe(0.5);
    expect(s.byArm.compacted.lost).toBe(1);
  });

  it('separates a lost fact from an invented one', () => {
    // They call for opposite fixes, so one number cannot carry both.
    const s = score(
      conv([
        ['compacted', 'fact-0', 'abstained-incorrectly'],
        ['compacted', 'fact-1', 'incorrect'],
      ]),
    );
    expect(s.byArm.compacted.lost).toBe(1);
    expect(s.byArm.compacted.confabulated).toBe(1);
    expect(s.confabulationRate).toBe(0.5);
  });

  it('scores the unanswerable needles as abstention, not as recall', () => {
    const s = score(
      conv([
        ['compacted', 'absent-0', 'abstained-correctly'],
        ['compacted', 'absent-1', 'incorrect'],
        ['compacted', 'fact-0', 'correct'],
      ]),
    );
    expect(s.byArm.compacted.answerable).toBe(1);
    expect(s.byArm.compacted.unanswerable).toBe(2);
    expect(s.abstentionRate).toBe(0.5);
  });

  it('reports how much was reclaimed', () => {
    expect(score(conv([])).tokenReduction).toBeCloseTo(0.75);
  });
});

describe('the gates', () => {
  const base = score([
    {
      conversation: 'c1',
      tokensBefore: 100,
      tokensAfter: 50,
      messagesBefore: 10,
      messagesAfter: 4,
      summary: '',
      results: [],
    },
  ]);

  it('fails rather than passes when the control arm did not run', () => {
    // A gate that silently changes meaning is worse than no gate. With no
    // verbatim arm there is no delta to check, so this must not quietly fall
    // back to an absolute score.
    expect(base.recallLoss).toBeNull();
    const gate = checkGates(base);
    expect(gate.passed).toBe(false);
    expect(gate.failures[0]).toContain('verbatim control arm did not run');
  });

  it('passes a run inside every threshold', () => {
    const gate = checkGates({
      ...base,
      recallLoss: 0.1,
      confabulationRate: 0,
      abstentionRate: 1,
    });
    expect(gate).toEqual({ passed: true, failures: [] });
  });

  it('names each threshold it failed, not just the first', () => {
    const gate = checkGates({
      ...base,
      recallLoss: 0.9,
      confabulationRate: 0.5,
      abstentionRate: 0,
    });
    expect(gate.passed).toBe(false);
    expect(gate.failures).toHaveLength(3);
  });

  it('holds confabulation to a stricter bar than loss', () => {
    // A confidently wrong answer is worse for the user than a missing one.
    expect(DEFAULT_GATES.maxConfabulation).toBeLessThan(DEFAULT_GATES.maxRecallLoss);
  });
});

describe('the report', () => {
  it('never hides a skipped conversation', () => {
    // A conversation rung 3 declined is not a conversation that passed.
    const rendered = renderReport({
      results: [
        {
          conversation: 'c1',
          tokensBefore: 10,
          tokensAfter: 10,
          messagesBefore: 4,
          messagesAfter: 4,
          summary: '',
          results: [],
          skipped: 'rung 3 failed: summary-not-smaller',
        },
      ],
      score: score([
        {
          conversation: 'c1',
          tokensBefore: 10,
          tokensAfter: 10,
          messagesBefore: 4,
          messagesAfter: 4,
          summary: '',
          results: [],
          skipped: 'rung 3 failed: summary-not-smaller',
        },
      ]),
      model: 'm',
      judgeModel: 'j',
      runDate: '2026-08-21',
    });
    expect(rendered).toContain('## Skipped');
    expect(rendered).toContain('summary-not-smaller');
    expect(rendered).toContain('GATE: FAIL');
  });

  it('prints the summary the model actually produced', () => {
    // The most useful thing in the report when a number moves.
    const results = [
      {
        conversation: 'c1',
        tokensBefore: 100,
        tokensAfter: 20,
        messagesBefore: 40,
        messagesAfter: 5,
        summary: 'the staging db is db-staging-7.internal:5433',
        results: [],
      },
    ];
    const rendered = renderReport({
      results,
      score: score(results),
      model: 'm',
      judgeModel: 'j',
      runDate: '2026-08-21',
    });
    expect(rendered).toContain('db-staging-7.internal:5433');
    expect(rendered).toContain('40→5 messages');
  });
});

// ---- the driver, with the model faked out ---------------------------------

describe('the driver', () => {
  /** A summarizer that echoes the facts, and an asker that greps its context. */
  function fakeModels(recall: (question: string) => string) {
    return {
      agent: vi.fn(async () => 'summary: the staging database is db-staging-7.internal on port 5433'),
      judge: vi.fn(async () => 'VERDICT: correct\nREASON: matches'),
      ask: vi.fn(async (messages: ModelMessage[]) => {
        const last = messages.at(-1)!;
        const text = JSON.stringify(last.content);
        return recall(text);
      }),
    };
  }

  it('runs both arms against the same needles', async () => {
    const conversation = buildConversation(SMALL);
    const { agent, judge, ask } = fakeModels(() => 'db-staging-7.internal:5433');

    const result = await runConversation({ conversation, agent, judge, ask, log: () => {} });

    expect(result.skipped).toBeUndefined();
    const arms = new Set(result.results.map((r) => r.arm));
    expect([...arms].sort()).toEqual(['compacted', 'verbatim']);
    expect(result.results).toHaveLength(conversation.needles.length * 2);
    // The summarizer ran ONCE and both arms reused its output — a second call
    // would be measuring two different summaries.
    expect(agent).toHaveBeenCalledTimes(1);
  });

  it('shrinks the conversation and reports by how much', async () => {
    const conversation = buildConversation(SMALL);
    const { agent, judge, ask } = fakeModels(() => 'yes');
    const result = await runConversation({ conversation, agent, judge, ask, log: () => {} });

    expect(result.messagesAfter).toBeLessThan(result.messagesBefore);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it('records a failed summarizer as a skip instead of throwing', async () => {
    const conversation = buildConversation(SMALL);
    const result = await runConversation({
      conversation,
      agent: async () => {
        throw new Error('provider exploded');
      },
      judge: async () => 'VERDICT: correct\nREASON: x',
      ask: async () => 'x',
      log: () => {},
    });

    expect(result.skipped).toContain('model-call-failed');
    expect(result.results).toHaveLength(0);
  });

  it('refuses to score a corpus whose facts leaked into the preserved region', async () => {
    // The fairness check. Rigged is worse than broken: a broken bench gets
    // fixed, a rigged one gets cited.
    const conversation = buildConversation(SMALL);
    conversation.needles.push({
      id: 'leaked',
      // The head anchor's own text, so it is guaranteed to be preserved.
      question: 'what is the task?',
      gold: 'the billing refactor, /nonsense/path',
      marker: '/nonsense/path',
      unanswerable: false,
    });
    conversation.messages[0] = {
      role: 'user',
      content: [{ type: 'text', text: 'finish the billing refactor at /nonsense/path' }],
    };

    await expect(
      runConversation({
        conversation,
        agent: async () => 'summary',
        judge: async () => 'VERDICT: correct\nREASON: x',
        ask: async () => 'x',
        log: () => {},
      }),
    ).rejects.toThrow(/PRESERVED region/);
  });
});

describe('requireKeys', () => {
  it('names every missing key at once', () => {
    expect(() => requireKeys({ A: undefined, B: '', C: 'set' })).toThrow(/A, B/);
  });

  it('passes through a complete set', () => {
    expect(requireKeys({ A: 'x' })).toEqual({ A: 'x' });
  });
});
