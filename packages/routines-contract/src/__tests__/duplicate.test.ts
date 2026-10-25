import { describe, expect, it } from 'vitest';
import { RoutineDuplicateInputSchema, RoutineDuplicateOutputSchema } from '../index.js';

// `routines:duplicate` (TASK-953): a person copies their own task from its
// page. It names the task and a request id, and nothing about the copy: the
// host names it, picks its owner, copies its steps and keeps it paused, so none
// of that is the caller's to say. It answers the copy's id alone.

const input = { agentId: 'a', routineId: 'r', requestId: 'q' };
const accepts = (value: unknown): boolean => RoutineDuplicateInputSchema.safeParse(value).success;
const answers = (value: unknown): boolean => RoutineDuplicateOutputSchema.safeParse(value).success;

describe('routines:duplicate (TASK-953)', () => {
  it("takes a task's key and a request id, strictly", () => {
    expect(RoutineDuplicateInputSchema.parse(input)).toEqual(input);
    const { requestId: _requestId, ...noRequestId } = input;
    expect(accepts(noRequestId)).toBe(false);
    expect(accepts({ ...input, requestId: '' })).toBe(false);
    expect(accepts({ ...input, requestId: 'x'.repeat(256) })).toBe(true);
    expect(accepts({ ...input, requestId: 'x'.repeat(257) })).toBe(false);
    for (const extra of [{ name: 'Mine' }, { ownerUserId: 'u' }, { steps: [] }, { enabled: true }]) {
      expect(accepts({ ...input, ...extra }), JSON.stringify(extra)).toBe(false);
    }
  });

  it("answers the copy's id and nothing else", () => {
    expect(RoutineDuplicateOutputSchema.parse({ routineId: 'rtn_1' })).toStrictEqual({ routineId: 'rtn_1' });
    for (const bad of [{}, { routineId: '' }, { routineId: 'rtn_1', name: 'Copy of Notify' }, { routineId: 'rtn_1', steps: [] }]) {
      expect(answers(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
