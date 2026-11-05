import { describe, expect, it } from 'vitest';
import { RoutineListOutputSchema, RoutineUnreadableViewSchema } from '../index.js';

const entry = { agentId: 'a', routineId: 'rtn_1', revision: 'rev_1', name: 'x'.repeat(300), origin: 'authored', canDelete: true };

describe('routines:list unreadable routines (TASK-913)', () => {
  it('reads a list answer that names no unreadable routine as none', () => {
    expect(RoutineListOutputSchema.parse({ routines: [] })).toEqual({ routines: [], unreadable: [] });
  });

  it('carries an unreadable routine with only its ids, revision, stored name, origin and Delete right', () => {
    expect(RoutineListOutputSchema.parse({ routines: [], unreadable: [entry] })).toEqual({ routines: [], unreadable: [entry] });
    for (const extra of [{ ownerUserId: 'owner' }, { kind: 'repeat' }, { schedule: null }])
      expect(RoutineUnreadableViewSchema.safeParse({ ...entry, ...extra }).success).toBe(false);
    for (const bad of [{ routineId: '' }, { revision: 'r'.repeat(257) }, { origin: 'other' }, { canDelete: 'yes' }])
      expect(RoutineUnreadableViewSchema.safeParse({ ...entry, ...bad }).success).toBe(false);
  });
});
