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
  localDayKey,
  localDayLabel,
  localTime,
  relativeDay,
} from '../workspace-time';

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
