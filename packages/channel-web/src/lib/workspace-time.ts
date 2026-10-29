/**
 * The one place an ISO instant becomes a string a reader looks at.
 *
 * TASK-435: the chat tab and the `did` (Activity) feed used to format the same
 * kind of event on opposite sides of the wire — the chat bubble's clock was
 * computed by the SERVER, in the server's timezone (`shortTime` /
 * `relativeDay`, formerly in `server/routes-workspace.ts`), while the `did`
 * feed's day buckets and clock were already computed by the CLIENT, in the
 * reader's timezone (`ActivityFeed.tsx`'s private `localDayKey` / `dayLabel` /
 * `localTime`). A host running in UTC and a reader sitting in EDT therefore
 * disagreed about the same event by four hours, and nothing on screen said
 * which of the two clocks you were looking at.
 *
 * `ActivityEvent` (`workspace-types.ts`) already states the rule this module
 * exists to enforce everywhere, not just for the `did` feed:
 *
 *   "A display string is a rendering decision, and rendering decisions do not
 *   belong on the wire."
 *
 * So the wire carries instants (`ThreadMessage.at`, `PastConversation
 * .lastActivityAt`, `ActivityEvent.at`) and every surface that turns one into
 * text calls a function FROM HERE. Invariant 4 (one source of truth per
 * concept) is the reason this is a shared module rather than three files each
 * keeping their own copy that quietly drift back apart the next time someone
 * tweaks one and not the others.
 */

/** `null` on an unparseable instant — the row renders without a clock, not "Invalid Date". */
export function localTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Local Y-M-D. Two ISO instants on the same calendar day here share a bucket. */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** `Today`, `Yesterday`, or a plain local date — never anything the server said. */
export function localDayLabel(d: Date, now: Date): string {
  if (localDayKey(d) === localDayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (localDayKey(d) === localDayKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * A short, plain relative date — "today", "3 days ago". Deliberately coarse:
 * the past-conversation rows are for orientation, not for forensics, and an
 * exact timestamp there reads like it means something it doesn't.
 *
 * Moved here verbatim from `server/routes-workspace.ts` (TASK-435) — it was
 * already computing local calendar days via `getFullYear`/`getMonth`/
 * `getDate` rather than `getUTCFullYear` etc, so it was "SERVER-side" only in
 * the sense that it ran on the wrong machine: the actual arithmetic was
 * already the reader's-timezone kind, and moving the same code to run on the
 * client makes it correct by construction rather than by coincidence.
 */
export function relativeDay(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'a while ago';
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return 'over a year ago';
}

/**
 * A short day-and-month on the READER's calendar, in their language's own
 * form ("7. Okt." in German, "10月7日" in Japanese). The one short-date
 * helper: the conversation rail, a grant line's date and "Signed in by you on
 * 7 Oct" all use it. Only English is reordered to day-then-month ("7 Oct",
 * where en-US alone would say "Oct 7"), because the English copy reads "on 7
 * Oct"; re-gluing the parts for any other language would break its native
 * form. `locale` exists for tests; the app passes nothing. Empty on an
 * instant it can't read, never "Invalid Date".
 */
export function shortDay(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  if (fmt.resolvedOptions().locale.split('-')[0] !== 'en') return fmt.format(date);
  const parts = fmt.formatToParts(date);
  return `${parts.find(p => p.type === 'day')?.value} ${parts.find(p => p.type === 'month')?.value}`;
}

/** Compact date for the rail. A malformed server timestamp must not blank chat. */
export function conversationDate(iso: string): string {
  return shortDay(iso) || 'Unknown';
}

/**
 * "just now", "4 min ago", "3 hr ago" within a day, then `relativeDay`'s
 * "yesterday" / "4 days ago". The Tasks page's "checked 4 min ago" (TASK-909).
 *
 * Minutes and hours are elapsed time, floored, so it never says more time has
 * passed than has. A future instant reads "just now": the host stamped it, and
 * a reader's clock a little behind the host's is ordinary. `null` on an
 * instant it can't read, so the caller shows no time at all rather than
 * "Invalid Date" or a guess.
 */
export function timeAgo(iso: string, now: Date = new Date()): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const mins = Math.floor((now.getTime() - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return relativeDay(iso, now);
}

/**
 * When a check-in happened or will: "at 10:02 AM" today, "tomorrow at 9:00 AM",
 * "yesterday at 4:58 PM", else "on Mon, Oct 20 at 10:02 AM". The reader's time
 * zone. `null` on an instant it can't read.
 */
export function checkInWhen(iso: string, now: Date = new Date()): string | null {
  const time = localTime(iso);
  if (time === null) return null;
  const d = new Date(iso);
  const dayOffset = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  );
  if (dayOffset === 0) return `at ${time}`;
  if (dayOffset === 1) return `tomorrow at ${time}`;
  if (dayOffset === -1) return `yesterday at ${time}`;
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `on ${day} at ${time}`;
}

/** An Updates entry's time: the clock today, else the day and the clock. `null` on an instant it can't read. */
export function updateStamp(iso: string, now: Date = new Date()): string | null {
  const time = localTime(iso);
  if (time === null) return null;
  const d = new Date(iso);
  return localDayKey(d) === localDayKey(now) ? time : `${localDayLabel(d, now)}, ${time}`;
}

/** Local midnight of `d`'s calendar day, as a timestamp. */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * "Oct 23": the month and day in the reader's language and time zone, the
 * same form `finishByShort` gives a finish date, so every short date on a
 * task's page reads alike. Empty on an instant it can't read. `locale` is for
 * tests.
 */
export function monthDay(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(d);
}

/**
 * A compact row's time (the task page's check-ins and runs, 2026-10-29):
 * "7:13 PM" today, "Fri 7:13 PM" within the six days before, and "Oct 23"
 * otherwise (older, or a stamp ahead of today). Days are the reader's calendar
 * days, counted from local midnights, so a 23- or 25-hour day at a clock
 * change still counts as one. `null` on an instant it can't read.
 */
export function compactStamp(iso: string, now: Date = new Date(), locale?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(d)) / 86_400_000);
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return time;
  if (days >= 1 && days <= 6) {
    return `${d.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  }
  return monthDay(iso, locale);
}

/** The whole of a compact stamp, for hidden text and its tooltip: "Fri, Oct 23, 2026, 7:13 PM". `null` on an instant it can't read. */
export function fullStamp(iso: string, locale?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
