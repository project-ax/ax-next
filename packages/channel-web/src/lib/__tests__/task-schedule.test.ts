/**
 * TASK-906 — how often a proposed task checks in, in plain words.
 *
 * The approval card asks a person whether a task should start. "1h" and
 * "0 9 * * 1-5" are exact and opaque, so the card says what they mean, and
 * falls back to the raw expression rather than guessing when a cron is past
 * what `describeCron` will put into words.
 */
import { describe, expect, it } from 'vitest';
import type { RoutineTrigger } from '@ax/routines-contract';
import type { ActiveHours } from '@ax/routines-contract';
import { checkInSchedule, describeCheckIns } from '../task-schedule';

describe('checkInSchedule', () => {
  it('includes weekday and overnight start-day meaning', () => {
    expect(checkInSchedule({ kind: 'interval', every: '1h' }, { start: '22:00', end: '06:00', tz: 'UTC', days: ['mon', 'tue', 'wed', 'thu', 'fri'] })).toBe('every hour, weekdays, 10:00 PM to 6:00 AM next day (UTC)');
  });
  it('names an individual selected day and refuses to promise a run for an empty legacy window', () => {
    expect(checkInSchedule({ kind: 'interval', every: '1h' }, { start: '22:00', end: '06:00', tz: 'UTC', days: ['sun'] })).toContain('Sunday');
    expect(checkInSchedule({ kind: 'interval', every: '1h' }, { start: '09:00', end: '09:00', tz: 'UTC' })).toBe('after active hours are repaired');
  });
  it.each([
    ['15m', 'every 15 minutes'],
    ['1h', 'every hour'],
    ['2d', 'every 2 days'],
  ])('says an interval of %s as "%s"', (every, text) => {
    expect(checkInSchedule({ kind: 'interval', every }, null)).toBe(text);
  });

  it('says null for an interval it cannot read', () => {
    expect(checkInSchedule({ kind: 'interval', every: 'soon' } as RoutineTrigger, null)).toBeNull();
  });

  it('a cron it can describe', () => {
    expect(
      checkInSchedule({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'America/New_York' }, null),
    ).toBe('at 9:00 AM, every weekday (America/New_York)');
  });

  it("a cron it can't", () => {
    expect(checkInSchedule({ kind: 'cron', expr: '15,45 2-4 * * *', tz: 'UTC' }, null)).toBe(
      'on a custom schedule',
    );
  });

  it('a webhook', () => {
    expect(checkInSchedule({ kind: 'webhook' } as RoutineTrigger, null)).toBeNull();
  });

  it('adds the active hours, in their own time zone', () => {
    const hours: ActiveHours = { start: '09:00', end: '18:00', tz: 'America/New_York' };
    expect(checkInSchedule({ kind: 'interval', every: '1h' }, hours)).toBe(
      'every hour, 9:00 AM to 6:00 PM (America/New_York)',
    );
  });

  it('says midnight for the end of the day', () => {
    const hours: ActiveHours = { start: '22:00', end: '24:00', tz: 'UTC' };
    expect(checkInSchedule({ kind: 'interval', every: '1h' }, hours)).toBe(
      'every hour, 10:00 PM to midnight (UTC)',
    );
  });
});

describe('describeCheckIns', () => {
  it.each([
    ['15m', 'Runs every 15 minutes'],
    ['1h', 'Runs every hour'],
    ['1m', 'Runs every minute'],
    ['2d', 'Runs every 2 days'],
    ['900s', 'Runs every 900 seconds'],
    ['00060s', 'Runs every 60 seconds'],
  ])('says an interval of %s as "%s"', (every, text) => {
    expect(describeCheckIns({ kind: 'interval', every })).toBe(text);
  });

  it('describes a cron it can put into words, naming the timezone', () => {
    expect(describeCheckIns({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'America/New_York' })).toBe(
      'Runs at 9:00 AM, every weekday (America/New_York)',
    );
  });

  it('shows the raw expression for a cron it will not narrate', () => {
    expect(describeCheckIns({ kind: 'cron', expr: '*/20 9-17 * * 1-5', tz: 'UTC' })).toBe(
      'Custom schedule: */20 9-17 * * 1-5 (UTC)',
    );
  });

  it('has nothing to say about a webhook, which does not check in on a schedule', () => {
    expect(describeCheckIns({ kind: 'webhook', path: '/zendesk' })).toBeNull();
  });

  it('says nothing rather than guess at an interval it cannot read', () => {
    const unreadable = { kind: 'interval', every: 'soon' } as RoutineTrigger;
    expect(describeCheckIns(unreadable)).toBeNull();
  });
});
