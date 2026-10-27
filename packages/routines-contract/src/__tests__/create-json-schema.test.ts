import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { RoutineCreateToolInputSchema, RoutineToolJsonSchemas } from '../index.js';

const validate = new Ajv({ strict: false }).compile(RoutineToolJsonSchemas.routine_create);
const schedule = { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' };
const webhook = { kind: 'webhook', path: '/project-updates' };
const definition = { name: 'Project tracker', promptBody: 'Ask for progress. Do not invent updates.', goodWhen: 'Milestones arrive on time.', schedule };

describe('advertised task creation schema', () => {
  it.each(['stay-on-top', 'get-done'])('offers a schedule-only %s with an omitted or null webhook', kind => {
    for (const absent of [{}, { webhook: null }]) {
      const input = { requestId: 'create-project', definition: { ...definition, kind, ...absent } };
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
      expect(RoutineCreateToolInputSchema.parse(input).definition).toMatchObject({ kind, schedule, webhook: null });
    }
  });

  it.each(['stay-on-top', 'get-done'])('does not advertise the production-invalid %s plus webhook combination', kind => {
    const input = { requestId: 'create-project', definition: { ...definition, kind, webhook } };
    expect(RoutineCreateToolInputSchema.safeParse(input).success).toBe(false);
    expect(validate(input)).toBe(false);
  });

  it.each([
    { schedule, webhook: null }, { schedule: null, webhook }, { schedule, webhook },
  ])('keeps existing Repeat wake methods valid %#', methods => {
    const input = { requestId: 'create-repeat', definition: { name: 'Repeat', promptBody: 'Do the job.', ...methods } };
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    expect(RoutineCreateToolInputSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    { schedule: null }, { goodWhen: null }, { conversation: 'shared' }, { silenceToken: 'QUIET' },
  ])('does not advertise incompatible task fields %#', patch => {
    const input = { requestId: 'create-project', definition: { ...definition, kind: 'stay-on-top', webhook: null, ...patch } };
    expect(RoutineCreateToolInputSchema.safeParse(input).success).toBe(false);
    expect(validate(input)).toBe(false);
  });

  it('refuses extra fields and Repeat without any wake method', () => {
    for (const input of [
      { requestId: 'create-repeat', definition: { name: 'Repeat', promptBody: 'Do the job.' } },
      { requestId: 'create-project', definition: { ...definition, kind: 'stay-on-top', extra: true } },
    ]) {
      expect(validate(input)).toBe(false);
      expect(RoutineCreateToolInputSchema.safeParse(input).success).toBe(false);
    }
  });
});
