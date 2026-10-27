import { describe, expect, it } from 'vitest';
import { ActiveHoursSchema, RoutineDefinitionSchema, RoutinePatchSchema, RoutineCreateToolInputSchema,
  RoutineUpdateToolInputSchema, RoutineUpsertDefaultInputSchema } from '../index.js';

describe('active-hour selected days', () => {
  const hours = { start: '22:00', end: '06:00', tz: 'UTC' };

  it('keeps omitted days absent for historical definitions and receipt hashes', () => {
    expect(ActiveHoursSchema.parse(hours)).toEqual(hours);
    expect(Object.hasOwn(ActiveHoursSchema.parse(hours), 'days')).toBe(false);
  });

  it('preserves selected days in Monday-first canonical order', () => {
    expect(ActiveHoursSchema.parse({ ...hours, days: ['sun', 'fri', 'mon'] }))
      .toEqual({ ...hours, days: ['mon', 'fri', 'sun'] });
  });

  it('preserves canonical selections through definitions and patches', () => {
    const activeHours = { ...hours, days: ['fri', 'mon'] };
    const definition = RoutineDefinitionSchema.parse({
      name: 'Night shift', promptBody: 'Do the job.', trigger: { kind: 'interval', every: '1h' }, activeHours,
    });
    expect(definition.activeHours).toEqual({ ...hours, days: ['mon', 'fri'] });
    expect(RoutinePatchSchema.parse({ activeHours }).activeHours).toEqual(definition.activeHours);
    expect(RoutineCreateToolInputSchema.parse({ requestId: 'create', definition }).definition.activeHours).toEqual(definition.activeHours);
    expect(RoutineUpdateToolInputSchema.parse({ requestId: 'update', routineId: 'job', expectedRevision: 'r', patch: { activeHours } }).patch.activeHours)
      .toEqual(definition.activeHours);
    expect(RoutineUpsertDefaultInputSchema.parse(definition).activeHours).toEqual(definition.activeHours);
  });

  it.each([[[]], [['mon', 'mon']], [['toString']], [['Monday']], [['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'mon']]])
  ('rejects an empty, duplicate, unknown or oversized day set %#', days => {
    expect(ActiveHoursSchema.safeParse({ ...hours, days }).success).toBe(false);
  });

  it('refuses an inherited restriction rather than silently changing its meaning', () => {
    const inherited = Object.assign(Object.create({ days: ['mon'] }) as object, hours);
    expect(ActiveHoursSchema.safeParse(inherited).success).toBe(false);
  });
});
