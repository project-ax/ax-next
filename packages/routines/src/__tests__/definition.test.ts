import { describe, it, expect } from 'vitest';
import { RoutineDefinitionSchema, applyRoutinePatch } from '@ax/routines-contract';
import { editableDefinition, inputHash } from '../definition.js';
describe('editable projection', () => {
  it('projects only canonical fields before strict merged validation', () => {
    const definition = RoutineDefinitionSchema.parse({ name: 'test', promptBody: '\n raw \n', trigger: { kind: 'interval', every: '60s' } });
    const row = { ...definition, agentId: 'a', ownerUserId: 'private', routineId: 'r', revision: 'v', nextRunAt: new Date() };
    expect(editableDefinition(row)).toEqual(definition);
    expect(applyRoutinePatch(editableDefinition(row), { description: 'new' })).toEqual({ ...definition, description: 'new' });
    expect(inputHash({ b: 2, a: 1 })).toBe(inputHash({ a: 1, b: 2 }));
  });
});
