/**
 * The formatters themselves, at their edges.
 *
 * `relativeDay` crossed the wire in TASK-435 — it used to run on the server,
 * where nothing tested it, and it now runs in the reader's browser. Moving code
 * from a machine nobody looks at to a machine everybody looks at is exactly
 * when its boundaries stop being academic: "today" versus "yesterday" is now a
 * claim about the READER's calendar, and it is decided by two `Date` objects
 * that can sit either side of a local midnight.
 *
 * Every case here pins BOTH arguments, so nothing depends on when the suite
 * runs, and the day-boundary cases are stated in local wall-clock time
 * (`new Date(y, m, d, …)`) rather than as ISO instants — a UTC instant would be
 * a different calendar day for half the readers on earth, which is the bug this
 * module exists to stop making.
 */
import { describe, expect, it } from 'vitest';
import {
  checkInWhen,
  compactStamp,
  fullStamp,
  localDayKey,
  localDayLabel,
  localTime,
  monthDay,
  relativeDay,
  timeAgo,
  updateStamp,
} from '../workspace-time';

describe('checkInWhen / updateStamp', () => {
  const now = new Date(2026, 9, 22, 12, 0);
  const at = (d: Date): string => localTime(d.toISOString()) as string;
  const day = (offset: number, h = 10, min = 2): Date =>
    new Date(2026, 9, 22 + offset, h, min);

  it('says when a check-in was or will be, on the reader’s calendar', () => {
    expect(checkInWhen(day(0).toISOString(), now)).toBe(`at ${at(day(0))}`);
    expect(checkInWhen(day(1, 9, 0).toISOString(), now)).toBe(`tomorrow at ${at(day(1, 9, 0))}`);
    expect(checkInWhen(day(-1, 16, 58).toISOString(), now)).toBe(
      `yesterday at ${at(day(-1, 16, 58))}`,
    );
    const later = day(4);
    const label = later.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    expect(checkInWhen(later.toISOString(), now)).toBe(`on ${label} at ${at(later)}`);
    expect(checkInWhen('nope', now)).toBeNull();
  });

  it('stamps an update with its time, and its day when that isn’t today', () => {
    expect(updateStamp(day(0).toISOString(), now)).toBe(at(day(0)));
    expect(updateStamp(day(-1).toISOString(), now)).toBe(`Yesterday, ${at(day(-1))}`);
    expect(updateStamp('nope', now)).toBeNull();
  });
});

/** Local wall-clock, so the assertions mean the same thing in any zone. */
const local = (
  y: number,
  m: number,
  d: number,
  h = 12,
  min = 0,
): Date => new Date(y, m, d, h, min);

describe('localTime', () => {
  it('is null rather than "Invalid Date" on something unparseable', () => {
    // The live streaming frame carries `at: ''` until the turn commits, and a
    // renderer keys off this null to draw no clock row at all.
    expect(localTime('')).toBeNull();
    expect(localTime('the day before yesterday')).toBeNull();
  });

  it('reads an instant on the READER\'s clock, not UTC', () => {
    /*
      THE MINUTES ARE THE ASSERTION, and they are why this is not the
      tautology it would otherwise be. Comparing `localTime(iso)` against an
      inline re-run of the same `toLocaleTimeString` call would be `f(x) ===
      f(x)` — green in every zone, including the broken one.

      So the zone is pinned to one with a HALF-HOUR offset. `00:56Z` read from
      Kolkata is `6:26`, and 26 ≠ 56: the minute field alone proves the offset
      was applied. Minutes are also the one field no common locale renders
      differently, so this stays honest on a 24-hour runner where the hour
      would read `06` instead of `6`.
    */
    const saved = process.env.TZ;
    process.env.TZ = 'Asia/Kolkata';
    try {
      const out = localTime('2026-09-19T00:56:00.000Z');
      expect(out).not.toBeNull();
      expect(out).toMatch(/\b6:26\b/);
      expect(out).not.toContain('56');
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe('localDayKey / localDayLabel', () => {
  it('buckets two instants on the same local day together, and midnight apart', () => {
    const morning = local(2026, 8, 19, 9, 15);
    const evening = local(2026, 8, 19, 23, 59);
    const justAfter = local(2026, 8, 20, 0, 1);
    expect(localDayKey(morning)).toBe(localDayKey(evening));
    expect(localDayKey(evening)).not.toBe(localDayKey(justAfter));
  });

  it('says Today and Yesterday relative to the reader\'s own day', () => {
    const now = local(2026, 8, 19, 10, 0);
    expect(localDayLabel(local(2026, 8, 19, 23, 59), now)).toBe('Today');
    expect(localDayLabel(local(2026, 8, 18, 0, 1), now)).toBe('Yesterday');
    // Anything older is a plain date rather than an ever-growing "N days ago",
    // which stops being readable somewhere around four.
    expect(localDayLabel(local(2026, 8, 14, 12, 0), now)).not.toMatch(
      /Today|Yesterday/,
    );
  });
});

describe('relativeDay', () => {
  const now = local(2026, 8, 19, 10, 0);

  it('answers on CALENDAR days, not elapsed hours', () => {
    // Ninety minutes apart, and on opposite sides of local midnight. An
    // elapsed-time implementation would call the second one "today".
    expect(relativeDay(local(2026, 8, 19, 0, 30).toISOString(), now)).toBe('today');
    expect(relativeDay(local(2026, 8, 18, 23, 0).toISOString(), now)).toBe(
      'yesterday',
    );
  });

  it('walks its buckets in order', () => {
    const ago = (days: number): string =>
      relativeDay(local(2026, 8, 19 - days, 12, 0).toISOString(), now);
    expect(ago(3)).toBe('3 days ago');
    expect(ago(6)).toBe('6 days ago');
    expect(ago(7)).toBe('last week');
    expect(ago(14)).toBe('2 weeks ago');
    expect(ago(90)).toBe('3 months ago');
    expect(ago(400)).toBe('over a year ago');
  });

  it('does not report a future instant as a number of days ago', () => {
    // Clock skew between the host that stamped the row and the reader looking
    // at it is ordinary, and "-1 days ago" is not a thing to put on screen.
    expect(relativeDay(local(2026, 8, 20, 12, 0).toISOString(), now)).toBe('today');
  });

  it('says something honest about an instant it cannot read', () => {
    expect(relativeDay('', now)).toBe('a while ago');
    expect(relativeDay('not a date', now)).toBe('a while ago');
  });
});

// An invalid date formerly threw while rendering the conversation rail.
describe('conversationDate', () => {
  it('keeps an unreadable date from crashing the conversation', async () => {
    const { conversationDate } = await import('../workspace-time');
    expect(conversationDate('not-a-date')).toBe('Unknown');
    expect(conversationDate('')).toBe('Unknown');
    expect(conversationDate('2026-08-18T12:00:00Z')).toMatch(/18/);
  });
});

// Slice 4 — "Signed in by you on 7 Oct". One day-and-month helper for every
// surface (the grant line's private `grantedDay` folded into it).
describe('shortDay', () => {
  const ISO = '2026-10-07T12:00:00.000Z';

  it('English: day then month, whichever order the locale would pick', async () => {
    const { shortDay } = await import('../workspace-time');
    // en-US alone would say "Oct 7"; the English copy reads "on 7 Oct".
    expect(shortDay(ISO, 'en-US')).toBe('7 Oct');
    expect(shortDay(ISO, 'en-GB')).toBe('7 Oct');
  });

  it("every other language keeps its own native short date", async () => {
    const { shortDay } = await import('../workspace-time');
    expect(shortDay(ISO, 'de')).toBe(new Intl.DateTimeFormat('de', { day: 'numeric', month: 'short' }).format(new Date(ISO)));
    expect(shortDay(ISO, 'de')).toMatch(/^7\. Okt/);
    // Never "7 10月": the parts must not be re-glued in English order.
    expect(shortDay(ISO, 'ja')).toBe('10月7日');
    expect(shortDay(ISO, 'zh')).toBe('10月7日');
  });

  it('reads the instant on the READER\'s calendar', async () => {
    const { shortDay } = await import('../workspace-time');
    const saved = process.env.TZ;
    // 23:30Z on the 7th is already the 8th in Kolkata (+5:30).
    process.env.TZ = 'Asia/Kolkata';
    try {
      expect(shortDay('2026-10-07T23:30:00.000Z', 'en-GB')).toBe('8 Oct');
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('is empty on an instant it cannot read, never "Invalid Date"', async () => {
    const { shortDay } = await import('../workspace-time');
    expect(shortDay('')).toBe('');
    expect(shortDay('not-a-date')).toBe('');
  });
});

// TASK-909 — the Tasks page's "checked 4 min ago". Minutes and hours are
// ELAPSED time, floored; from 24 hours on it is `relativeDay`'s calendar days.
describe('timeAgo', () => {
  const now = local(2026, 9, 22, 12, 0);
  const before = (ms: number): string => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000;

  it('says just now under a minute, and for a clock a little ahead', () => {
    expect(timeAgo(before(30_000), now)).toBe('just now');
    // The host stamped the report; the reader's clock may trail it a little.
    expect(timeAgo(before(-10_000), now)).toBe('just now');
  });

  it('counts minutes, then hours', () => {
    expect(timeAgo(before(MIN), now)).toBe('1 min ago');
    expect(timeAgo(before(4 * MIN), now)).toBe('4 min ago');
    expect(timeAgo(before(59 * MIN), now)).toBe('59 min ago');
    expect(timeAgo(before(60 * MIN), now)).toBe('1 hr ago');
    // Floored: 23 h 59 min is not yet "24 hr", and not yet a calendar day either.
    expect(timeAgo(before((23 * 60 + 59) * MIN), now)).toBe('23 hr ago');
  });

  it('hands a day or more to relativeDay', () => {
    expect(timeAgo(local(2026, 9, 21, 9, 0).toISOString(), now)).toBe('yesterday');
    expect(timeAgo(local(2026, 9, 18, 12, 0).toISOString(), now)).toBe('4 days ago');
  });

  it('answers null for an instant it cannot read', () => {
    // The row then shows no time at all, never "Invalid Date".
    expect(timeAgo('', now)).toBeNull();
    expect(timeAgo('not a date', now)).toBeNull();
  });
});

/**
 * The task page's compact row stamps (2026-10-29). Every case runs in a pinned
 * zone, with both instants as UTC strings, so the reader's calendar is the
 * only thing deciding today, the last six days and older.
 */
describe('compactStamp, fullStamp and monthDay', () => {
  function inZone(tz: string, run: () => void) {
    const saved = process.env.TZ;
    process.env.TZ = tz;
    try {
      run();
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  }

  it('today is the time, the six days before are the weekday and the time, older is the month and day', () => {
    inZone('America/New_York', () => {
      const now = new Date('2026-10-30T16:00:00.000Z'); // Fri Oct 30, 12:00 PM
      expect(compactStamp('2026-10-30T13:05:00.000Z', now, 'en-US')).toBe('9:05 AM');
      expect(compactStamp('2026-10-29T23:13:00.000Z', now, 'en-US')).toBe('Thu 7:13 PM');
      expect(compactStamp('2026-10-24T14:00:00.000Z', now, 'en-US')).toBe('Sat 10:00 AM');
      // Seven days back is a date, not a weekday that would read as this week's.
      expect(compactStamp('2026-10-23T14:00:00.000Z', now, 'en-US')).toBe('Oct 23');
      // A stamp ahead of today (a reader's clock behind the host's) is a date too.
      expect(compactStamp('2026-10-31T14:00:00.000Z', now, 'en-US')).toBe('Oct 31');
    });
  });

  it('decides the day on the reader’s calendar, not UTC’s', () => {
    // 03:30Z on the 30th is still the 29th in Los Angeles, and already the 30th in Kolkata.
    const now = new Date('2026-10-30T18:00:00.000Z');
    inZone('America/Los_Angeles', () => {
      expect(compactStamp('2026-10-30T03:30:00.000Z', now, 'en-US')).toBe('Thu 8:30 PM');
    });
    inZone('Asia/Kolkata', () => {
      expect(compactStamp('2026-10-30T03:30:00.000Z', now, 'en-US')).toBe('9:00 AM');
    });
  });

  it('a clock change in between still counts calendar days', () => {
    // US clocks go back on Sun Nov 1 2026: that day is 25 hours long.
    inZone('America/Los_Angeles', () => {
      const now = new Date('2026-11-07T08:30:00.000Z'); // Sat Nov 7, 12:30 AM PST
      expect(compactStamp('2026-11-01T07:30:00.000Z', now, 'en-US')).toBe('Sun 12:30 AM');
      expect(compactStamp('2026-10-31T07:30:00.000Z', now, 'en-US')).toBe('Oct 31');
    });
  });

  it('fullStamp says the whole date for hidden text and the tooltip; monthDay is finishByShort’s form', () => {
    inZone('America/New_York', () => {
      expect(fullStamp('2026-10-23T23:13:00.000Z', 'en-US')).toBe('Fri, Oct 23, 2026, 7:13 PM');
      expect(monthDay('2026-10-25T15:00:00.000Z', 'en-US')).toBe('Oct 25');
    });
  });

  it('an instant it can’t read gives no stamp, never Invalid Date', () => {
    expect(compactStamp('nope', new Date())).toBeNull();
    expect(fullStamp('nope')).toBeNull();
    expect(monthDay('nope')).toBe('');
  });
});
