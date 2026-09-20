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
