/**
 * task-meta — the couple of words a task page's meta chips show (the minimal
 * redesign, 2026-10-29): "20 min" for how often it checks in, "Nov 14 · 9 days"
 * for a finish date. Each chip carries the whole sentence in its tooltip and
 * accessible name; these are only the visible short forms.
 *
 * Built from what the page already has, never a new wire field: the schedule
 * sentence the host words (`checkInSchedule`, "every hour, 9:00 AM to 6:00 PM
 * (…)") and the finish date the host counts (TASK-951). A schedule this can't
 * shorten honestly gets no short form at all, and its chip shows the clock
 * alone: a wrong "1 hr" is worse than an icon whose tooltip says the rest.
 *
 * Pure, with relative imports only.
 */
import type { TaskFinishBy } from './workspace-types.js';

/** A chip's words past this many characters stop being a glance. */
const SHORT_MAX = 22;

const UNIT_SHORT: Record<string, [one: string, many: string]> = {
  second: ['sec', 'sec'],
  minute: ['min', 'min'],
  hour: ['hr', 'hr'],
  day: ['day', 'days'],
  week: ['wk', 'wk'],
};

/**
 * "every 20 minutes, weekdays, 9:00 AM to 6:00 PM (…)" → "20 min"; "every
 * hour" → "1 hr"; a short cron phrase ("on Fridays at 9:00 AM") → "On Fridays
 * at 9:00 AM"; anything longer, or nothing, → null.
 */
export function scheduleShort(schedule: string | null): string | null {
  if (schedule === null) return null;
  const head = (schedule.split(/[,;]/)[0] ?? '').trim();
  const every = /^every (?:(\d+) )?(second|minute|hour|day|week)s?$/.exec(head);
  if (every !== null) {
    const n = every[1] === undefined ? 1 : Number(every[1]);
    const [one, many] = UNIT_SHORT[every[2] as string] ?? ['', ''];
    return `${n} ${n === 1 ? one : many}`;
  }
  if (head === '' || head.length > SHORT_MAX) return null;
  return head[0]!.toUpperCase() + head.slice(1);
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
