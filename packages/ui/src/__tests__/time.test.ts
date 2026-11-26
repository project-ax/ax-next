import { describe, expect, it } from 'vitest';
import { formatFullTimestamp, formatTimestamp } from '../index.js';

const tz = { timeZone: 'America/Los_Angeles', locale: 'en-US' };
// Fri Oct 23 2026, 12:00 PM PDT
const now = new Date('2026-10-23T19:00:00Z');
const rel = (v: Date | string | number, n: Date = now) => formatTimestamp(v, { ...tz, now: n });
const clock = (v: Date | string | number, n: Date = now) => formatTimestamp(v, { ...tz, now: n, style: 'clock' });
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;
const HR = 60 * MIN;

describe('formatTimestamp relative, past', () => {
  it('under a minute', () => expect(rel(ago(20_000))).toBe('just now'));
  it('under an hour', () => expect(rel(ago(5 * MIN))).toBe('5 min ago'));
  it('same day in hours', () => expect(rel(ago(3 * HR))).toBe('3 hr ago'));
  it('yesterday', () => expect(rel('2026-10-22T23:58:00Z')).toBe('Yesterday 4:58 PM'));
  it('under 7 days', () => expect(rel('2026-10-19T17:02:00Z')).toBe('Mon 10:02 AM'));
  it('same year', () => expect(rel('2026-10-10T19:00:00Z')).toBe('Oct 10'));
  it('other year', () => expect(rel('2025-10-23T19:00:00Z')).toBe('Oct 23, 2025'));
  it('exactly 7 days back is a date, not a weekday', () => expect(rel('2026-10-16T19:00:00Z')).toBe('Oct 16'));
});

describe('formatTimestamp relative, future', () => {
  it('under an hour', () => expect(rel(new Date(now.getTime() + 5 * MIN))).toBe('in 5 min'));
  it('under a minute reads as 1 min', () => expect(rel(new Date(now.getTime() + 10_000))).toBe('in 1 min'));
  it('same day', () => expect(rel('2026-10-24T00:00:00Z')).toBe('Today 5:00 PM'));
  it('tomorrow', () => expect(rel('2026-10-24T16:00:00Z')).toBe('Tomorrow 9:00 AM'));
  it('under 7 days', () => expect(rel('2026-10-26T17:02:00Z')).toBe('Mon 10:02 AM'));
  it('later, same year', () => expect(rel('2026-11-23T19:00:00Z')).toBe('Nov 23'));
  it('later, other year', () => expect(rel('2027-01-05T19:00:00Z')).toBe('Jan 5, 2027'));
});

describe('day boundaries follow the zone calendar', () => {
  it('23:59 yesterday is Yesterday, not "1 min ago"', () => {
    const n = new Date('2026-10-23T07:00:30Z'); // 12:00:30 AM PDT
    expect(rel('2026-10-23T06:59:00Z', n)).toBe('Yesterday 11:59 PM');
  });
  it('just after midnight still counts the same day for minutes', () => {
    const n = new Date('2026-10-23T07:30:00Z'); // 12:30 AM
    expect(rel('2026-10-23T07:10:00Z', n)).toBe('20 min ago');
  });
  it('the same instant lands on different days in different zones', () => {
    const n = new Date('2026-10-22T20:00:00Z');
    const v = '2026-10-22T10:00:00Z';
    expect(formatTimestamp(v, { now: n, timeZone: 'UTC', locale: 'en-US' })).toBe('10 hr ago');
    expect(formatTimestamp(v, { now: n, timeZone: 'Pacific/Auckland', locale: 'en-US' })).toBe('Yesterday 11:00 PM');
  });
  it('future across midnight reads Tomorrow, not Today', () => {
    const n = new Date('2026-10-23T06:30:00Z'); // 11:30 PM PDT Oct 22
    expect(rel('2026-10-23T08:00:00Z', n)).toBe('Tomorrow 1:00 AM');
  });
  it('DST end day (Nov 1, 2026, 25 hours long)', () => {
    // 12:05 AM PST Nov 2; value 12:10 AM PDT Nov 1 is 24h55m earlier, still just yesterday.
    expect(rel('2026-11-01T07:10:00Z', new Date('2026-11-02T08:05:00Z'))).toBe('Yesterday 12:10 AM');
    // 11:30 PM PST Nov 1 seen from 12:10 AM PST Nov 2
    expect(rel('2026-11-02T07:30:00Z', new Date('2026-11-02T08:10:00Z'))).toBe('Yesterday 11:30 PM');
    // Oct 31 vs Nov 2 is two days: weekday form
    expect(rel('2026-10-31T07:10:00Z', new Date('2026-11-02T08:05:00Z'))).toBe('Sat 12:10 AM');
  });
  it('DST start day (Mar 8, 2026, 23 hours long)', () => {
    expect(rel('2026-03-08T08:30:00Z', new Date('2026-03-09T07:30:00Z'))).toBe('Yesterday 12:30 AM');
  });
});

describe('bad input', () => {
  it('returns null for unparseable values', () => {
    expect(rel('not a date')).toBeNull();
    expect(rel(NaN)).toBeNull();
    expect(rel(new Date('nope'))).toBeNull();
    expect(clock('not a date')).toBeNull();
    expect(formatFullTimestamp('not a date')).toBeNull();
  });
  it('accepts numbers and Dates', () => {
    expect(rel(now.getTime() - 5 * MIN)).toBe('5 min ago');
    expect(rel(ago(5 * MIN))).toBe('5 min ago');
  });
});

describe('formatTimestamp clock', () => {
  it('today', () => expect(clock('2026-10-24T02:13:00Z')).toBe('7:13 PM'));
  it('under 7 days', () => expect(clock('2026-10-21T02:13:00Z')).toBe('Tue 7:13 PM'));
  it('7 days back is a date', () => expect(clock('2026-10-17T02:13:00Z')).toBe('Oct 16'));
  it('older, same year', () => expect(clock('2026-09-02T19:00:00Z')).toBe('Sep 2'));
  it('older, other year', () => expect(clock('2025-10-23T19:00:00Z')).toBe('Oct 23, 2025'));
  it('future within a week', () => expect(clock('2026-10-26T17:02:00Z')).toBe('Mon 10:02 AM'));
});

describe('formatFullTimestamp', () => {
  it('exact string', () => expect(formatFullTimestamp('2026-10-24T02:13:00Z', tz)).toBe('Fri, Oct 23, 2026, 7:13 PM'));
});
