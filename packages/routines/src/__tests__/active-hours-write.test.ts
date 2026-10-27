import { describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { RoutineDefinitionSchema, RoutineUpsertDefaultInputSchema } from '@ax/routines-contract';
import { createRequestHashes, validateScheduleWrite } from '../definition.js';
import { createRoutinesStore } from '../store.js';
import type { RoutinesDatabase } from '../migrations.js';

const schedule = { kind: 'interval', every: '1h' };
const emptyHours = { start: '09:00', end: '09:00', tz: 'UTC' };
const definition = (enabled = true) => RoutineDefinitionSchema.parse({
  name: 'Job', promptBody: 'Do the job.', schedule, webhook: null, enabled, activeHours: emptyHours,
});

describe('active hours at the actual effect boundary', () => {
  it('gives equivalent reordered day sets one request identity while preserving omission', () => {
    const base = { agentId: 'agent', definition: { ...definition(), activeHours: { ...emptyHours, end: '17:00', days: ['sun', 'mon'] } } };
    expect(createRequestHashes(base)).toEqual(createRequestHashes({ ...base,
      definition: { ...base.definition, activeHours: { ...base.definition.activeHours, days: ['mon', 'sun'] } },
    }));
    expect(Object.hasOwn(definition().activeHours!, 'days')).toBe(false);
  });
  it.each([true, false])('refuses a fresh equal-time effect, including disabled creates (%s)', enabled => {
    expect(() => validateScheduleWrite(definition(enabled))).toThrow(expect.objectContaining({ toolCode: 'validation', field: 'activeHours.end' }));
  });
  it('does not let an unrelated field or a partial pause author invalid hours', () => {
    const current = { ...definition(), activeHours: { ...emptyHours, end: '17:00' } };
    expect(() => validateScheduleWrite(definition(false), current, { enabled: false, name: 'Other' }))
      .toThrow(expect.objectContaining({ field: 'activeHours.end' }));
  });
  it('keeps historical reads and the exact emergency Stop available', () => {
    const historical = definition();
    expect(historical.activeHours).toEqual(emptyHours);
    expect(() => validateScheduleWrite({ ...historical, enabled: false }, historical, { enabled: false })).not.toThrow();
    expect(() => validateScheduleWrite({ ...historical, activeHours: null }, historical, { activeHours: null })).not.toThrow();
  });
});

/** Real Kysely/Postgres compiler and store; the connection only captures bound SQL, with no daemon. */
function captureDefaultQueries() {
  const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, parameters: readonly unknown[] = []) {
      queries.push({ sql, parameters });
      return { command: 'SELECT', rowCount: 1, rows: sql.includes('INSERT INTO default_routines_v1')
        ? [{ default_routine_id: 'default-id', created: true }] : [] };
    },
    release() {},
  };
  const db = new Kysely<RoutinesDatabase>({ dialect: new PostgresDialect({ pool: {
    connect: async () => client, end: async () => {},
  } }) });
  return { db, store: createRoutinesStore(db), queries };
}

describe('default active-hour effect binding', () => {
  it('binds the parsed canonical days instead of the unsorted caller object', async () => {
    const f = captureDefaultQueries();
    try {
      const input = RoutineUpsertDefaultInputSchema.parse({
        name: 'Default job', promptBody: 'Do the job.', trigger: schedule, activeHours: { ...emptyHours, end: '17:00' },
      });
      await f.store.upsertDefault({ ...input, activeHours: { ...input.activeHours!, days: ['sun', 'mon'] } });
      const insert = f.queries.find(query => query.sql.includes('INSERT INTO default_routines_v1'))!;
      const hours = insert.parameters.find(value => typeof value === 'string' && value.includes('"days"')) as string;
      expect(JSON.parse(hours).days).toEqual(['mon', 'sun']);
    } finally { await f.db.destroy(); }
  });
  it('refuses a fresh equal-time default before writing SQL', async () => {
    const f = captureDefaultQueries();
    try {
      const input = RoutineUpsertDefaultInputSchema.parse({ name: 'Default job', promptBody: 'Do the job.', trigger: schedule, activeHours: emptyHours });
      await expect(f.store.upsertDefault(input)).rejects.toMatchObject({ toolCode: 'validation', field: 'activeHours.end' });
      expect(f.queries.some(query => query.sql.includes('INSERT INTO'))).toBe(false);
    } finally { await f.db.destroy(); }
  });
});
