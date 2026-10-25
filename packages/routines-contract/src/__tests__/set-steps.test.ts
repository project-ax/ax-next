import { describe, expect, it } from 'vitest';
import { ROUTINE_STEPS_MAX, RoutineSetStepsInputSchema, RoutineSetStepsOutputSchema } from '../index.js';

// `routines:set-steps` (TASK-949): a task's owner changes its steps on its task
// page, with the same changes the agent's report sends. The text rule's
// messages reach the person, so the first one is the one they read. The
// invisible character below is built from its code point, never typed.

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const add = { op: 'add', text: 'Ask Dana' } as const;
const input = { agentId: 'a', routineId: 'r', requestId: 'q', ops: [add] };
const accepts = (value: unknown): boolean => RoutineSetStepsInputSchema.safeParse(value).success;
/** The first issue's message for an add of `text`, or null when it parses. */
const firstMessage = (text: string): string | null => {
  const result = RoutineSetStepsInputSchema.safeParse({ ...input, ops: [{ op: 'add', text }] });
  return result.success ? null : result.error.issues[0]?.message ?? null;
};

describe('routines:set-steps (TASK-949)', () => {
  it("takes a routine's key, a request id and 1 to 50 changes, strictly", () => {
    expect(RoutineSetStepsInputSchema.parse(input)).toEqual(input);
    expect(ROUTINE_STEPS_MAX).toBe(50);
    expect(accepts({ ...input, ops: Array(50).fill(add) })).toBe(true);
    expect(accepts({ ...input, ops: [] })).toBe(false);
    expect(accepts({ ...input, ops: Array(51).fill(add) })).toBe(false);
    // The changes go in `ops`, and nothing rides beside them.
    expect(accepts({ ...input, steps: [] })).toBe(false);
    // The host says who added a step, never the caller.
    expect(accepts({ ...input, ops: [{ ...add, addedBy: 'person' }] })).toBe(false);
    const { requestId: _requestId, ...noRequestId } = input;
    expect(accepts(noRequestId)).toBe(false);
    expect(accepts({ ...input, requestId: '' })).toBe(false);
  });

  it('refuses a text the person has to fix, and its first message says what to fix', () => {
    expect(firstMessage(' ')).toBe('Write the step first.');
    expect(firstMessage('a'.repeat(201))).toBe('A step can be up to 200 characters.');
    expect(firstMessage(`Ask${ZERO_WIDTH_SPACE}Dana`)).toMatch(/^A step can’t contain invisible characters/);
  });

  it('answers the steps and a count, strictly', () => {
    const answer = { steps: [{ id: 's1', text: 'x', done: false, addedBy: 'person' }], skipped: 0 };
    expect(RoutineSetStepsOutputSchema.parse(answer)).toEqual(answer);
    for (const bad of [{ ...answer, skipped: -1 }, { ...answer, skipped: 1.5 }, { ...answer, applied: 1 }]) {
      expect(RoutineSetStepsOutputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
