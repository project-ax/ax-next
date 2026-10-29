import { describe, expect, it } from 'vitest';
import type { ActiveHours, RoutineTrigger } from '@ax/routines-contract';
import { finishByShort, scheduleShort } from '../task-meta.js';
import { checkInSchedule } from '../task-schedule.js';

describe('scheduleShort', () => {
  // Every shape `checkInSchedule` builds (`lib/task-schedule.ts`), with the suffixes the wire adds.
  it.each([
    // Intervals.
    ['every second', '1 sec'],
    ['every 30 seconds', '30 sec'],
    ['every minute', '1 min'],
    ['every 15 minutes', '15 min'],
    ['every 90 minutes', '90 min'],
    ['every 60 minutes', '1 hr'],
    ['every hour', '1 hr'],
    ['every 2 hours', '2 hr'],
    ['every 24 hours', '1 day'],
    ['every 48 hours', '2 days'],
    ['every day', '1 day'],
    ['every 2 days', '2 days'],
    ['every 7 days', '1 wk'],
    ['every 14 days', '2 wk'],
    ['every week', '1 wk'],
    // Cron strides carry their zone.
    ['every minute (UTC)', '1 min'],
    ['every 15 minutes (America/New_York)', '15 min'],
    ['every 2 hours (Europe/London)', '2 hr'],
    // Active hours, with and without days, and one that needs repair.
    ['every hour, 9:00 AM to 6:00 PM (America/New_York)', '1 hr'],
    ['every 20 minutes, weekdays, 9:00 AM to 6:00 PM (UTC)', '20 min'],
    ['every 30 minutes, every day, 10:00 PM to 6:00 AM next day (Asia/Kolkata)', '30 min'],
    ['every 15 minutes (America/New_York), Monday, Wednesday, 9:00 AM to midnight (America/New_York)', '15 min'],
    ['every 2 hours, after active hours are repaired', '2 hr'],
    // An app trigger as well.
    ['every 15 minutes; also when an app sends an update', '15 min'],
  ])('%s → %s', (schedule, short) => {
    expect(scheduleShort(schedule)).toBe(short);
  });

  it.each([
    ['at 2:00 AM, every day (UTC)'],
    ['at 9:00 AM, every weekday (America/New_York)'],
    ['at 9:00 AM, every Friday (America/New_York), weekdays, 9:00 AM to 6:00 PM (America/New_York)'],
    ['at 2:00 AM on the 1st of each month (UTC)'],
    ['on a custom schedule'],
    ['when an app sends an update'],
    ['every 0 minutes'],
  ])('a schedule with no stride to say is the clock alone: %s', (schedule) => {
    expect(scheduleShort(schedule)).toBeNull();
  });

  // The wire's own words, built by the real formatter, so the two can't drift apart.
  const hours: ActiveHours = { start: '09:00', end: '18:00', tz: 'America/New_York', days: ['mon', 'tue', 'wed', 'thu', 'fri'] };
  it.each<[RoutineTrigger, ActiveHours | null, string | null]>([
    [{ kind: 'interval', every: '15m' }, null, '15 min'],
    [{ kind: 'interval', every: '1h' }, hours, '1 hr'],
    [{ kind: 'interval', every: '24h' }, null, '1 day'],
    [{ kind: 'interval', every: '2d' }, hours, '2 days'],
    [{ kind: 'interval', every: '45s' }, null, '45 sec'],
    [{ kind: 'cron', expr: '*/15 * * * *', tz: 'America/New_York' }, null, '15 min'],
    [{ kind: 'cron', expr: '*/15 * * * *', tz: 'America/New_York' }, hours, '15 min'],
    [{ kind: 'cron', expr: '0 */2 * * *', tz: 'UTC' }, null, '2 hr'],
    [{ kind: 'cron', expr: '* * * * *', tz: 'UTC' }, null, '1 min'],
    [{ kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' }, null, null],
    [{ kind: 'cron', expr: '15,45 2-4 * * *', tz: 'UTC' }, null, null],
  ])('checkInSchedule(%o) shortens honestly', (trigger, activeHours, short) => {
    const schedule = checkInSchedule(trigger, activeHours);
    expect(schedule).not.toBeNull();
    expect(scheduleShort(schedule)).toBe(short);
  });

  it('nothing for no schedule', () => {
    expect(scheduleShort(null)).toBeNull();
  });
});

describe('finishByShort', () => {
  it.each([
    [{ date: '2026-11-14', daysLeft: 9 }, 'Nov 14 · 9 days'],
    [{ date: '2026-11-14', daysLeft: 1 }, 'Nov 14 · 1 day'],
    [{ date: '2026-11-14', daysLeft: 0 }, 'Nov 14 · today'],
    [{ date: '2026-11-14', daysLeft: -3 }, 'Nov 14 · 3 days late'],
  ])('%o → %s', (finishBy, short) => {
    expect(finishByShort(finishBy, 'en-US')).toBe(short);
  });

  it('reads the date in UTC, so no zone moves the day', () => {
    expect(finishByShort({ date: '2026-01-01', daysLeft: 5 }, 'en-US')).toBe('Jan 1 · 5 days');
  });
});
