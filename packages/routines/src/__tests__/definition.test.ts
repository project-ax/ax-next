import { describe, it, expect } from 'vitest';
import * as C from '@ax/routines-contract';
import { RoutineDefinitionSchema, applyRoutinePatch } from '@ax/routines-contract';
import { editableDefinition, inputHash, validateDefinition, validationError } from '../definition.js';
import { parseRoutineInput } from '../services.js';
describe('editable projection', () => {
  it('projects only canonical fields before strict merged validation', () => {
    const definition = RoutineDefinitionSchema.parse({ name: 'test', promptBody: '\n raw \n', trigger: { kind: 'interval', every: '60s' } });
    const row = { ...definition, agentId: 'a', ownerUserId: 'private', routineId: 'r', revision: 'v', nextRunAt: new Date() };
    expect(editableDefinition(row)).toEqual(definition);
    expect(applyRoutinePatch(editableDefinition(row), { description: 'new' })).toEqual({ ...definition, description: 'new' });
    expect(inputHash({ b: 2, a: 1 })).toBe(inputHash({ a: 1, b: 2 }));
  });
});

// TASK-906: the agent never sees a refusal's zod message, only the fixed
// template and a field from core's closed list. Naming the field tells it
// where to look; the tool descriptions say what each rule is.
describe('a refused routine input names its field', () => {
  const task = {
    name: 'Zero open tickets', promptBody: 'Keep the queue empty.', kind: 'stay-on-top', goodWhen: 'Queue empty.',
    trigger: { kind: 'interval', every: '15m' },
  };
  const hidden = 'Keep the queue empty.\u{E0041}\u{E006C}\u{E0073}\u{E006F}';
  const tooOften = { kind: 'cron', expr: '*/10 * * * *', tz: 'UTC' };
  const refusal = (fn: () => unknown): unknown => {
    try { fn(); } catch (error) { return error; }
    throw new Error('expected a refusal');
  };
  const update = (patch: unknown, extra = {}) => ({ routineId: 'r', requestId: 'q', expectedRevision: 'v', patch, ...extra });

  it('names promptBody for a task brief with hidden text, and the trigger field for a schedule that checks in too often', () => {
    expect(refusal(() => validateDefinition({ ...task, promptBody: hidden }))).toMatchObject({ toolCode: 'validation', field: 'promptBody' });
    expect(refusal(() => validateDefinition({ ...task, trigger: tooOften }))).toMatchObject({ toolCode: 'validation', field: 'trigger.expr' });
    expect(refusal(() => validateDefinition({ ...task, trigger: { kind: 'interval', every: '5m' } }))).toMatchObject({ field: 'trigger.every' });
    expect(refusal(() => validateDefinition({ ...task, name: 'Zero\nopen' }))).toMatchObject({ field: 'name' });
  });

  it('reads past the tool’s wrapper: a create’s definition and an update’s patch', () => {
    expect(refusal(() => parseRoutineInput(C.RoutineCreateToolInputSchema, { requestId: 'q', definition: { ...task, promptBody: hidden } })))
      .toMatchObject({ toolCode: 'validation', field: 'promptBody' });
    expect(refusal(() => parseRoutineInput(C.RoutineCreateToolInputSchema, { requestId: 'q', definition: { ...task, trigger: tooOften } })))
      .toMatchObject({ field: 'trigger.expr' });
    expect(refusal(() => parseRoutineInput(C.RoutineUpdateToolInputSchema, update({ trigger: { kind: 'interval', every: '1s' } }))))
      .toMatchObject({ field: 'trigger.every' });
    expect(refusal(() => parseRoutineInput(C.RoutineUpdateToolInputSchema, update({ enabled: false }, { routineId: '' }))))
      .toMatchObject({ field: 'routineId' });
    // The merged definition an update would store, as `applyRoutinePatch` refuses it.
    const current = RoutineDefinitionSchema.parse(task);
    expect(refusal(() => { try { applyRoutinePatch(current, { promptBody: hidden }); } catch (error) { throw validationError(error); } }))
      .toMatchObject({ field: 'promptBody' });
  });

  it('keeps input for a field core has no name for, and for anything that isn’t a schema refusal', () => {
    // goodWhen and kind aren't in core's closed list, and an array index isn't a field name.
    expect(refusal(() => validateDefinition({ ...task, goodWhen: null }))).toMatchObject({ field: 'input' });
    expect(refusal(() => parseRoutineInput(C.RoutineUpdateToolInputSchema, update({ kind: 'stay-on-top' })))).toMatchObject({ field: 'input' });
    expect(refusal(() => validateDefinition({ name: 'Hook', promptBody: 'p', trigger: { kind: 'webhook', path: '/z', events: ['bad.event'] } })))
      .toMatchObject({ field: 'input' });
    const unknown = validationError(new Error('SECRET hidden text'));
    expect(unknown).toMatchObject({ toolCode: 'validation', field: 'input' });
    expect(unknown.message).toBe('Routine input is invalid. Check the indicated field. Field: input');
  });

  it('says only the fixed template and the field, never the input or the schema’s message', () => {
    const error = refusal(() => validateDefinition({ ...task, promptBody: hidden })) as Error;
    expect(error.message).toBe('Routine input is invalid. Check the indicated field. Field: promptBody');
  });
});
