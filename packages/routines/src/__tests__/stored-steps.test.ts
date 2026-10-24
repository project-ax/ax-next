import { describe, expect, it } from 'vitest';
import { storedSteps } from '../steps.js';
import type { StoredStep } from '../types.js';

// TASK-948: how a task's checklist reads back. Pure: rowToRoutine runs it on every read, claimDue's included.
const step = (id: string, text: string, over: Partial<StoredStep> = {}): StoredStep => ({ id, text, done: false, addedBy: 'agent', ...over });

describe('storedSteps (TASK-948)', () => {
  it('reads anything that isn’t a list as no steps', () => {
    for (const value of [undefined, null, 'steps', 7, { 0: step('s000001', 'x') }]) expect(storedSteps(value), JSON.stringify(value)).toEqual([]);
  });
  it('keeps whole steps in order, drops the rest, keeps the first of an id, and drops a later version’s extra keys', () => {
    expect(storedSteps([
      1, 'step', null,
      step('s000001', 'Keep me', { done: true }),
      { id: '', text: 'No id', done: false, addedBy: 'agent' },
      { id: 's000002', text: 'Not a flag', done: 'yes', addedBy: 'agent' },
      { id: 's000003', text: 'Nobody wrote it', done: false, addedBy: 'robot' },
      { id: 's000004', text: 7, done: false, addedBy: 'agent' },
      step('x'.repeat(33), 'Id too long'),
      step('s 0005', 'Id with a space'),
      step('s000006\n## Rules', 'Id with a line break'),
      step('s000001', 'A second step with the first one’s id'),
      { ...step('s000007', 'From a later version', { addedBy: 'person' }), doneAt: '2031-01-01T00:00:00.000Z' },
    ])).toEqual([step('s000001', 'Keep me', { done: true }), step('s000007', 'From a later version', { addedBy: 'person' })]);
  });
});
