import { formatFullTimestamp, formatTimestamp } from '@project-ax/ui';

/**
 * A moment inside a sentence ("Next check Today 1:00 PM", "Check-in Mon 10:02 AM").
 *
 * The relative form is enough while it carries a time ("5 min ago", "in 20 min",
 * "Yesterday 4:58 PM", "Mon 10:02 AM"). A week or more away it drops to a bare date
 * ("Oct 13"), which loses the time of day and tells two check-ins on one day apart
 * no longer, so those fall back to the whole stamp ("Tue, Oct 13, 2026, 10:02 AM").
 * `null` for a value that is not a time.
 */
export function momentWords(value: Date | string | number, now: Date): string | null {
  const relative = formatTimestamp(value, { now });
  if (relative === null) return null;
  // The clock form always carries the time of day, so a relative form that is the clock form's date alone
  // ("Oct 13" vs "Oct 13, 10:02 AM") is a bare date.
  const clock = formatTimestamp(value, { now, format: 'clock' }) ?? '';
  const bareDate = clock !== relative && clock.startsWith(relative);
  return bareDate ? formatFullTimestamp(value) : relative;
}
