import { describe, it, expect } from 'vitest';
import * as C from '@ax/routines-contract';
import { routineView, ROUTINE_SERVICES } from '../services.js';
import type { StoredRoutine } from '../types.js';
const row: StoredRoutine = {
  ...C.RoutineDefinitionSchema.parse({ name: 'Notify', promptBody: 'Do the thing', trigger: { kind: 'interval', every: '1h' } }),
  agentId: 'agent', routineId: 'routine', revision: 'revision', ownerUserId: 'owner',
  definitionId: null, definitionUpdatedAt: null, nextRunAt: new Date('2030-01-01T00:00:00Z'), lastRunAt: null,
  lastStatus: null, lastError: null, lastWarning: null,
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
  it('declares every canonical service, including the host-only secret lifecycle', () => {
    expect(ROUTINE_SERVICES).toHaveLength(15);
    expect(ROUTINE_SERVICES).toContain('routines:set-webhook-secret');
    expect(C.RoutineSecretOutputSchema.parse({ saved: true })).toEqual({ saved: true });
  });
});
