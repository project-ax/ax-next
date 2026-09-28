import { describe, expect, it } from 'vitest';
import { renderEvidenceTable } from '../../packages/memory/dist/index.js';
import { LINK_LEGEND, annotateEvidence, mcnemarExact, pairOutcomes, statementKey } from '../memory-fact-links-lib.mjs';

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
