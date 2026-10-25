import { describe, expect, it } from 'vitest';
import { copiedSteps, duplicateName } from '../duplicate.js';
import type { StoredStep } from '../types.js';

// TASK-953: what a person's copy of a task carries, decided in one pure module, so it is tested without Postgres.
// The name is "Copy of " and the source's name, cut to the 128-unit name limit and never inside a character. The
// steps are the ones this version reads, the first 50, in order, unticked, under new ids, each still saying who
// wrote it. The astral character is built from its code point, never typed.
const SMILE = String.fromCodePoint(0x1f600);
const step = (id: string, text: string, done: boolean, addedBy: StoredStep['addedBy']): StoredStep => ({ id, text, done, addedBy });
/** Hands out these ids in order, and records a copy of each `taken` set it was given. */
const recorder = (...ids: string[]) => {
  const queue = [...ids];
  const seen: string[][] = [];
  return { seen, newId: (taken: ReadonlySet<string>) => { seen.push([...taken].sort()); return queue.shift() ?? 'sxxxxxx'; } };
};

describe('duplicateName (TASK-953)', () => {
  it('puts "Copy of " in front of the name', () => {
    expect(duplicateName('Move the help docs')).toBe('Copy of Move the help docs');
  });

  it('cuts the longest name to fit the name limit', () => {
    const name = duplicateName('a'.repeat(128));
    expect(name).toBe(`Copy of ${'a'.repeat(120)}`);
    expect(name).toHaveLength(128);
  });

  it('drops a character the cut would halve, whole', () => {
    const name = duplicateName(`${'a'.repeat(119)}${SMILE}${'b'.repeat(8)}`);
    expect(name).toBe(`Copy of ${'a'.repeat(119)}`);
    expect(name).toHaveLength(127);
  });

  it('keeps a character that fits', () => {
    const name = duplicateName(`${SMILE}${'a'.repeat(118)}`);
    expect(name).toBe(`Copy of ${SMILE}${'a'.repeat(118)}`);
    expect(name).toHaveLength(128);
  });

  it('copies a copy with no special case', () => {
    expect(duplicateName('Copy of Onboard Acme')).toBe('Copy of Copy of Onboard Acme');
  });
});

describe('copiedSteps (TASK-953)', () => {
  it('copies each step unticked under a new id, still saying who wrote it', () => {
    const { seen, newId } = recorder('c1', 'c2');
    const source = [step('s000001', 'Export every article', true, 'agent'), step('s000002', 'Ask Dana to review billing', false, 'person')];
    expect(copiedSteps(source, newId)).toStrictEqual([
      { id: 'c1', text: 'Export every article', done: false, addedBy: 'agent' },
      { id: 'c2', text: 'Ask Dana to review billing', done: false, addedBy: 'person' },
    ]);
    // Each id is drawn against the source's ids and the ids drawn before it.
    expect(seen).toEqual([['s000001', 's000002'], ['c1', 's000001', 's000002']]);
  });

  it('draws ids of a step id’s shape, none of them the source’s', () => {
    const copy = copiedSteps([step('s000001', 'Export every article', true, 'agent'), step('s000002', 'Ask Dana', false, 'person')]);
    expect(copy.map(entry => entry.id)).toEqual([expect.stringMatching(/^s[0-9a-z]{6}$/), expect.stringMatching(/^s[0-9a-z]{6}$/)]);
    for (const { id } of copy) expect(['s000001', 's000002']).not.toContain(id);
  });

  it('copies only the steps this version reads', () => {
    const { newId } = recorder('c1', 'c2', 'c3', 'c4');
    expect(copiedSteps([
      7,
      step('s000001', 'Export every article', false, 'agent'),
      { id: 's000003', text: 'x', done: 'yes', addedBy: 'agent' },
      { id: 's000004', text: 'y', done: false, addedBy: 'robot' },
      step('s000001', 'A second step with the first one’s id', false, 'person'),
    ], newId)).toStrictEqual([{ id: 'c1', text: 'Export every article', done: false, addedBy: 'agent' }]);
  });

  it('copies anything that isn’t a list as no steps', () => {
    for (const value of [null, {}, '[]']) expect(copiedSteps(value), JSON.stringify(value)).toStrictEqual([]);
  });

  it('copies at most 50 steps: the first ones, in order', () => {
    const source = Array.from({ length: 51 }, (_, i) => step(`s${String(i + 1).padStart(6, '0')}`, `Step ${i + 1}`, false, 'agent'));
    const copy = copiedSteps(source);
    expect(copy).toHaveLength(50);
    expect(copy[0]?.text).toBe('Step 1');
    expect(copy[49]?.text).toBe('Step 50');
    expect(copy.map(entry => entry.text)).toEqual(source.slice(0, 50).map(entry => entry.text));
  });

  it('builds each copied step field by field, so nothing else on a stored step comes along', () => {
    const { newId } = recorder('c1');
    expect(copiedSteps([{ ...step('s000001', 'Export every article', true, 'agent'), note: 'From a later version' }], newId))
      .toStrictEqual([{ id: 'c1', text: 'Export every article', done: false, addedBy: 'agent' }]);
  });
});
