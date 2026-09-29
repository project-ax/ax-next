/**
 * What the Storage tab SAYS, and nothing else (TASK-690).
 *
 * Numbers in, sentences out. `lib/storage-api.ts` is the wire; the components
 * are layout; this is the wording, so a size, a status or a failure reads the
 * same wherever it turns up. Same split as `lib/usage-copy.ts`.
 *
 * The reader is a person who wants to know if they can keep working, or an
 * admin deciding how much room to give everyone. So: plain sentences, no
 * jokes, and no advice we cannot stand behind. In particular NOTHING here
 * tells a person to delete anything. Today nothing they can do gives space
 * back (files stay in the history), so "delete some files" would be a false
 * promise. What is true is: ask an admin for more room.
 */
import {
  STORAGE_LIMIT_BOUNDS,
  StorageHttpError,
  BYTES_PER_MB,
  type MyStorage,
  type StorageOwner,
  type StorageStatus,
} from './storage-api';

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * "2.3 GB", "512 MB", "0 B". Counts in 1024s (the way the limit is set), shows
 * one decimal only when there is one to show, and rolls up a unit rather than
 * print "1024 KB". Anything that is not a size (negative, NaN, infinite) reads
 * as "0 B": a screen that says "NaN GB" is worse than one that says nothing
 * is used.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let unit = 0;
  let value = n;
  while (unit < UNITS.length - 1) {
    const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    if (rounded < 1024) break;
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : (Math.round(value * 10) / 10).toFixed(1);
  return `${text.replace(/\.0$/, '')} ${UNITS[unit]}`;
}

/** A limit set in MB, said the way a person would: 1024 -> "1 GB". */
export function formatMb(mb: number): string {
  return formatBytes(mb * BYTES_PER_MB);
}

/** "2.3 GB of 5 GB used". */
export function usageLine(usedBytes: number, limitBytes: number): string {
  return `${formatBytes(usedBytes)} of ${formatBytes(limitBytes)} used`;
}

/**
 * How much of the limit an owner has used, as a phrase for under their size.
 * `null` when there is nothing worth saying (nothing used, or no limit to
 * measure against). Over 100 is shown as it is: "110%" is the news.
 */
export function shareOfLimit(usedBytes: number, limitBytes: number): string | null {
  if (!(limitBytes > 0) || !(usedBytes > 0)) return null;
  const pct = (usedBytes / limitBytes) * 100;
  return pct < 1 ? '<1% of limit' : `${Math.round(pct)}% of limit`;
}

/** The two rows under the bar. The words are the ones the design settled on. */
export function breakdownRows(
  s: Pick<MyStorage, 'workspaceBytes' | 'fileBytes'>,
): Array<{ label: string; value: string }> {
  return [
    { label: 'Agent files', value: formatBytes(s.workspaceBytes) },
    { label: 'Uploads and published files', value: formatBytes(s.fileBytes) },
  ];
}

/** The small line under an owner's size in the admin table. */
export function ownerBreakdown(
  o: Pick<StorageOwner, 'workspaceBytes' | 'fileBytes'>,
): string {
  return `${formatBytes(o.workspaceBytes)} agent files, ${formatBytes(o.fileBytes)} uploads`;
}

// ---------------------------------------------------------------------------
// People and statuses
// ---------------------------------------------------------------------------

function present(s: string | null): s is string {
  return s !== null && s.trim().length > 0;
}

type OwnerName = Pick<StorageOwner, 'displayName' | 'email' | 'ownerId'>;

/** Name, else email, else the raw id: never a blank cell. */
export function ownerLabel(o: OwnerName): string {
  if (present(o.displayName)) return o.displayName;
  if (present(o.email)) return o.email;
  return o.ownerId;
}

/** The smaller line under a NAME. An owner shown by email or id has none. */
export function ownerSubline(o: OwnerName): string | null {
  if (!present(o.displayName)) return null;
  return present(o.email) ? o.email : o.ownerId;
}

/** "12 people and teams, 3.4 GB in total". */
export function ownersSummary(t: { ownerCount: number; totalBytes: number }): string {
  const who = t.ownerCount === 1 ? 'person or team' : 'people and teams';
  return `${t.ownerCount.toLocaleString('en-US')} ${who}, ${formatBytes(t.totalBytes)} in total`;
}

/**
 * "Close to limit" is the Usage tab's word for the same state; a full store is
 * "Full" because nothing more fits, which is a plainer thing than "At limit".
 */
const STATUS_LABELS: ReadonlyMap<StorageStatus, string> = new Map([
  ['ok', 'OK'],
  ['near-limit', 'Close to limit'],
  ['full', 'Full'],
]);

/**
 * The word for a status. The word carries the meaning; colour only backs it up.
 * A status a newer server invents shows as "Unknown" rather than as nothing (a
 * `Map`, not an object: the value is text off the wire and an object lookup
 * would answer to `constructor`).
 */
export function statusLabel(status: StorageStatus): string {
  return STATUS_LABELS.get(status) ?? 'Unknown';
}

// ---------------------------------------------------------------------------
// The notices
// ---------------------------------------------------------------------------

export const NEAR_LIMIT_TITLE = "You're getting close to your limit";
export const NEAR_LIMIT_BODY =
  "Once it's full, new file changes and uploads won't be saved. Ask an admin for more room before that happens.";
export const FULL_TITLE = 'Your storage is full';
export const FULL_BODY =
  "Nothing new can be saved right now, including changes to your agents' files and new uploads. Ask an admin for more room.";

/**
 * The default for a message the server turned away because the attachment
 * would not fit (`413 storage-full`). The server sends its own sentence too,
 * and `lib/storage-full.ts` prefers it; this is what a person reads if it is
 * missing. It says the message did not go, why, and who can help. It does not
 * promise the draft or the files are still there: that depends on the screen.
 */
export const STORAGE_FULL_SEND =
  "We couldn't send that message because your storage is full. Nothing new can be saved right now, including uploads. Ask an admin for more room, then try again.";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const mbBounds = STORAGE_LIMIT_BOUNDS.limitMb;
const warnBounds = STORAGE_LIMIT_BOUNDS.warnPercent;

function n(v: number): string {
  return v.toLocaleString('en-US');
}

export const LIMIT_MB_INVALID = `Enter a whole number of MB between ${n(mbBounds.min)} and ${n(mbBounds.max)}.`;
export const WARN_PERCENT_INVALID = `Enter a whole number between ${warnBounds.min} and ${warnBounds.max}.`;

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Codes the server sends that deserve a whole sentence of their own. A `Map`
 * for the reason `STATUS_LABELS` is one.
 */
const CODE_SENTENCES: ReadonlyMap<string, string> = new Map([
  [
    'invalid-limits',
    `We couldn't save those settings. The limit can be ${n(mbBounds.min)} to ${n(mbBounds.max)} MB, and the notice can start at ${warnBounds.min} to ${warnBounds.max} percent. Adjust the numbers, then save again.`,
  ],
]);

interface Explanation {
  /** Why it happened, when we know. May be empty. */
  why: string;
  /** What to do about it, when it is more specific than "try again". */
  next: string | null;
}

/** Codes that mean our own request was broken, not the admin's numbers. */
const OUR_SIDE: ReadonlySet<string> = new Set(['invalid-json', 'body-too-large']);

function explain(err: unknown): Explanation {
  if (err instanceof StorageHttpError) {
    if (err.status === 401) {
      return { why: 'Your session has ended.', next: 'Sign in again, then come back here.' };
    }
    if (err.status === 403) {
      return { why: 'This needs an admin account.', next: 'Ask an admin to help.' };
    }
    if (err.status >= 500) {
      return { why: 'The server ran into a problem.', next: null };
    }
    if (err.serverError === 'unexpected-response') {
      return { why: "The server sent back something we didn't expect.", next: null };
    }
    if (err.serverError !== undefined && OUR_SIDE.has(err.serverError)) {
      return {
        why: 'Something went wrong on our side while sending it.',
        next: 'Reload this page, then try again.',
      };
    }
    // Any other code is the server's word for it, not ours. We don't print it.
    return { why: '', next: null };
  }
  // A failed `fetch` (offline, DNS, the server is down) rejects with a TypeError.
  if (err instanceof TypeError) {
    return {
      why: "We couldn't reach the server.",
      next: 'Check your connection, then try again.',
    };
  }
  return { why: '', next: null };
}

export const TRY_AGAIN_LATER = 'Try again in a moment.';

/**
 * One failure, as the sentences a person reads: what happened, whether anything
 * changed, why, and the one next step.
 *
 * @param what     "We couldn't save your changes."
 * @param settled  what state things are in ("Nothing was changed."), or `null`
 *                 when it does not apply (a read changes nothing).
 * @param retry    the closing line when there is no more specific next step.
 *                 `null` when the screen already has a "Try again" button
 *                 right there, so the sentence does not say it twice.
 */
export function failureMessage(
  what: string,
  err: unknown,
  { settled = null, retry = TRY_AGAIN_LATER }: { settled?: string | null; retry?: string | null } = {},
): string {
  if (err instanceof StorageHttpError && err.serverError !== undefined) {
    const whole = CODE_SENTENCES.get(err.serverError);
    if (whole !== undefined) return whole;
  }
  const { why, next } = explain(err);
  return [what, settled, why, next ?? retry]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' ');
}
