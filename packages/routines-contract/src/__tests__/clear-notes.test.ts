import { describe, expect, it } from 'vitest';
import { RoutineClearNotesInputSchema, RoutineClearNotesOutputSchema } from '../index.js';

// `routines:clear-notes` (TASK-910): the person clears a task's agent notes on
// its task page. It names the task and nothing else, and answers one fact.

describe('routines:clear-notes (TASK-910)', () => {
  it("takes exactly a routine's key", () => {
    expect(RoutineClearNotesInputSchema.parse({ agentId: 'a', routineId: 'r' })).toEqual({ agentId: 'a', routineId: 'r' });
    expect(RoutineClearNotesInputSchema.safeParse({ agentId: 'a', routineId: 'r', notes: null }).success).toBe(false);
    expect(RoutineClearNotesInputSchema.safeParse({ agentId: 'a' }).success).toBe(false);
  });

  it('answers only { cleared: true }', () => {
    expect(RoutineClearNotesOutputSchema.parse({ cleared: true })).toEqual({ cleared: true });
    expect(RoutineClearNotesOutputSchema.safeParse({ cleared: false }).success).toBe(false);
    expect(RoutineClearNotesOutputSchema.safeParse({ cleared: true, notes: null }).success).toBe(false);
  });
});
