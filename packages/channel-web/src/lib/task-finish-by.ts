/**
 * A get-done task's finish date as words (TASK-951): "Finish by Sat, Nov 14 ·
 * 9 days left" on the task page, "9 days left" on the Tasks row, the two
 * rules the date field checks before it asks the host, and the browser's own
 * time zone, which the date field sends with a date (TASK-955).
 *
 * WHY "DAYS LEFT" IS NOT THE ETA `bits.tsx` FORBIDS. That file's "Elapsed,
 * never remaining" rule is about the agent's own estimate of how long a run
 * or a check-in has to go, which nobody can know. This is a count of whole
 * days to a date the PERSON picked, so it is no estimate: it is the date,
 * restated. The host counts it (`daysLeft`, in the zone saved with the date,
 * then the schedule's, then active hours', then UTC; TASK-961), so the page,
 * the row and the check-in's brief
 * agree, and this file only words it.
 *
 * THE DATE IS A CALENDAR DAY, NEVER AN INSTANT. It is read at UTC midnight and
 * written in UTC, so the browser's own time zone can't move it a day either
 * way. Client-only: the server's helpers come from `@ax/routines-contract`.
 */
import { RoutineFinishBySchema, RoutineTimezoneSchema } from '@ax/routines-contract';
import type { TaskFinishBy } from './workspace-types';

const PICK_TODAY_OR_LATER = 'Pick today or a later date.';

/** "9 days left", "1 day left", "Due today", "1 day past its finish date", "3 days past its finish date". */
export function finishByCount(daysLeft: number): string {
  if (daysLeft === 0) return 'Due today';
  const days = Math.abs(daysLeft);
  const unit = days === 1 ? 'day' : 'days';
  return daysLeft > 0 ? `${days} ${unit} left` : `${days} ${unit} past its finish date`;
}

/** The date as the reader's language writes it, in UTC so no time zone moves the day: "Sat, Nov 14" in en-US. `locale` is for tests. */
export function finishByDate(date: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

/** "Finish by Sat, Nov 14 · 9 days left". */
export function finishByLine(finishBy: TaskFinishBy, locale?: string): string {
  return `Finish by ${finishByDate(finishBy.date, locale)} · ${finishByCount(finishBy.daysLeft)}`;
}

/** Today on the browser's own calendar, `YYYY-MM-DD` (local getters). */
export function browserToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear()).padStart(4, '0')}-${month}-${day}`;
}

/**
 * The browser's own time zone, or null when it can't tell (TASK-955). The
 * date field sends it with a date, and the host gives that calendar priority.
 * A browser that can't tell reports
 * "Etc/Unknown", which `Intl` refuses, so a zone the contract's zone rule
 * refuses here is not sent; the task's cron/active-hours zone, then UTC, is the fallback. The host would
 * drop it anyway (and log `workspace_finish_by_zone_unusable`); that warn line
 * is for a zone this browser knows and the host doesn't, not for this case.
 */
export function browserTimeZone(): string | null {
  const zone: unknown = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rule = RoutineTimezoneSchema.safeParse(zone);
  return rule.success ? rule.data : null;
}

/**
 * Why a pick can't be saved, or null. An empty field or a day before `today`
 * is told to pick today or later; anything else the contract refuses keeps the
 * contract's own words ('Pick a date.' / 'Pick a real date.'). A date input
 * never holds a day no calendar has, so that branch is a backstop.
 */
export function finishByPickIssue(value: string, today: string): string | null {
  if (value === '') return PICK_TODAY_OR_LATER;
  const rule = RoutineFinishBySchema.safeParse(value);
  if (!rule.success) return rule.error.issues[0]?.message ?? 'Pick a real date.';
  return value < today ? PICK_TODAY_OR_LATER : null;
}
