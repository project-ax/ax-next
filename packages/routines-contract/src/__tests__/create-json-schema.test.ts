import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { RoutineCreateToolInputSchema, RoutineDefinitionJsonSchema, RoutineToolJsonSchemas } from '../index.js';

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

  it.each(['stay-on-top', 'get-done'])('advertises %s with a safety schedule plus batched app updates', kind => {
    const input = { requestId: 'create-project', definition: { ...definition, kind, webhook } };
    expect(RoutineCreateToolInputSchema.safeParse(input).success).toBe(true);
    expect(validate(input)).toBe(true);
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

// Providers may compile one object alternative independently, rather than
// inheriting sibling properties. It must still describe the whole definition.
describe('independently compiled definition alternatives', () => {
  it.each([
    { name: 'Repeat', promptBody: 'Do the job.', schedule },
    { name: 'Repeat', promptBody: 'Do the job.', webhook },
    { ...definition, kind: 'stay-on-top', webhook: null },
    { ...definition, kind: 'get-done', webhook: null },
  ])('retains required brief fields and refuses unknown fields in alternative %#', input => {
    const matches = RoutineDefinitionJsonSchema.anyOf
      .map(branch => new Ajv({ strict: false }).compile(branch))
      .filter(accepts => accepts(input));
    expect(matches.length).toBeGreaterThan(0);
    for (const accepts of matches) {
      for (const field of ['name', 'promptBody']) {
        const missing: Record<string, unknown> = { ...input };
        delete missing[field];
        expect(RoutineCreateToolInputSchema.safeParse({ requestId: 'probe', definition: missing }).success).toBe(false);
        expect(accepts(missing), field).toBe(false);
      }
      expect(accepts({ ...input, unknown: true })).toBe(false);
    }
  });
});
