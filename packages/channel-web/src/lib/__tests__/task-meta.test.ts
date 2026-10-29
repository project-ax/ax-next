import { describe, expect, it } from 'vitest';
import { finishByShort, scheduleShort } from '../task-meta.js';

describe('scheduleShort', () => {
  it.each([
    ['every hour, 9:00 AM to 6:00 PM (America/New_York)', '1 hr'],
    ['every 20 minutes', '20 min'],
    ['every 2 hours; also when an app sends an update', '2 hr'],
    ['every day', '1 day'],
    ['every 3 days, weekdays, 9:00 AM to 6:00 PM (UTC)', '3 days'],
    ['every 30 seconds', '30 sec'],
    ['on Fridays at 9:00 AM', 'On Fridays at 9:00 AM'],
  ])('%s → %s', (schedule, short) => {
    expect(scheduleShort(schedule)).toBe(short);
  });

  it('says nothing rather than something long or wrong', () => {
    expect(scheduleShort(null)).toBeNull();
    expect(scheduleShort('on a custom schedule that runs at odd times')).toBeNull();
    expect(scheduleShort('when an app sends an update')).toBeNull();
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
