/**
 * task-meta — the couple of words a task page's meta chips show (the minimal
 * redesign, 2026-10-29): "20 min" for how often it checks in, "Nov 14 · 9 days"
 * for a finish date. Each chip carries the whole sentence in its tooltip and
 * accessible name; these are only the visible short forms.
 *
 * Built from what the page already has, never a new wire field: the schedule
 * sentence the host words (`checkInSchedule`, "every hour, 9:00 AM to 6:00 PM
 * (…)") and the finish date the host counts (TASK-951). A schedule with no
 * stride to say (a cron at fixed times) gets no short form at all, and its chip
 * shows the clock alone: a wrong "1 hr" is worse than an icon whose tooltip
 * says the rest.
 *
 * Pure, with relative imports only.
 */
import type { TaskFinishBy } from './workspace-types.js';

const SECOND = 1;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const UNIT_SECONDS: Record<string, number> = { second: SECOND, minute: MINUTE, hour: HOUR, day: DAY, week: WEEK };

/** A stride in seconds as the chip says it, in the largest unit it divides evenly: 86400 → "1 day". */
function strideWords(seconds: number): string {
  if (seconds % WEEK === 0) return `${seconds / WEEK} wk`;
  if (seconds % DAY === 0) {
    const n = seconds / DAY;
    return `${n} ${n === 1 ? 'day' : 'days'}`;
  }
  if (seconds % HOUR === 0) return `${seconds / HOUR} hr`;
  if (seconds % MINUTE === 0) return `${seconds / MINUTE} min`;
  return `${seconds} sec`;
}

/**
 * How often, in a word or two, from the schedule sentence `checkInSchedule`
 * (`lib/task-schedule.ts`) builds for the wire. Every shape it emits starts
 * with its phrase, then maybe a time zone, an active-hours suffix and an app
 * trigger:
 *
 * - an interval: "every hour", "every 15 minutes", "every 2 days";
 * - a cron stride (`describeCronPhrase`): "every minute (Zone)", "every 15
 *   minutes (Zone)", "every 2 hours (Zone)";
 * - a cron at fixed times: "at 9:00 AM, every weekday (Zone)", "at 2:00 AM on
 *   the 1st of each month (Zone)", "on a custom schedule";
 * - then ", weekdays, 9:00 AM to 6:00 PM (Zone)" or ", after active hours are
 *   repaired", and "; also when an app sends an update".
 *
 * A stride becomes "15 min", "1 hr", "1 day" ("every 24 hours" too); a fixed
 * time has no stride to say, so it's null, and the chip shows its clock alone
 * with the whole sentence in its tooltip.
 */
export function scheduleShort(schedule: string | null): string | null {
  if (schedule === null) return null;
  const every = /^every (?:(\d+) )?(second|minute|hour|day|week)s?\b/.exec(schedule.trim());
  if (every === null) return null;
  const n = every[1] === undefined ? 1 : Number(every[1]);
  const unit = UNIT_SECONDS[every[2] as string];
  if (unit === undefined || !Number.isSafeInteger(n) || n <= 0) return null;
  return strideWords(n * unit);
}

/** "Nov 14" in the reader's language, read in UTC so no zone moves the day (`finishByDate`'s rule). `locale` is for tests. */
function shortDate(date: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/** "Nov 14 · 9 days", "Nov 14 · 1 day", "Nov 14 · today", "Nov 14 · 3 days late". */
export function finishByShort(finishBy: TaskFinishBy, locale?: string): string {
  const { daysLeft } = finishBy;
  const days = Math.abs(daysLeft);
  const count = daysLeft === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'}${daysLeft < 0 ? ' late' : ''}`;
  return `${shortDate(finishBy.date, locale)} · ${count}`;
}
