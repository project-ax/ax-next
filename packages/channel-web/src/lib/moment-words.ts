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
  const bareDate = relative === formatTimestamp(value, { now, format: 'clock' }) && !relative.includes(':');
  return bareDate ? formatFullTimestamp(value) : relative;
}
