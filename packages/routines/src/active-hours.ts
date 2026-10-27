import { ACTIVE_HOURS_DAYS, activeHoursWriteIssue, type ActiveHours } from '@ax/routines-contract';

const MINUTE_MS = 60_000;
/** Two weeks plus DST headroom: a selected weekly window may disappear in a spring gap. */
const SEARCH_MINUTES = 16 * 24 * 60;
const MAX_DATE_MS = 8_640_000_000_000_000;

function calendar(hours: ActiveHours): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: hours.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}

/** The same membership rule checks both the current candidate and every future real minute. */
function belongs(candidate: Date, hours: ActiveHours, formatter: Intl.DateTimeFormat): boolean {
  const parts = Object.fromEntries(formatter.formatToParts(candidate).map(part => [part.type, part.value]));
  const day = ACTIVE_HOURS_DAYS.indexOf(parts['weekday']!.toLowerCase() as typeof ACTIVE_HOURS_DAYS[number]);
  const minute = Number(parts['hour']) * 60 + Number(parts['minute']);
  const [startHour, startMinute] = hours.start.split(':').map(Number);
  const [endHour, endMinute] = hours.end.split(':').map(Number);
  const start = startHour! * 60 + startMinute!;
  const end = endHour! * 60 + endMinute!;
  const selected = (index: number) => hours.days === undefined || hours.days.includes(ACTIVE_HOURS_DAYS[index]!);
  if (start < end) return selected(day) && minute >= start && minute < end;
  // After midnight, the window still belongs to the previous local calendar day.
  return start > end && ((minute >= start && selected(day)) || (minute < end && selected((day + 6) % 7)));
}

export function isWithinActiveHours(candidate: Date, hours: ActiveHours): boolean {
  if (!Number.isFinite(candidate.getTime()) || activeHoursWriteIssue(hours) !== null) return false;
  return belongs(candidate, hours, calendar(hours));
}

/** Never guesses nonexistent local instants; folds are searched in real chronological order. */
export function advanceToNextActiveWindow(candidate: Date, hours: ActiveHours): Date | null {
  const milliseconds = candidate.getTime();
  if (!Number.isFinite(milliseconds) || activeHoursWriteIssue(hours) !== null) return null;
  const formatter = calendar(hours);
  // Preserve cadence, seconds and milliseconds whenever the candidate already runs here.
  if (belongs(candidate, hours, formatter)) return candidate;
  const limit = Math.min(MAX_DATE_MS, milliseconds + SEARCH_MINUTES * MINUTE_MS);
  const next = new Date(Math.floor(milliseconds / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  for (let step = 0; step < SEARCH_MINUTES && next.getTime() <= limit; step++) {
    if (belongs(next, hours, formatter)) return new Date(next.getTime());
    next.setTime(next.getTime() + MINUTE_MS);
  }
  return null;
}
