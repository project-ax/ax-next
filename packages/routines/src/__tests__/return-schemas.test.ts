import { describe, it, expect } from 'vitest';
import * as C from '@ax/routines-contract';
import { routinePermissions, routineView, ROUTINE_SERVICES } from '../services.js';
import type { StoredRoutine } from '../types.js';
const row: StoredRoutine = {
  ...C.RoutineDefinitionSchema.parse({ name: 'Notify', promptBody: 'Do the thing', trigger: { kind: 'interval', every: '1h' } }),
  agentId: 'agent', routineId: 'routine', revision: 'revision', ownerUserId: 'owner',
  definitionId: null, definitionUpdatedAt: null, nextRunAt: new Date('2030-01-01T00:00:00Z'), lastRunAt: null,
  lastStatus: null, lastError: null, lastWarning: null, task: null,
};
describe('canonical routine return schemas', () => {
  it('projects every editable/status field without private owner or storage state', () => {
    const projected = routineView(row, 'owner', true);
    expect(C.RoutineViewSchema.parse(projected)).toEqual(projected);
    expect(projected).not.toHaveProperty('ownerUserId');
    expect(projected).not.toHaveProperty('definitionUpdatedAt');
    expect(projected.nextRunAt).toBe('2030-01-01T00:00:00.000Z');
    for (const schema of [C.RoutineGetOutputSchema, C.RoutineCreateOutputSchema, C.RoutineUpdateOutputSchema]) expect(schema.parse(projected)).toEqual(projected);
    expect(() => C.RoutineViewSchema.parse({ ...projected, token: 'secret' })).toThrow();
  });
  it("projects a task's latest report, and nothing for a repeat routine", () => {
    const task: StoredRoutine = {
      ...row,
      ...C.RoutineDefinitionSchema.parse({
        name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
        kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
      }),
      task: {
        status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?',
        agentNotes: 'Order 1234 waits on a refund.', reportedAt: new Date('2030-01-01T00:05:00Z'),
      },
    };
    const projected = routineView(task, 'owner', true);
    expect(projected.task).toEqual({
      status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?',
      reportedAt: '2030-01-01T00:05:00.000Z', agentNotes: 'Order 1234 waits on a refund.',
    });
    for (const schema of [C.RoutineGetOutputSchema, C.RoutineCreateOutputSchema, C.RoutineUpdateOutputSchema]) expect(schema.parse(projected)).toEqual(projected);
    // Anyone but its owner sees the routine without its task state.
    const teammate = routineView(task, 'teammate', true);
    expect(teammate).toEqual({ ...projected, permissions: routinePermissions(task, 'teammate', true), task: null });
    expect(C.RoutineViewSchema.parse(teammate)).toEqual(teammate);
    // A repeat routine shows none, even when its row holds some.
    const repeat = routineView({ ...task, kind: 'repeat', goodWhen: null }, 'owner', true);
    expect(repeat.task).toBeNull();
    expect(C.RoutineViewSchema.parse(repeat)).toEqual(repeat);
  });
  it("declares every canonical service, including the host-only secret lifecycle, a check-in's report and clearing its notes", () => {
    expect(ROUTINE_SERVICES).toHaveLength(17);
    expect(ROUTINE_SERVICES).toContain('routines:set-webhook-secret');
    expect(ROUTINE_SERVICES).toContain('routines:report');
    expect(ROUTINE_SERVICES).toContain('routines:clear-notes');
    expect(C.RoutineSecretOutputSchema.parse({ saved: true })).toEqual({ saved: true });
    expect(C.RoutineClearNotesOutputSchema.parse({ cleared: true })).toEqual({ cleared: true });
  });
});
