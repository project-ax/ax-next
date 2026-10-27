import { describe, expect, it, vi } from 'vitest';
import { advanceToNextActiveWindow } from '../active-hours.js';

describe('advanceToNextActiveWindow', () => {
  const ah = { start: '08:00', end: '24:00', tz: 'America/New_York' };

  it('returns the candidate when it falls inside the window', () => {
    // 2026-05-14 14:00 NYC = 18:00Z (EDT).
    const candidate = new Date('2026-05-14T18:00:00Z');
    const adjusted = advanceToNextActiveWindow(candidate, ah);
    expect(adjusted.toISOString()).toBe(candidate.toISOString());
  });

  it('shifts a candidate before the start to the day start', () => {
    // 2026-05-14 03:00 NYC = 07:00Z. Before 08:00 start.
    const candidate = new Date('2026-05-14T07:00:00Z');
    const adjusted = advanceToNextActiveWindow(candidate, ah);
    // 2026-05-14 08:00 NYC = 12:00Z.
    expect(adjusted.toISOString()).toBe('2026-05-14T12:00:00.000Z');
  });

  it('shifts a candidate after the end to the next day start', () => {
    // end = 24:00 means "midnight" — so 24:00 NYC = 04:00Z (next day).
    // Candidate 2026-05-15 05:00Z (= 2026-05-15 01:00 NYC, past midnight) →
    // shift to 2026-05-15 08:00 NYC = 12:00Z.
    const candidate = new Date('2026-05-15T05:00:00Z');
    const adjusted = advanceToNextActiveWindow(candidate, ah);
    expect(adjusted.toISOString()).toBe('2026-05-15T12:00:00.000Z');
  });
});

describe('selected active days, overnight windows and real local time', () => {
  const overnight = { start: '22:00', end: '06:00', tz: 'UTC' };
  const monday = { ...overnight, days: ['mon'] as const };
  const shifted = (at: string, hours: Parameters<typeof advanceToNextActiveWindow>[1]) =>
    advanceToNextActiveWindow(new Date(at), hours)?.toISOString() ?? null;

  it.each([
    ['2026-10-26T22:00:00.000Z', '2026-10-26T22:00:00.000Z'],
    ['2026-10-26T23:59:59.123Z', '2026-10-26T23:59:59.123Z'],
    ['2026-10-27T05:59:59.999Z', '2026-10-27T05:59:59.999Z'],
    ['2026-10-27T06:00:00.000Z', '2026-11-02T22:00:00.000Z'],
    ['2026-10-27T22:00:00.000Z', '2026-11-02T22:00:00.000Z'],
  ])('uses the overnight window start day at %s', (at, expected) => {
    expect(shifted(at, monday)).toBe(expected);
  });

  it('carries a Sunday window into an unselected Monday', () => {
    expect(shifted('2026-10-26T01:00:00.000Z', { ...overnight, days: ['sun'] }))
      .toBe('2026-10-26T01:00:00.000Z');
  });

  it('skips the weekend and treats the end as exclusive', () => {
    expect(shifted('2026-10-30T17:00:00.000Z', {
      start: '09:00', end: '17:00', tz: 'UTC', days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    })).toBe('2026-11-02T09:00:00.000Z');
  });

  it('interprets selected weekdays in the hours timezone rather than UTC', () => {
    expect(shifted('2026-10-26T00:30:00.000Z', {
      start: '20:00', end: '21:00', tz: 'America/New_York', days: ['mon'],
    })).toBe('2026-10-27T00:00:00.000Z');
  });

  it('keeps overnight hours on every day when days is omitted', () => {
    expect(shifted('2026-10-27T02:03:04.567Z', overnight)).toBe('2026-10-27T02:03:04.567Z');
  });

  it.each([
    [{ start: '02:30', end: '04:00', tz: 'America/New_York', days: ['sun'] }, '2026-03-08T06:59:00.000Z', '2026-03-08T07:00:00.000Z'],
    [{ start: '02:30', end: '02:45', tz: 'America/New_York', days: ['sun'] }, '2026-03-08T06:59:00.000Z', '2026-03-15T06:30:00.000Z'],
    [{ start: '01:10', end: '01:20', tz: 'America/New_York', days: ['sun'] }, '2026-11-01T05:30:00.000Z', '2026-11-01T06:10:00.000Z'],
    [{ start: '22:00', end: '03:30', tz: 'America/New_York', days: ['sat'] }, '2026-03-08T07:15:01.456Z', '2026-03-08T07:15:01.456Z'],
    [{ start: '22:00', end: '03:00', tz: 'America/New_York', days: ['sat'] }, '2026-11-01T05:15:00.000Z', '2026-11-01T05:15:00.000Z'],
    [{ start: '22:00', end: '03:00', tz: 'America/New_York', days: ['sat'] }, '2026-11-01T06:15:00.000Z', '2026-11-01T06:15:00.000Z'],
  ])('finds a real runnable DST candidate %#', (hours, at, expected) => {
    const candidate = new Date(at);
    const next = advanceToNextActiveWindow(candidate, hours);
    expect(next?.toISOString()).toBe(expected);
    expect(next!.getTime()).toBeGreaterThanOrEqual(candidate.getTime());
    expect(advanceToNextActiveWindow(next!, hours)).toBe(next);
  });

  it('does not invent a next check for a historical empty window', () => {
    expect(shifted('2026-10-26T10:00:00.000Z', { start: '09:00', end: '09:00', tz: 'UTC' })).toBeNull();
  });
});

describe('bounded repeated active-window reads', () => {
  it('isolates restrictions in the key and keeps the memo bounded', () => {
    const hours = { start: '03:00', end: '04:00', tz: 'UTC' };
    const first = new Date('2040-01-01T00:00:00Z');
    for (let index = 0; index < 130; index++)
      advanceToNextActiveWindow(new Date(first.getTime() + index * 60_000), hours);
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      expect(advanceToNextActiveWindow(first, hours)?.toISOString()).toBe('2040-01-01T03:00:00.000Z');
      expect(spy.mock.calls.length).toBeGreaterThan(1);
      expect(advanceToNextActiveWindow(first, { ...hours, start: '04:00', end: '05:00' })?.toISOString())
        .toBe('2040-01-01T04:00:00.000Z');
    } finally { spy.mockRestore(); }
  });
  it('reuses the same outside-window minute without caching a mutable Date', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      const hours = { start: '19:13', end: '19:14', tz: 'UTC', days: ['wed'] as ['wed'] };
      const first = advanceToNextActiveWindow(new Date('2026-10-26T14:00:01Z'), hours)!;
      expect(first.toISOString()).toBe('2026-10-28T19:13:00.000Z');
      expect(spy.mock.calls.length).toBeGreaterThan(1000);
      first.setTime(0);
      spy.mockClear();
      expect(advanceToNextActiveWindow(new Date('2026-10-26T14:00:40Z'), hours)?.toISOString())
        .toBe('2026-10-28T19:13:00.000Z');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
});
