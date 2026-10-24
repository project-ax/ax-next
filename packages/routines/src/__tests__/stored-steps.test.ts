import { describe, expect, it } from 'vitest';
import { ROUTINE_STEPS_MAX, type RoutineStepOp } from '@ax/routines-contract';
import { applyStepOps, newStepId, storedSteps } from '../steps.js';
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

/** Hands out these ids in order, as newStepId would hand out random ones. */
const ids = (...list: string[]) => { const queue = [...list]; return () => queue.shift() ?? 'sxxxxxx'; };

describe('newStepId (TASK-948)', () => {
  it('is s and six lowercase base-36 characters', () => {
    for (let i = 0; i < 200; i++) expect(newStepId(new Set())).toMatch(/^s[0-9a-z]{6}$/);
  });
  it('draws again when the task already holds the id it drew', () => {
    const draws = [...Array(6).fill(0), ...Array(6).fill(35)];
    expect(newStepId(new Set(['s000000']), () => draws.shift()!)).toBe('szzzzzz');
  });
});

describe('applyStepOps (TASK-948)', () => {
  it('add appends the agent’s step, not done unless the change says so', () => {
    expect(applyStepOps([], [{ op: 'add', text: 'Export every article' }, { op: 'add', text: 'Upload them', done: true }], ids('s000001', 's000002')))
      .toEqual({ steps: [step('s000001', 'Export every article'), step('s000002', 'Upload them', { done: true })], applied: 2, skipped: 0 });
  });
  it('ticks and unticks any step, and rewords or removes only the agent’s own', () => {
    const agent = step('s000001', 'Export every article');
    const person = step('s000002', 'Ask Dana to review billing', { addedBy: 'person' });
    const ops: RoutineStepOp[] = [
      { op: 'tick', id: person.id }, { op: 'untick', id: person.id }, { op: 'tick', id: agent.id },
      { op: 'edit', id: agent.id, text: 'Export all 142 articles' },
      { op: 'edit', id: person.id, text: 'Skip the review' }, { op: 'remove', id: person.id },
      { op: 'tick', id: 'sgone00' }, { op: 'remove', id: agent.id },
    ];
    expect(applyStepOps([agent, person], ops)).toEqual({ steps: [person], applied: 5, skipped: 3 });
  });
  it('skips an add already on the list or past the cap, in order, so a remove makes room', () => {
    const full = Array.from({ length: ROUTINE_STEPS_MAX }, (_, i) => step(`s${String(i).padStart(6, '0')}`, `Step ${i}`));
    const result = applyStepOps(full, [
      { op: 'add', text: 'One more' }, { op: 'add', text: 'Step 3' }, { op: 'remove', id: 's000000' },
      { op: 'add', text: 'One more' }, { op: 'add', text: 'And another' },
    ], ids('snew001'));
    expect(result).toMatchObject({ applied: 2, skipped: 3 });
    expect(result.steps).toHaveLength(ROUTINE_STEPS_MAX);
    expect(result.steps.at(-1)).toEqual(step('snew001', 'One more'));
  });
  it('the same changes sent twice leave one copy of each step', () => {
    const ops: RoutineStepOp[] = [{ op: 'add', text: 'Upload them' }, { op: 'tick', id: 's000001' }, { op: 'edit', id: 's000001', text: 'Export all 142 articles' }];
    const once = applyStepOps([step('s000001', 'Export every article')], ops, ids('s000002'));
    const twice = applyStepOps(once.steps, ops, ids('s000003'));
    expect(twice.steps).toEqual(once.steps);
    expect(twice).toMatchObject({ applied: 2, skipped: 1 });
  });
  it('leaves the list it was given as it was', () => {
    const start = Object.freeze([Object.freeze(step('s000001', 'Export every article'))]);
    applyStepOps(start, [{ op: 'tick', id: 's000001' }, { op: 'edit', id: 's000001', text: 'x' }, { op: 'remove', id: 's000001' }, { op: 'add', text: 'New' }], ids('s000002'));
    expect(start).toEqual([step('s000001', 'Export every article')]);
  });
});
