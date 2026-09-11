/**
 * cron-describe — say, in English, what a cron expression will do.
 *
 * (TASK-345 / audit E5.) The routine editor asks for `0 2 * * *` and an IANA
 * timezone string. Both are exact and both are opaque: someone who is not sure
 * whether they just asked for 2am or 2pm has no way to find out from the form,
 * and finds out when the routine runs.
 *
 * Deliberately NOT a dependency. Nothing in the repo describes cron in prose —
 * `croner` (used by @ax/routines) computes next-run times, which is a different
 * job — and the card is explicit that this must not pull in a heavy package for
 * one preview line.
 *
 * The shape that matters is the THIRD outcome. Most describers try to render
 * everything, and a describer that renders everything will eventually render
 * something wrong. A wrong description here is worse than none: it tells
 * someone their routine runs at a time it does not, and they will believe it.
 * So this covers the shapes people actually type, reports `invalid` for
 * anything malformed, and returns `unknown` — say nothing — for expressions
 * that are valid but beyond it. The caller shows the raw expression then.
 */

export type CronDescription =
  | { kind: 'described'; text: string }
  /** Valid cron, but a shape we will not attempt to put into words. */
  | { kind: 'unknown' }
  /** Not a cron expression at all. */
  | { kind: 'invalid' };

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// Characters a cron field may legally contain. This is deliberately WIDER than
// the shapes we describe: it decides `invalid` vs `unknown`, and those say
// different things to the reader. `15,45 2-4 * * *` and `0 2 * 3 1#2` are
// perfectly good cron that this describer will not attempt to put into words —
// calling them invalid would tell someone their working schedule is broken.
const CRON_FIELD_CHARS = /^[0-9*/,\-#?LW]+$/i;

interface Fields {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
}

function inRange(v: string, min: number, max: number): boolean {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max;
}

/** Split and sanity-check. `null` means "not a cron expression". */
function parseFields(expr: string): Fields | null {
  const parts = expr.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  // Every field must look like cron, and every NUMBER in it must be in range —
  // so `99 2 * * *` is a typo, while `15,45 2-4 * * *` is a real schedule we
  // simply decline to narrate.
  for (const [value, min, max] of [
    [minute, 0, 59],
    [hour, 0, 23],
    [dom, 1, 31],
    [month, 1, 12],
    [dow, 0, 7],
  ] as const) {
    if (!CRON_FIELD_CHARS.test(value)) return null;
    for (const token of value.match(/\d+/g) ?? []) {
      // A step's divisor (the n in star-slash-n) is bounded by the field's own
      // maximum, which is the same check as a plain value.
      if (!inRange(token, Math.min(min, 1), max)) return null;
    }
  }
  return { minute, hour, dom, month, dow };
}

/** `0 2` → "2:00 AM". 12-hour because that is how most people read a clock. */
function clockTime(minute: string, hour: string): string {
  const h = Number(hour);
  const m = Number(minute);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** 1 → "1st", 22 → "22nd". */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const isFixed = (v: string): boolean => /^\d{1,2}$/.test(v);

function describeFields(f: Fields): string | null {
  const { minute, hour, dom, month, dow } = f;
  // Anything scoped to particular months is past what we will put into words.
  if (month !== '*') return null;

  // Interval shapes: every N minutes / every N hours / every minute.
  if (dom === '*' && dow === '*') {
    if (minute === '*' && hour === '*') return 'Runs every minute';
    const everyMin = minute.match(/^\*\/(\d{1,2})$/);
    if (everyMin !== null && hour === '*') {
      return `Runs every ${everyMin[1]} minutes`;
    }
    const everyHour = hour.match(/^\*\/(\d{1,2})$/);
    if (everyHour !== null && minute === '0') {
      return `Runs every ${everyHour[1]} hours`;
    }
  }

  // Everything below needs a definite time of day.
  if (!isFixed(minute) || !isFixed(hour)) return null;
  const at = clockTime(minute, hour);

  if (dom === '*' && dow === '*') return `Runs at ${at}, every day`;

  if (dom === '*' && dow === '1-5') return `Runs at ${at}, every weekday`;

  if (dom === '*' && isFixed(dow)) {
    // Cron accepts both 0 and 7 for Sunday.
    const name = DAY_NAMES[Number(dow) % 7];
    return name === undefined ? null : `Runs at ${at}, every ${name}`;
  }

  if (dow === '*' && isFixed(dom)) {
    return `Runs at ${at} on the ${ordinal(Number(dom))} of each month`;
  }

  return null;
}

/**
 * Describe a cron expression, optionally naming the timezone it runs in.
 *
 * Never throws: a half-typed expression is the normal state of an input someone
 * is still filling in.
 */
export function describeCron(expr: string, timezone?: string): CronDescription {
  const fields = parseFields(expr);
  if (fields === null) return { kind: 'invalid' };
  const described = describeFields(fields);
  if (described === null) return { kind: 'unknown' };
  const tz = timezone !== undefined && timezone.trim().length > 0
    ? ` (${timezone.trim()})`
    : '';
  return { kind: 'described', text: `${described}${tz}` };
}
