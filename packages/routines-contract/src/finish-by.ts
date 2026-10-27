import { z } from 'zod';
import type { ActiveHours, RoutineSchedule } from './definition.js';

/*
 * A "get-done" task's finish date (TASK-951).
 *
 * A person sets it, on the task's page, through `routines:set-finish-by`. No
 * tool or IPC action reaches it, so no model can set or change it. It is a
 * calendar date, `YYYY-MM-DD`, never an instant: "finish by 14 November" names
 * a day on the task's calendar, at no time of day.
 *
 * The rule is checked only where the date is written. A read refuses quietly
 * instead (TASK-913): a stored value the rule refuses reads as no date, so a
 * hand edit or a later version can't make a read throw.
 *
 * There is no "not in the past" rule. Read paths revalidate, so a rule that
 * moved with the clock would make a saved date unreadable once its day had
 * passed (TASK-906). A date in the past is a late task, and its brief says so.
 *
 * One calendar is shared by the brief, the Tasks row and the task page, so the
 * agent and the person count the same days: the task's own time zone, else the
 * one its date was set from (`taskTimeZone`), the date there
 * (`calendarDateIn`), and whole days between two dates (`calendarDaysBetween`).
 */

export const ROUTINE_FINISH_BY_EARLIEST = '2000-01-01';
export const ROUTINE_FINISH_BY_LATEST = '2100-12-31';

/** `YYYY-MM-DD`. A regex's `\d` matches ASCII digits only, never another script's. */
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/**
 * `date`'s UTC midnight, in milliseconds, or NaN unless it is `YYYY-MM-DD` and
 * a day the calendar has. `Date.UTC` rolls 30 February over into March, so the
 * year, month and day must come back as they went in.
 */
function utcMidnight(date: string): number {
  const match = CALENDAR_DATE.exec(date);
  if (match === null) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day ? at.getTime() : NaN;
}

/** A finish date: `YYYY-MM-DD`, a real calendar date, 2000-01-01 to 2100-12-31. One issue, never a clock rule. */
export const RoutineFinishBySchema = z.string().superRefine((value, ctx) => {
  if (!CALENDAR_DATE.test(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pick a date.' });
    return;
  }
  // The range first, compared as strings: both sides are `YYYY-MM-DD`, so that
  // order is the calendar's. The year is then 2000 to 2100, so `Date.UTC`'s
  // reading of years 0 to 99 as 1900 to 1999 never applies.
  if (value < ROUTINE_FINISH_BY_EARLIEST || value > ROUTINE_FINISH_BY_LATEST || Number.isNaN(utcMidnight(value))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pick a real date.' });
  }
});

/**
 * The time zone a task's calendar runs on, in four steps: its cron's, else its
 * active hours', else the zone its finish date was set from, else 'UTC'. A
 * cron's times are written in its own zone. An interval has no zone, so the
 * active hours', the hours of the person's day, come next. A task with neither
 * counts on the calendar of the person who set the date (TASK-955): the zone
 * their browser reported with it, stored beside it (`finishByTimeZone`).
 *
 * The task's own zone wins when the two differ (TASK-955 decisions row 2), so a
 * check-in's "today" is always the day its own schedule is on, and a task that
 * has a zone counts as it did before TASK-955. `finishByTimeZone` is required,
 * not optional: a caller that doesn't pass the stored zone fails to compile
 * rather than quietly counting in UTC. Callers pass a zone the contract's rule
 * (`RoutineTimezoneSchema`) accepted on this runtime, or null.
 */
export function taskTimeZone(row: { schedule: RoutineSchedule | null; activeHours: ActiveHours | null; finishByTimeZone: string | null }): string {
  if (row.schedule?.kind === 'cron') return row.schedule.tz;
  return row.activeHours?.tz ?? row.finishByTimeZone ?? 'UTC';
}

/**
 * `at`'s calendar date in `tz`, `YYYY-MM-DD`. The locale is fixed, never the
 * host's, so the digits and the parts read back are always the same ones. An
 * invalid zone throws `RangeError`; callers pass zones `RoutineTimezoneSchema`
 * already accepted on the same runtime.
 */
export function calendarDateIn(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const part = (type: 'year' | 'month' | 'day'): string => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Whole calendar days from `from` to `to` (both `YYYY-MM-DD`): 0 on the same
 * day, negative when `to` is earlier. Two UTC midnights are always a whole
 * number of days apart, since UTC has no daylight saving, so a 23- or 25-hour
 * day in the task's zone still counts as one. NaN when either isn't a real
 * date, never the count to a day it would roll over to.
 */
export function calendarDaysBetween(from: string, to: string): number {
  return (utcMidnight(to) - utcMidnight(from)) / DAY_MS;
}

/** `calendarDaysBetween(calendarDateIn(at, tz), finishBy)`. */
export function calendarDaysUntil(finishBy: string, at: Date, tz: string): number {
  return calendarDaysBetween(calendarDateIn(at, tz), finishBy);
}
