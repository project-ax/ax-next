import { describe, expect, it } from 'vitest';
import {
  CHECK_IN_MISSES, CheckInMissSchema, RoutineDefinitionSchema, RoutineListToolOutputSchema, RoutineListToolViewSchema,
  RoutineNoRecentUpdateViewSchema, RoutineToolDescriptions, RoutineUpdateToolOutputSchema, RoutineViewSchema,
  TASK_AUTO_PAUSE_AFTER_MISSES, TASK_NEEDS_YOU_AFTER_MISSES,
} from '../index.js';

const good = { inARow: 1, reason: 'no-report', at: '2026-10-23T10:00:00.000Z', autoPaused: false };
// The threshold comes from the constant, so the descriptions can't drift from the pause they describe.
const sentence = `A task’s noRecentUpdate counts its check-ins in a row that ended without a report, with the last one’s reason and start time, or is null when there are none and for a task another person owns. autoPaused means ax paused the task after ${TASK_AUTO_PAUSE_AFTER_MISSES} in a row, and only a person can resume it.`;

describe('check-in misses (TASK-930)', () => {
  it('has the six codes in order and the two thresholds', () => {
    expect([...CHECK_IN_MISSES]).toEqual(['no-report', 'brief-missing', 'brief-unconfirmed', 'brief-too-long', 'interrupted', 'failed']);
    expect(CheckInMissSchema.options).toEqual([...CHECK_IN_MISSES]);
    expect(TASK_NEEDS_YOU_AFTER_MISSES).toBe(3);
    expect(TASK_AUTO_PAUSE_AFTER_MISSES).toBe(5);
  });

  it('parses the view with every code', () => {
    for (const reason of CHECK_IN_MISSES) expect(RoutineNoRecentUpdateViewSchema.safeParse({ ...good, reason }).success).toBe(true);
  });

  it.each([
    ['inARow 0', { inARow: 0 }], ['inARow 1.5', { inARow: 1.5 }], ['inARow string', { inARow: '2' }],
    ['unknown reason', { reason: 'gremlins' }], ['Date at', { at: new Date() }], ['extra key', { extra: 1 }],
  ])('refuses %s', (_n, patch) => {
    expect(RoutineNoRecentUpdateViewSchema.safeParse({ ...good, ...patch }).success).toBe(false);
  });

  it.each(Object.keys(good))('refuses a view without %s', key => {
    const rest: Record<string, unknown> = { ...good };
    delete rest[key];
    expect(RoutineNoRecentUpdateViewSchema.safeParse(rest).success).toBe(false);
  });

  it('tells a model about the counter and resume', () => {
    expect(RoutineToolDescriptions.routine_update).toContain('Only a person can resume a paused task.');
    expect(RoutineToolDescriptions.routine_list).toContain(sentence);
    expect(RoutineToolDescriptions.routine_get).toContain(sentence);
  });
});

describe('a view’s noRecentUpdate (TASK-930)', () => {
  const brief = RoutineDefinitionSchema.parse({
    name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
    kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
  });
  const view = {
    ...brief, agentId: 'a', routineId: 'r', revision: 'rev', ownedByCaller: true, origin: 'authored', defaultRoutineId: null,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null, lastWarning: null,
    permissions: { edit: true, stop: true, fire: true, manageSecret: false }, task: null, finishBy: null, finishByTimeZone: null, done: null,
  } as const;
  const paused = { inARow: 5, reason: 'interrupted', at: '2026-10-23T11:00:00.000Z', autoPaused: true } as const;

  // The services' view carries a get-done task's steps (TASK-948); the tools' list view leaves them out.
  it.each([
    ['RoutineViewSchema', RoutineViewSchema, { ...view, steps: [] }],
    ['RoutineListToolViewSchema', RoutineListToolViewSchema, view],
  ] as const)('%s requires it, takes null or a miss, and checks what a miss holds', (_name, schema, partial) => {
    // Left out is refused, so no reader mistakes an older producer's view for "no misses".
    expect(schema.safeParse(partial).success).toBe(false);
    for (const noRecentUpdate of [null, good, paused]) expect(schema.parse({ ...partial, noRecentUpdate })).toEqual({ ...partial, noRecentUpdate });
    // The stored shape's pause time never crosses, nor does anything else the view doesn't name.
    for (const extra of [{ autoPausedAt: paused.at }, { dispatchId: 'd' }]) {
      expect(schema.safeParse({ ...partial, noRecentUpdate: { ...good, ...extra } }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(schema.safeParse({ ...partial, noRecentUpdate: { ...good, inARow: 0 } }).success).toBe(false);
    expect(schema.safeParse({ ...partial, noRecentUpdate: { ...good, reason: 'gremlins' } }).success).toBe(false);
  });

  it('the tools’ answers carry it', () => {
    expect(RoutineListToolOutputSchema.parse({ routines: [{ ...view, noRecentUpdate: paused }] })).toEqual({ routines: [{ ...view, noRecentUpdate: paused }] });
    expect(RoutineUpdateToolOutputSchema.parse({ ...view, noRecentUpdate: good })).toEqual({ ...view, noRecentUpdate: good });
    expect(RoutineListToolOutputSchema.safeParse({ routines: [view] }).success).toBe(false);
  });
});
