/**
 * task-reading — how a task's reading reads to a person (TASK-952): its number
 * in their own locale, the earlier readings that share its label (the trend),
 * and the points of the small line that draws them.
 *
 * A reading is always the agent's: one number it reported at a check-in, with
 * the label it chose. Nothing here measures or checks it, and every surface
 * that shows one says "{agent}’s reading".
 *
 * Pure, with relative imports only: the server-side wire types live next door.
 */
import type { TaskDetailReport, TaskReading, TaskUpdate } from './workspace-types.js';

/** The most readings a task's trend draws: the page reads its newest 50 check-ins (TASK_UPDATES_LIMIT). */
export const READING_TREND_MAX = 12;

/** A reading's number for a person: up to two decimals in their own locale, never "-0". `locale` is for tests. */
export function formatReading(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, signDisplay: 'negative' }).format(
    value,
  );
}

function sameReading(a: TaskReading | null, b: TaskReading | null): boolean {
  if (a === null || b === null) return a === b;
  return a.label === b.label && a.value === b.value;
}

/**
 * The values of the readings that share the latest one's label, oldest first, at most READING_TREND_MAX, ending with
 * the latest. `updates` newest first, as the page reads them. The latest report's own check-in joins Updates only once
 * it finishes (finishDispatch writes its fire row); until the newest Updates entry with a report is that one (same
 * status, update and reading: latestUpdateCheckIn's rule), the latest is added in front, so it is in the trend once.
 * Another label is another number and stays out. No latest reading: [].
 */
export function readingTrend(
  latest: Pick<TaskDetailReport, 'status' | 'update' | 'reading'> | null,
  updates: readonly TaskUpdate[],
): number[] {
  const reading = latest?.reading ?? null;
  if (latest === null || reading === null) return [];
  const newest = updates.find((u) => u.report !== null)?.report ?? null;
  const ownIsIn =
    newest !== null &&
    newest.status === latest.status &&
    newest.update === latest.update &&
    sameReading(newest.reading, reading);
  // Newest first while collecting, so the cap keeps the newest.
  const values = ownIsIn ? [] : [reading.value];
  for (const { report } of updates) {
    if (values.length >= READING_TREND_MAX) break;
    if (report?.reading != null && report.reading.label === reading.label) {
      values.push(report.reading.value);
    }
  }
  return values.reverse();
}

function coordinate(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * A polyline's points for `values` (oldest first) in a width×height box inset by `pad`, so a 2px round-capped stroke
 * isn't clipped: lowest at the bottom, highest at the top, a flat series level through the middle, coordinates
 * rounded to 2 decimals. Fewer than two values: ''.
 */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  pad: number,
): string {
  if (values.length < 2) return '';
  // Halved first: two finite numbers at opposite ends of the double range have
  // a span that isn't finite, and stored rows aren't re-checked (TASK-913).
  const halves = values.map((v) => v / 2);
  const high = Math.max(...halves);
  const span = high - Math.min(...halves);
  const stepX = (width - 2 * pad) / (values.length - 1);
  const innerHeight = height - 2 * pad;
  return halves
    .map((v, i) => {
      const y = span === 0 ? height / 2 : pad + ((high - v) / span) * innerHeight;
      return `${coordinate(pad + i * stepX)},${coordinate(y)}`;
    })
    .join(' ');
}
