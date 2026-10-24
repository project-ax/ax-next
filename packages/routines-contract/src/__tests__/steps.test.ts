import { describe, expect, it } from 'vitest';
import {
  ROUTINE_STEP_TEXT_MAX_CHARS, ROUTINE_STEPS_MAX, RoutineReportInputSchema, RoutineReportOutputSchema, RoutineReportToolInputSchema,
  RoutineStepOpSchema, RoutineStepTextSchema, RoutineStepViewSchema, RoutineToolJsonSchemas,
} from '../index.js';

// TASK-948: a "get-done" task's steps. The text rule's messages reach a person (TASK-949's box shows them), so
// each says what to fix; the agent gets only the field's name (core's fixed template).
const issues = (value: unknown) => {
  const result = RoutineStepTextSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map(issue => issue.message);
};
const report = { status: 'on-track', update: 'Moving.' } as const;

describe('a step’s text (TASK-948)', () => {
  it('takes one line of 1 to 200 characters, whole emoji included', () => {
    expect(ROUTINE_STEP_TEXT_MAX_CHARS).toBe(200);
    for (const text of ['Export every article', 'a'.repeat(200), `Ship it ${String.fromCodePoint(0x1f680)}`, 'Tab\tinside']) expect(issues(text), text).toEqual([]);
  });
  it.each([
    ['empty', '', 'Write the step first.'],
    ['too long', 'a'.repeat(201), 'A step can be up to 200 characters.'],
    ['blank', '   ', 'Write the step first.'],
    ['a line feed', 'two\nlines', 'A step is one line.'],
    ['a carriage return', 'two\rlines', 'A step is one line.'],
    ['an invisible character after an emoji', `${String.fromCodePoint(0x1f600)}a\u200Bb`, 'A step can’t contain invisible characters (U+200B at character 3).'],
    ['a lone surrogate', 'ok\uD800', 'A step can’t contain broken characters.'],
  ])('refuses %s with one reason', (_label, value, message) => {
    expect(issues(value)).toEqual([message]);
  });
});

describe('a step change (TASK-948)', () => {
  it('reads every op, add with or without done', () => {
    const ops = [
      { op: 'add', text: 'Export every article' }, { op: 'add', text: 'Upload them', done: true },
      { op: 'tick', id: 's1a2b3c' }, { op: 'untick', id: 's1a2b3c' },
      { op: 'edit', id: 's1a2b3c', text: 'Export all 142' }, { op: 'remove', id: 's1a2b3c' },
    ];
    for (const op of ops) expect(RoutineStepOpSchema.parse(op)).toEqual(op);
  });
  it.each([
    ['who added it', { op: 'add', text: 'x', addedBy: 'person' }],
    ['an id on an add', { op: 'add', text: 'x', id: 's1' }],
    ['text on a tick', { op: 'tick', id: 's1', text: 'x' }],
    ['done on an untick', { op: 'untick', id: 's1', done: false }],
    ['an edit with no text', { op: 'edit', id: 's1' }],
    ['text on a remove', { op: 'remove', id: 's1', text: 'x' }],
    ['an unknown op', { op: 'rename', id: 's1' }],
    ['an empty id', { op: 'tick', id: '' }],
    ['an id past 32', { op: 'tick', id: 'x'.repeat(33) }],
    ['a two-line add', { op: 'add', text: 'two\nlines' }],
    ['a hidden-character edit', { op: 'edit', id: 's1', text: 'a\u200Bb' }],
  ])('refuses %s', (_label, op) => {
    expect(RoutineStepOpSchema.safeParse(op).success).toBe(false);
  });
});

describe('a step as a view shows it (TASK-948)', () => {
  it('is strict, bounds the id, and doesn’t re-cap stored text (TASK-913)', () => {
    const step = { id: 's1a2b3c', text: 't'.repeat(3000), done: false, addedBy: 'agent' };
    expect(RoutineStepViewSchema.parse(step)).toEqual(step);
    for (const bad of [{ ...step, addedBy: 'robot' }, { ...step, id: '' }, { ...step, id: 'x'.repeat(33) }, { ...step, done: 'no' }, { ...step, doneAt: 'x' }]) {
      expect(RoutineStepViewSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('a report’s steps (TASK-948)', () => {
  it('carries 1 to 50 changes, on the tool and on the service, and leaves them out otherwise', () => {
    expect(ROUTINE_STEPS_MAX).toBe(50);
    const add = { op: 'add', text: 'Export every article' } as const;
    const binding = { agentId: 'a', dispatchId: 'd', ask: null };
    for (const steps of [[add], Array(50).fill(add)]) {
      expect(RoutineReportToolInputSchema.parse({ ...report, steps }).steps).toEqual(steps);
      expect(RoutineReportInputSchema.parse({ ...report, ...binding, steps }).steps).toEqual(steps);
    }
    for (const steps of [[], Array(51).fill(add), add, 'x']) {
      expect(RoutineReportToolInputSchema.safeParse({ ...report, steps }).success).toBe(false);
      expect(RoutineReportInputSchema.safeParse({ ...report, ...binding, steps }).success).toBe(false);
    }
    expect('steps' in RoutineReportToolInputSchema.parse(report)).toBe(false);
  });
  it('answers its counts only when it sent changes', () => {
    expect(RoutineReportOutputSchema.parse({ recorded: true })).toStrictEqual({ recorded: true });
    expect(RoutineReportOutputSchema.parse({ recorded: true, steps: { applied: 2, skipped: 1 } })).toStrictEqual({ recorded: true, steps: { applied: 2, skipped: 1 } });
    for (const steps of [{ applied: 2 }, { applied: -1, skipped: 0 }, { applied: 1.5, skipped: 0 }, { applied: 1, skipped: 0, ids: ['s1'] }]) {
      expect(RoutineReportOutputSchema.safeParse({ recorded: true, steps }).success, JSON.stringify(steps)).toBe(false);
    }
  });
  it('offers the model one JSON schema per change, each closed', () => {
    const steps = RoutineToolJsonSchemas.routine_report.properties.steps;
    expect(steps).toMatchObject({ type: 'array', minItems: 1, maxItems: 50 });
    expect(steps.items.oneOf.map(variant => [variant.properties.op.const, [...variant.required], variant.additionalProperties])).toEqual([
      ['add', ['op', 'text'], false], ['tick', ['op', 'id'], false], ['untick', ['op', 'id'], false],
      ['edit', ['op', 'id', 'text'], false], ['remove', ['op', 'id'], false],
    ]);
    expect(steps.items.oneOf[0].properties).toMatchObject({ text: { type: 'string', minLength: 1, maxLength: 200 }, done: { type: 'boolean' } });
  });
});
