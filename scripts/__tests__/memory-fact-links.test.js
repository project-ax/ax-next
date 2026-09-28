import { describe, expect, it } from 'vitest';
import { renderEvidenceTable } from '../../packages/memory/dist/index.js';
import { LINK_LEGEND, annotateEvidence, answerForked, mcnemarExact, pairOutcomes, statementKey } from '../memory-fact-links-lib.mjs';

const row = (id, relation, value, when) => ({ id, about: 'user:owner', aboutText: 'you', relation, value, when, kind: 'experience' });
const toolText = (rows) => ['Today is 2023-03-16 (Thursday).', 'Ground all claims in the evidence table.', '', 'Evidence table:', renderEvidenceTable(rows, '2023-03-16T00:00:00.000Z')].join('\n');
const oldEggs = { relation: 'egg_stock', value: 'User has 30 dozen eggs | stocked', when: '2023-01-11T12:00:00.000Z' };
const newEggs = { relation: 'has_egg_stock', value: '20 dozen fresh eggs', when: '2023-03-15T12:00:00.000Z' };

describe('annotateEvidence', () => {
  it('matches the product renderer exactly, including escaped pipes', () => {
    const text = toolText([row('1', oldEggs.relation, oldEggs.value, oldEggs.when)]);
    expect(text).toContain(statementKey(oldEggs.relation, oldEggs.value));
  });

  it('notes both ends of an update and names the other end even when it was not recalled', () => {
    const text = toolText([row('1', oldEggs.relation, oldEggs.value, oldEggs.when)]);
    const out = annotateEvidence(text, [{ link: 'updates', a: oldEggs, b: newEggs }]);
    expect(out.notes).toBe(1);
    expect(out.text).toContain('⟨later updated (2023-03-15): has egg stock: 20 dozen fresh eggs⟩ |');
    expect(out.text.indexOf(LINK_LEGEND)).toBeLessThan(out.text.indexOf('Evidence table:'));
  });

  it('marks the newer row as replacing, and same-event rows both ways', () => {
    const text = toolText([row('1', oldEggs.relation, oldEggs.value, oldEggs.when), row('2', newEggs.relation, newEggs.value, newEggs.when)]);
    expect(annotateEvidence(text, [{ link: 'updates', a: oldEggs, b: newEggs }]).text).toContain('⟨replaces earlier (2023-01-11)');
    const same = annotateEvidence(text, [{ link: 'same_event', a: oldEggs, b: newEggs }]);
    expect(same.notes).toBe(2);
    expect(same.text.match(/same event as/g)).toHaveLength(3); // two notes + the legend
  });

  it('leaves a result with no linked row byte-identical, with no legend', () => {
    const text = toolText([row('1', 'likes', 'tea', '2023-01-01T12:00:00.000Z')]);
    expect(annotateEvidence(text, [{ link: 'updates', a: oldEggs, b: newEggs }])).toEqual({ text, notes: 0 });
  });

  it('keeps the row a four-cell table row', () => {
    const text = toolText([row('1', oldEggs.relation, oldEggs.value, oldEggs.when)]);
    const line = annotateEvidence(text, [{ link: 'updates', a: oldEggs, b: newEggs }]).text.split('\n').find((l) => l.startsWith('| [') && l.includes('later updated'));
    expect(line.split(' | ')).toHaveLength(4);
  });
});

describe('paired statistics', () => {
  it('computes an exact two-sided McNemar p', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(6, 0)).toBeCloseTo(0.03125, 10);
    expect(mcnemarExact(3, 3)).toBe(1);
  });

  it('pairs off and on rows by question', () => {
    const rows = [
      { model: 'm', condition: 'off', questionId: 'a', verdict: 'incorrect' }, { model: 'm', condition: 'on', questionId: 'a', verdict: 'correct' },
      { model: 'm', condition: 'off', questionId: 'b', verdict: 'correct' }, { model: 'm', condition: 'on', questionId: 'b', verdict: 'incorrect' },
      { model: 'm', condition: 'off', questionId: 'c', verdict: 'abstained-correctly' }, { model: 'm', condition: 'on', questionId: 'c', verdict: 'correct' },
    ];
    expect(pairOutcomes(rows, 'm')).toEqual({ pairs: 3, bothRight: 1, bothWrong: 0, gained: ['a'], lost: ['b'] });
  });
});

describe('answerForked', () => {
  const config = { id: 'fake/model', effort: 'minimal', maxTokens: 64 };
  const descriptor = { name: 'memory_recall', description: 'd', inputSchema: {} };
  const call = (id, q) => ({ id, type: 'function', function: { name: 'memory_recall', arguments: JSON.stringify({ query: q }) } });
  // A scripted model: round 1 asks one tool call, round 2 answers with whatever the last tool text said.
  const scripted = () => async (body) => {
    const last = body.messages[body.messages.length - 1];
    if (last.role === 'user') return { choices: [{ message: { content: '', tool_calls: [call('t1', 'eggs')] } }] };
    return { choices: [{ message: { content: `saw: ${last.content}` } }] };
  };
  const base = { config, maxToolTurns: 6, maxPrice: {}, system: 's', question: 'q', descriptor };

  it('forks at the first noted recall and gives each branch its own tool text', async () => {
    const out = await answerForked({ ...base, request: scripted(), toolResult: async () => ({ plain: 'PLAIN', annotated: 'NOTED', notes: 1 }) });
    expect(out).toMatchObject({ forked: true, forkTurn: 0, off: { answer: 'saw: PLAIN' }, on: { answer: 'saw: NOTED' } });
  });

  it('does not fork when no recall would carry a note, and answers once', async () => {
    let calls = 0;
    const out = await answerForked({ ...base, request: scripted(), toolResult: async () => { calls += 1; return { plain: 'PLAIN', annotated: 'PLAIN', notes: 0 }; } });
    expect(out).toEqual({ forked: false, answer: 'saw: PLAIN' });
    expect(calls).toBe(1);
  });

  it('shares the prefix: rounds before the fork are asked once, not per branch', async () => {
    let requests = 0;
    const model = scripted();
    const counted = async (body) => { requests += 1; return model(body); };
    await answerForked({ ...base, request: counted, toolResult: async () => ({ plain: 'P', annotated: 'N', notes: 2 }) });
    expect(requests).toBe(3); // one shared first round, then one answer round per branch
  });

  it('branches do not share message history after the fork', async () => {
    const seen = [];
    const model = scripted();
    const spy = async (body) => { seen.push(body.messages.map((m) => m.content).join('|')); return model(body); };
    await answerForked({ ...base, request: spy, toolResult: async () => ({ plain: 'P', annotated: 'N', notes: 1 }) });
    const [offRound, onRound] = seen.slice(1);
    expect(offRound.endsWith('|P')).toBe(true);
    expect(onRound.endsWith('|N')).toBe(true);
    expect(onRound).not.toContain('|P');
  });
});
