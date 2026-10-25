import { describe, expect, it, vi } from 'vitest';
import {
  ROUTINE_FINISH_BY_EARLIEST, ROUTINE_FINISH_BY_LATEST, RoutineCreateToolInputSchema, RoutineDefinitionSchema,
  RoutineFinishBySchema, RoutinePatchSchema, RoutineSetFinishByInputSchema, RoutineSetFinishByOutputSchema,
  RoutineToolDescriptions, RoutineToolInputSchemas, RoutineToolJsonSchemas, RoutineUpdateToolInputSchema,
  calendarDateIn, calendarDaysBetween, calendarDaysUntil, taskTimeZone,
} from '../index.js';

// TASK-951: a "get-done" task's finish date. A person sets it on the task page, through
// `routines:set-finish-by`, which is neither a tool nor an IPC action, so no model can set it. It is a
// calendar date, not an instant, and the brief, the Tasks row and the page count the days to it on one
// calendar: the task's own.
const issues = (value: unknown): string[] => {
  const result = RoutineFinishBySchema.safeParse(value);
  return result.success ? [] : result.error.issues.map(issue => issue.message);
};
const GET_DONE = RoutineDefinitionSchema.parse({
  name: 'Move the help center', promptBody: 'Move every help article to the new site.', kind: 'get-done',
  goodWhen: 'Every article is on the new site.', trigger: { kind: 'interval', every: '1h' },
});

describe("a task's finish date (TASK-951)", () => {
  it('accepts a real date from 2000 to 2100, a past one included', () => {
    expect([ROUTINE_FINISH_BY_EARLIEST, ROUTINE_FINISH_BY_LATEST]).toEqual(['2000-01-01', '2100-12-31']);
    for (const date of ['2026-11-14', '2000-01-01', '2100-12-31', '2028-02-29', '2001-01-01']) {
      expect(RoutineFinishBySchema.parse(date), date).toBe(date);
    }
  });

  it('refuses anything else with one reason', () => {
    const refused = [
      ['2026-02-30', 'Pick a real date.'], ['2027-02-29', 'Pick a real date.'], ['2026-13-01', 'Pick a real date.'],
      ['2026-11-00', 'Pick a real date.'], ['2101-01-01', 'Pick a real date.'], ['1999-12-31', 'Pick a real date.'],
      ['26-11-14', 'Pick a date.'], ['2026-11-14T00:00:00Z', 'Pick a date.'], [' 2026-11-14', 'Pick a date.'],
      // Fullwidth digits: a regex's digit class matches ASCII digits only.
      ['\uFF12\uFF10\uFF12\uFF16-11-14', 'Pick a date.'], ['', 'Pick a date.'],
    ] as const;
    for (const [value, message] of refused) expect(issues(value), value).toEqual([message]);
  });

  it('gives the same verdict whatever the clock says', () => {
    // Read paths revalidate, so a rule that moved with the clock could make a saved date unreadable (TASK-906).
    const verdicts = (now: string): boolean[] => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date(now));
        expect(Date.now(), 'the clock moved').toBe(Date.parse(now));
        return ['2026-11-14', '2001-01-01'].map(date => RoutineFinishBySchema.safeParse(date).success);
      } finally { vi.useRealTimers(); }
    };
    expect(verdicts('2026-01-01T00:00:00Z')).toEqual([true, true]);
    expect(verdicts('2099-12-31T00:00:00Z')).toEqual([true, true]);
  });
});

describe("a task's calendar (TASK-951)", () => {
  it('runs on the cron’s zone, else the active hours’, else UTC', () => {
    const tokyoHours = { start: '09:00', end: '17:00', tz: 'Asia/Tokyo' };
    expect(taskTimeZone({ trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' }, activeHours: tokyoHours })).toBe('America/New_York');
    expect(taskTimeZone({ trigger: { kind: 'interval', every: '15m' }, activeHours: tokyoHours })).toBe('Asia/Tokyo');
    expect(taskTimeZone({ trigger: { kind: 'interval', every: '15m' }, activeHours: null })).toBe('UTC');
  });

  it('reads a calendar date in a time zone, whatever the host’s zone is', () => {
    const at = new Date('2026-11-13T15:30:00Z');
    const dates = (): string[] => [calendarDateIn(at, 'Asia/Tokyo'), calendarDateIn(at, 'UTC')];
    // How the host itself reads the instant, day of the month then hour, so each flip is shown to have taken.
    const host = (): number[] => { const probe = new Date('2026-11-13T15:30:00Z'); return [probe.getDate(), probe.getHours()]; };
    expect(dates()).toEqual(['2026-11-14', '2026-11-13']);
    const saved = process.env.TZ;
    try {
      // UTC+14 is already on the 14th, so a date read in the host's zone would put UTC on the 14th too.
      process.env.TZ = 'Pacific/Kiritimati';
      expect(host(), 'the host moved to UTC+14').toEqual([14, 5]);
      expect(dates()).toEqual(['2026-11-14', '2026-11-13']);
      // UTC-11 is still on the 13th, so a date read in the host's zone would put Tokyo on the 13th too.
      process.env.TZ = 'Pacific/Pago_Pago';
      expect(host(), 'the host moved to UTC-11').toEqual([13, 4]);
      expect(dates()).toEqual(['2026-11-14', '2026-11-13']);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('counts whole days between two dates', () => {
    expect(calendarDaysBetween('2026-11-05', '2026-11-14')).toBe(9);
    expect(calendarDaysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(calendarDaysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(calendarDaysBetween('2026-11-14', '2026-11-14')).toBe(0);
    expect(calendarDaysBetween('2026-11-17', '2026-11-14')).toBe(-3);
    // A date that isn't a real `YYYY-MM-DD` counts as nothing, never as the day it would roll over to.
    expect(calendarDaysBetween('2026-11-05', '2026-02-30')).toBeNaN();
    expect(calendarDaysBetween('Nov 5', '2026-11-14')).toBeNaN();
  });

  // Hours, not dates, get the first row wrong even counted from midnight: 00:00 on 7 March to 00:00 on
  // 9 March in New York is 47 hours, which Math.floor reads as 1 day.
  it.each([
    ['2026-03-09', '2026-03-07T17:00:00Z', 'America/New_York', 2], // across spring-forward (a 23-hour day)
    ['2026-03-09', '2026-03-08T07:00:00Z', 'America/New_York', 1], // just after the jump
    ['2026-11-02', '2026-10-31T16:00:00Z', 'America/New_York', 2], // across fall-back (a 25-hour day)
    ['2026-11-14', '2026-11-13T15:30:00Z', 'Asia/Tokyo', 0], // already the 14th there
    ['2026-11-14', '2026-11-13T15:30:00Z', 'UTC', 1],
    ['2026-11-14', '2026-11-14T23:59:00Z', 'UTC', 0], // the day itself
    ['2026-11-14', '2026-11-17T12:00:00Z', 'UTC', -3], // past
  ] as const)('counts the days to %s from %s in %s: %i', (finishBy, at, tz, days) => {
    expect(calendarDaysUntil(finishBy, new Date(at), tz)).toBe(days);
  });
});

describe('routines:set-finish-by (TASK-951)', () => {
  const key = { agentId: 'a', routineId: 'r' };

  it('takes a task key and a date or null, and nothing else', () => {
    expect(RoutineSetFinishByInputSchema.parse({ ...key, finishBy: '2026-11-14' })).toEqual({ ...key, finishBy: '2026-11-14' });
    expect(RoutineSetFinishByInputSchema.parse({ ...key, finishBy: null })).toEqual({ ...key, finishBy: null });
    for (const input of [key, { ...key, finishBy: '2026-02-30' }, { ...key, finishBy: '2026-11-14', note: 'x' }]) {
      expect(RoutineSetFinishByInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('takes the time zone the date was set from, and refuses anything that isn\'t a zone (TASK-955)', () => {
    // Kept as sent, never canonicalized: a fixed offset and a name in another case are zones Intl reads.
    for (const finishByTimeZone of ['America/Los_Angeles', '+05:30', 'america/los_angeles']) {
      const input = { ...key, finishBy: '2026-10-25', finishByTimeZone };
      expect(RoutineSetFinishByInputSchema.parse(input), finishByTimeZone).toStrictEqual(input);
    }
    // None: null, or the key left out.
    expect(RoutineSetFinishByInputSchema.parse({ ...key, finishBy: null, finishByTimeZone: null }))
      .toStrictEqual({ ...key, finishBy: null, finishByTimeZone: null });
    expect(RoutineSetFinishByInputSchema.parse({ ...key, finishBy: '2026-10-25' })).toStrictEqual({ ...key, finishBy: '2026-10-25' });
    // No calendar has the first. The second is what a browser that can't tell its zone reports. Then an empty name,
    // a padded one, one past the 256-character cap, and something that isn't text.
    for (const finishByTimeZone of ['Not/AZone', 'Etc/Unknown', '', ' America/Los_Angeles', 'x'.repeat(257), 5]) {
      const input = { ...key, finishBy: '2026-10-25', finishByTimeZone };
      expect(RoutineSetFinishByInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('answers the date and the zone it was set from, or nulls', () => {
    const answer = { finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' };
    expect(RoutineSetFinishByOutputSchema.parse(answer)).toStrictEqual(answer);
    expect(RoutineSetFinishByOutputSchema.parse({ finishBy: null, finishByTimeZone: null })).toStrictEqual({ finishBy: null, finishByTimeZone: null });
    // Both keys, always, and nothing beside them.
    for (const output of [{ finishBy: null }, { finishBy: null, finishByTimeZone: null, revision: 'r' }]) {
      expect(RoutineSetFinishByOutputSchema.safeParse(output).success, JSON.stringify(output)).toBe(false);
    }
  });
});

describe('no tool can set a finish date (TASK-951)', () => {
  it('the strict create and patch schemas refuse a finishBy key, and a finishByTimeZone one (TASK-955)', () => {
    const create = (definition: object): boolean => RoutineCreateToolInputSchema.safeParse({ requestId: 'r', definition }).success;
    const update = (patch: object): boolean =>
      RoutineUpdateToolInputSchema.safeParse({ requestId: 'r', routineId: 'r', expectedRevision: 'v', patch }).success;
    // Each list starts with the same input without the key, which passes, so the key is what's refused.
    for (const field of [{ finishBy: '2026-11-14' }, { finishByTimeZone: 'America/Los_Angeles' }]) {
      const name = Object.keys(field).join();
      expect([create(GET_DONE), create({ ...GET_DONE, ...field })], name).toEqual([true, false]);
      expect([update({ enabled: false }), update(field), update({ enabled: false, ...field })], name).toEqual([true, false, false]);
      expect([GET_DONE, { ...GET_DONE, ...field }].map(value => RoutineDefinitionSchema.safeParse(value).success), name).toEqual([true, false]);
      expect([{ enabled: false }, field, { enabled: false, ...field }].map(value => RoutinePatchSchema.safeParse(value).success), name)
        .toEqual([true, false, false]);
    }
    // finishByTimeZone contains finishBy, so this rules out both.
    expect(JSON.stringify(RoutineToolJsonSchemas)).not.toContain('finishBy');
    expect(Object.keys(RoutineToolInputSchemas)).toEqual([
      'routine_list', 'routine_get', 'routine_create', 'routine_update', 'routine_delete', 'routine_fire_now', 'routine_report',
    ]);
  });
});

describe('the tools tell the agent about the date, and that only the person sets it (TASK-951)', () => {
  it('routine_list and routine_get say what finishBy is, and routine_update that a retry answers it null', () => {
    // The views the tools answer with carry the date, so the model reads what it means and who sets it.
    const sentence = 'finishBy is the date the person wants a "get-done" task finished by, or null. Only the person sets it.';
    for (const name of ['routine_list', 'routine_get'] as const) expect(RoutineToolDescriptions[name], name).toContain(sentence);
    // routine_update answers with the list tools' view, which carries it, and a replay answers from a receipt, which keeps none.
    // (TASK-950's done, the receipt keeps none either.)
    expect(RoutineToolDescriptions.routine_update)
      .toContain('A retry of an edit that already went through answers with task, noRecentUpdate, finishBy and done null, so read the task with routine_get.');
    // Neither creating a task nor reporting on one can carry a date.
    for (const name of ['routine_create', 'routine_report'] as const) expect(RoutineToolDescriptions[name], name).not.toContain('finishBy');
  });
});
