export type TimestampFormat = 'relative' | 'clock';

export interface FormatTimestampOptions {
  format?: TimestampFormat;
  now?: Date;
  timeZone?: string;
  locale?: string;
}

export interface FormatFullTimestampOptions {
  timeZone?: string;
  locale?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;

export function toDate(value: Date | string | number): Date | null {
  const d = new Date(value instanceof Date ? value.getTime() : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Newer ICU puts U+202F before AM/PM; plain spaces keep the strings stable across runtimes.
const tidy = (s: string): string => s.replace(/[  ]/g, ' ');

function fmt(date: Date, locale: string | undefined, timeZone: string | undefined, o: Intl.DateTimeFormatOptions): string {
  return tidy(new Intl.DateTimeFormat(locale, { ...o, ...(timeZone ? { timeZone } : {}) }).format(date));
}

const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

interface Ymd {
  year: number;
  month: number;
  day: number;
}

// Calendar date in the target zone. Subtracting 24h is wrong across midnight and DST, so buckets use this.
function ymd(date: Date, locale: string | undefined, timeZone: string | undefined): Ymd {
  const parts = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    numberingSystem: 'latn',
    calendar: 'gregory',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

const dayNumber = (d: Ymd): number => Date.UTC(d.year, d.month - 1, d.day) / DAY_MS;

// Same-year date ("Oct 23") or other-year date ("Oct 23, 2025").
function dateLabel(date: Date, sameYear: boolean, locale: string | undefined, timeZone: string | undefined): string {
  return fmt(date, locale, timeZone, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function weekdayTime(date: Date, locale: string | undefined, timeZone: string | undefined): string {
  return `${fmt(date, locale, timeZone, { weekday: 'short' })} ${fmt(date, locale, timeZone, TIME)}`;
}

export function formatTimestamp(value: Date | string | number, opts: FormatTimestampOptions = {}): string | null {
  const date = toDate(value);
  if (!date) return null;
  const { format = 'relative', timeZone, locale } = opts;
  const now = opts.now ?? new Date();

  const target = ymd(date, locale, timeZone);
  const today = ymd(now, locale, timeZone);
  const dayDiff = dayNumber(target) - dayNumber(today); // negative = past
  const sameYear = target.year === today.year;
  const delta = now.getTime() - date.getTime(); // positive = past
  const time = (): string => fmt(date, locale, timeZone, TIME);

  if (format === 'clock') {
    if (dayDiff === 0) return time();
    if (Math.abs(dayDiff) < 7) return weekdayTime(date, locale, timeZone);
    return dateLabel(date, sameYear, locale, timeZone);
  }

  if (delta >= 0) {
    if (delta < MINUTE) return 'just now';
    // Minutes and hours only within the same calendar day: 23:59 seen at 00:30 is "Yesterday".
    if (dayDiff === 0) {
      if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`;
      return `${Math.floor(delta / HOUR)} hr ago`;
    }
    if (dayDiff === -1) return `Yesterday ${time()}`;
    if (dayDiff > -7) return weekdayTime(date, locale, timeZone);
    return dateLabel(date, sameYear, locale, timeZone);
  }

  const ahead = -delta;
  // A server stamp a little ahead of this clock is skew, not a plan.
  if (ahead <= MINUTE) return 'just now';
  if (ahead < HOUR) return `in ${Math.max(1, Math.floor(ahead / MINUTE))} min`;
  if (dayDiff === 0) return `Today ${time()}`;
  if (dayDiff === 1) return `Tomorrow ${time()}`;
  if (dayDiff < 7) return weekdayTime(date, locale, timeZone);
  return dateLabel(date, sameYear, locale, timeZone);
}

export function formatFullTimestamp(value: Date | string | number, opts: FormatFullTimestampOptions = {}): string | null {
  const date = toDate(value);
  if (!date) return null;
  return fmt(date, opts.locale, opts.timeZone, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', ...TIME });
}
