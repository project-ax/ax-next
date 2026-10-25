/**
 * A get-done task's finish date as words (TASK-951): the count, the date and
 * the line, and the two rules the date field checks before it asks the host.
 * And the browser's own time zone, which the date field sends with a date
 * (TASK-955).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  browserTimeZone,
  browserToday,
  finishByCount,
  finishByDate,
  finishByLine,
  finishByPickIssue,
} from '../task-finish-by';

describe('finishByCount', () => {
  it.each<[number, string]>([
    [9, '9 days left'],
    [1, '1 day left'],
    [0, 'Due today'],
    [-1, '1 day past its finish date'],
    [-3, '3 days past its finish date'],
  ])('words %i as %s', (daysLeft, words) => {
    expect(finishByCount(daysLeft)).toBe(words);
  });
});

describe('finishByDate', () => {
  it('writes the date in the reader’s language', () => {
    expect(finishByDate('2026-11-14', 'en-US')).toBe('Sat, Nov 14');
  });

  it('keeps the day whatever time zone the browser is in', () => {
    const saved = process.env.TZ;
    // How the browser itself reads UTC midnight, so each flip is shown to have taken.
    const host = (): number => new Date('2026-11-14T00:00:00Z').getDate();
    try {
      // UTC+14 reads UTC midnight of the 14th as the 14th at 14:00.
      process.env.TZ = 'Pacific/Kiritimati';
      expect(host(), 'the browser moved to UTC+14').toBe(14);
      expect(finishByDate('2026-11-14', 'en-US')).toBe('Sat, Nov 14');
      // UTC-11 reads the same instant as the 13th: a local read would say Fri, Nov 13.
      process.env.TZ = 'Pacific/Pago_Pago';
      expect(host(), 'the browser moved to UTC-11').toBe(13);
      expect(finishByDate('2026-11-14', 'en-US')).toBe('Sat, Nov 14');
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe('finishByLine', () => {
  it('puts the date and the count on one line', () => {
    expect(finishByLine({ date: '2026-11-14', daysLeft: 9 }, 'en-US')).toBe(
      'Finish by Sat, Nov 14 · 9 days left',
    );
  });
});

describe('browserToday', () => {
  it('is the browser’s own calendar day, to the last minute of it', () => {
    expect(browserToday(new Date(2026, 10, 5, 23, 59))).toBe('2026-11-05');
    expect(browserToday(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
});

describe('browserTimeZone (TASK-955)', () => {
  it('is the time zone the browser reports', () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      // How the browser itself reports it, so the flip is shown to have taken.
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone, 'the browser moved to Los Angeles').toBe(
        'America/Los_Angeles',
      );
      expect(browserTimeZone()).toBe('America/Los_Angeles');
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  // A browser that can't tell its zone reports "Etc/Unknown", which Intl refuses: sent, it would
  // make every save fail, so it isn't sent at all.
  it.each<[string, string | undefined]>([
    ['Etc/Unknown', 'Etc/Unknown'],
    ['an empty zone', ''],
    ['no zone at all', undefined],
  ])('is null when the browser can’t tell its zone (%s)', (_what, reported) => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...real.call(this), timeZone: reported } as Intl.ResolvedDateTimeFormatOptions;
      });
    try {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone, 'the browser reports that').toBe(reported);
      expect(browserTimeZone()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('finishByPickIssue', () => {
  it('refuses an empty pick and a day that has gone', () => {
    expect(finishByPickIssue('', '2026-11-05')).toBe('Pick today or a later date.');
    expect(finishByPickIssue('2026-11-04', '2026-11-05')).toBe('Pick today or a later date.');
  });

  it('takes today and later', () => {
    expect(finishByPickIssue('2026-11-05', '2026-11-05')).toBeNull();
    expect(finishByPickIssue('2027-01-01', '2026-11-05')).toBeNull();
  });

  it('gives the contract’s own words for a date no calendar has, or one out of range', () => {
    expect(finishByPickIssue('2026-02-30', '2026-01-01')).toBe('Pick a real date.');
    expect(finishByPickIssue('2101-01-01', '2026-01-01')).toBe('Pick a real date.');
  });
});
