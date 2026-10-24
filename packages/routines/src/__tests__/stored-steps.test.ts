import { describe, expect, it } from 'vitest';
import { ROUTINE_STEPS_MAX, type RoutineStepAuthor, type RoutineStepOp } from '@ax/routines-contract';
import { applyStepOps, changeStoredSteps, newStepId, readStoredSteps, storedSteps } from '../steps.js';
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
    expect(applyStepOps([], [{ op: 'add', text: 'Export every article' }, { op: 'add', text: 'Upload them', done: true }], 'agent', ids('s000001', 's000002')))
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
    expect(applyStepOps([agent, person], ops, 'agent')).toEqual({ steps: [person], applied: 5, skipped: 3 });
  });
  it('skips an add already on the list or past the cap, in order, so a remove makes room', () => {
    const full = Array.from({ length: ROUTINE_STEPS_MAX }, (_, i) => step(`s${String(i).padStart(6, '0')}`, `Step ${i}`));
    const result = applyStepOps(full, [
      { op: 'add', text: 'One more' }, { op: 'add', text: 'Step 3' }, { op: 'remove', id: 's000000' },
      { op: 'add', text: 'One more' }, { op: 'add', text: 'And another' },
    ], 'agent', ids('snew001'));
    expect(result).toMatchObject({ applied: 2, skipped: 3 });
    expect(result.steps).toHaveLength(ROUTINE_STEPS_MAX);
    expect(result.steps.at(-1)).toEqual(step('snew001', 'One more'));
  });
  it('the same changes sent twice leave one copy of each step', () => {
    const ops: RoutineStepOp[] = [{ op: 'add', text: 'Upload them' }, { op: 'tick', id: 's000001' }, { op: 'edit', id: 's000001', text: 'Export all 142 articles' }];
    const once = applyStepOps([step('s000001', 'Export every article')], ops, 'agent', ids('s000002'));
    const twice = applyStepOps(once.steps, ops, 'agent', ids('s000003'));
    expect(twice.steps).toEqual(once.steps);
    expect(twice).toMatchObject({ applied: 2, skipped: 1 });
  });
  it('leaves the list it was given as it was', () => {
    const start = Object.freeze([Object.freeze(step('s000001', 'Export every article'))]);
    applyStepOps(start, [{ op: 'tick', id: 's000001' }, { op: 'edit', id: 's000001', text: 'x' }, { op: 'remove', id: 's000001' }, { op: 'add', text: 'New' }], 'agent', ids('s000002'));
    expect(start).toEqual([step('s000001', 'Export every article')]);
  });
});

describe('applyStepOps as the person (TASK-949)', () => {
  const agent = step('s000001', 'Email all 500 customers');
  const person = step('s000002', 'Ask Dana to review billing', { addedBy: 'person' });

  it('add writes the person’s step, and follows the cap and the duplicate rule', () => {
    expect(applyStepOps([], [{ op: 'add', text: 'Ask Dana' }], 'person', ids('s000001')).steps).toEqual([step('s000001', 'Ask Dana', { addedBy: 'person' })]);
    expect(applyStepOps([agent], [{ op: 'add', text: agent.text }], 'person', ids('snew001'))).toEqual({ steps: [agent], applied: 0, skipped: 1 });
    const full = Array.from({ length: ROUTINE_STEPS_MAX }, (_, i) => step(`s${String(i).padStart(6, '0')}`, `Step ${i}`));
    expect(applyStepOps(full, [{ op: 'add', text: 'One more' }], 'person', ids('snew001'))).toEqual({ steps: full, applied: 0, skipped: 1 });
  });

  it('rewords or removes any step, and a reworded step becomes the person’s', () => {
    expect(applyStepOps([agent, person], [{ op: 'edit', id: agent.id, text: 'Email the five VIPs' }, { op: 'remove', id: person.id }], 'person'))
      .toEqual({ steps: [{ ...agent, text: 'Email the five VIPs', addedBy: 'person' }], applied: 2, skipped: 0 });
  });

  it('an edit that leaves the text as it is changes nothing', () => {
    // The agent's step stays the agent's: only words the person changed become theirs.
    expect(applyStepOps([agent, person], [{ op: 'edit', id: agent.id, text: agent.text }, { op: 'edit', id: person.id, text: person.text }], 'person'))
      .toEqual({ steps: [agent, person], applied: 2, skipped: 0 });
  });

  it('ticks and unticks any step', () => {
    const ticked = applyStepOps([agent, person], [{ op: 'tick', id: agent.id }, { op: 'tick', id: person.id }], 'person');
    expect(ticked).toEqual({ steps: [{ ...agent, done: true }, { ...person, done: true }], applied: 2, skipped: 0 });
    expect(applyStepOps(ticked.steps, [{ op: 'untick', id: agent.id }, { op: 'untick', id: person.id }], 'person'))
      .toEqual({ steps: [agent, person], applied: 2, skipped: 0 });
  });

  it('only the exact word ‘person’ gets a person’s reach', () => {
    // Routines' tests aren't type-checked, so this pins at run time that any other actor fails toward the agent's narrower reach.
    expect(applyStepOps([agent, person], [
      { op: 'edit', id: person.id, text: 'Skip the review' }, { op: 'remove', id: person.id },
      { op: 'edit', id: agent.id, text: 'Email the five VIPs' }, { op: 'add', text: 'Draft the email' },
    ], 'robot' as RoutineStepAuthor, ids('s000003'))).toEqual({
      steps: [{ ...agent, text: 'Email the five VIPs' }, person, step('s000003', 'Draft the email')], applied: 2, skipped: 2,
    });
  });
});

describe('readStoredSteps and changeStoredSteps (TASK-949)', () => {
  // An entry from a later version (an author this one doesn't know), a value that was never a step, and a second step with the first's id.
  const later = { ...step('s000002', 'B'), addedBy: 'app' };
  const stored = [step('s000001', 'A'), later, 7, step('s000001', 'dup')];

  it('readStoredSteps keeps what it can’t read and drops a duplicate it never shows', () => {
    expect(readStoredSteps(stored)).toEqual({ steps: [step('s000001', 'A')], unread: [later, 7] });
    expect(readStoredSteps({ not: 'a list' })).toBeNull();
    expect(readStoredSteps(null)).toBeNull();
  });

  it('a change writes the steps it read, as changed, then every entry it couldn’t read', () => {
    expect(changeStoredSteps(stored, [{ op: 'tick', id: 's000001' }], 'person')).toEqual({
      steps: [step('s000001', 'A', { done: true })], applied: 1, skipped: 0, write: [step('s000001', 'A', { done: true }), later, 7],
    });
  });

  it('nothing applied writes nothing', () => {
    expect(changeStoredSteps(stored, [{ op: 'tick', id: 'sgone00' }, { op: 'add', text: 'A' }], 'person'))
      .toEqual({ steps: [step('s000001', 'A')], applied: 0, skipped: 2, write: null });
  });

  it('a new step never takes the id of an entry it couldn’t read', () => {
    const kept = { ...step('sabcdef', 'x'), addedBy: 'app' };
    const change = changeStoredSteps([kept], [{ op: 'add', text: 'New' }], 'person', taken => (taken.has('sabcdef') ? 'snew001' : 'sabcdef'));
    expect(change.write).toEqual([step('snew001', 'New', { addedBy: 'person' }), kept]);
  });

  it('a value that isn’t a list skips every change and writes nothing', () => {
    for (const value of ['steps', { not: 'a list' }, null]) {
      expect(changeStoredSteps(value, [{ op: 'add', text: 'X' }], 'person'), JSON.stringify(value)).toEqual({ steps: [], applied: 0, skipped: 1, write: null });
    }
  });

  it('leaves the value it was given as it was', () => {
    const frozen = Object.freeze([Object.freeze(step('s000001', 'A')), Object.freeze({ ...later }), 7]);
    changeStoredSteps(frozen, [{ op: 'tick', id: 's000001' }, { op: 'edit', id: 's000001', text: 'x' }, { op: 'remove', id: 's000001' }, { op: 'add', text: 'New' }], 'person', ids('s000003'));
    expect(frozen).toEqual([step('s000001', 'A'), later, 7]);
  });
});
