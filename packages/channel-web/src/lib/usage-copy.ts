/**
 * What the Usage tab SAYS, and nothing else (TASK-692).
 *
 * Numbers in, sentences out. `lib/usage-admin.ts` is the wire; the components
 * are layout; this is the wording, so a status, an amount or a failure reads
 * the same wherever it turns up — the same split `lib/turn-error-labels.ts`
 * makes for the person on the other end of a limit.
 *
 * The reader is an admin who may not be technical, and the subject is money and
 * access. So: plain sentences, no jokes, no status codes, and every failure
 * says what happened, why when we know, and the one thing to do next.
 */
import {
  USAGE_LIMIT_BOUNDS,
  UsageHttpError,
  type UsageStatus,
  type UsageUser,
} from './usage-admin';

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** en-US on purpose: the amounts are dollars, and "$1,234.50" reads as dollars. */
export function formatUsd(n: number): string {
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function count(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "5 people, 150 messages, about $12.86 estimated". */
export function summaryLine(totals: {
  users: number;
  turns: number;
  spendUsd: number;
}): string {
  return `${count(totals.users, 'person', 'people')}, ${count(totals.turns, 'message', 'messages')}, about ${formatUsd(totals.spendUsd)} estimated`;
}

/**
 * How much of the daily limit someone has used, as a phrase for under their
 * spend. `null` when there is nothing worth saying (no spend, or no limit to
 * measure against). Over 100 is shown as it is — "110%" is the news.
 */
export function shareOfLimit(spendUsd: number, limitUsd: number): string | null {
  if (!(limitUsd > 0) || !(spendUsd > 0)) return null;
  const pct = (spendUsd / limitUsd) * 100;
  return pct < 1 ? '<1% of limit' : `${Math.round(pct)}% of limit`;
}

// ---------------------------------------------------------------------------
// People and statuses
// ---------------------------------------------------------------------------

function present(s: string | null): s is string {
  return s !== null && s.trim().length > 0;
}

/** Name, else email, else the id — never a blank cell. */
export function personLabel(u: Pick<UsageUser, 'displayName' | 'email' | 'userId'>): string {
  if (present(u.displayName)) return u.displayName;
  if (present(u.email)) return u.email;
  return u.userId;
}

/** The smaller line under a NAME. A person shown by email or id has none. */
export function personSubline(
  u: Pick<UsageUser, 'displayName' | 'email' | 'userId'>,
): string | null {
  if (!present(u.displayName)) return null;
  return present(u.email) ? u.email : u.userId;
}

const STATUS_LABELS: ReadonlyMap<UsageStatus, string> = new Map([
  ['ok', 'OK'],
  ['near-limit', 'Close to limit'],
  ['at-limit', 'At limit'],
  ['suspended', 'Paused'],
]);

/**
 * The word for a status. The word carries the meaning; colour only backs it up.
 * A status a newer server invents shows as "Unknown" rather than as nothing.
 */
export function statusLabel(status: UsageStatus): string {
  return STATUS_LABELS.get(status) ?? 'Unknown';
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const dailyBounds = USAGE_LIMIT_BOUNDS.dailySpendUsd;
const turnsBounds = USAGE_LIMIT_BOUNDS.turnsPerHour;

/** "$0.01 to $10,000" — the dollar range, as a phrase. */
const dailyRange = `$${dailyBounds.min.toFixed(2)} to $${formatCount(dailyBounds.max)}`;
const turnsRange = `${formatCount(turnsBounds.min)} to ${formatCount(turnsBounds.max)}`;

export const DAILY_LIMIT_INVALID = `Enter an amount between $${dailyBounds.min.toFixed(2)} and $${formatCount(dailyBounds.max)}.`;
export const TURNS_LIMIT_INVALID = `Enter a whole number between ${formatCount(turnsBounds.min)} and ${formatCount(turnsBounds.max)}.`;

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Codes the server sends that deserve a whole sentence of their own. A `Map`,
 * not an object literal: `serverError` is text off the wire, and an object
 * lookup would answer to `constructor` and `toString`.
 */
const CODE_SENTENCES: ReadonlyMap<string, string> = new Map([
  [
    'invalid-limits',
    `We couldn't save those limits. Daily spend can be ${dailyRange}, and messages per hour ${turnsRange}. Adjust the numbers, then save again.`,
  ],
  [
    'cannot-suspend-self',
    "You can't pause your own agents. Ask another admin to do it.",
  ],
]);

interface Explanation {
  /** Why it happened, when we know. May be empty. */
  why: string;
  /** What to do about it, when it is more specific than "try again". */
  next: string | null;
}

function explain(err: unknown): Explanation {
  if (err instanceof UsageHttpError) {
    if (err.status === 401) {
      return {
        why: 'Your session has ended.',
        next: 'Sign in again, then come back here.',
      };
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
    if (err.serverError !== undefined && err.serverError.length > 0) {
      return { why: `The server said: ${err.serverError}.`, next: null };
    }
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
 * @param settled  what state things are in — "Nothing was changed." — or
 *                 `null` when it does not apply (a read changes nothing).
 * @param retry    the closing line when there is no more specific next step.
 *                 `null` when the screen already has a "Try again" button
 *                 right there, so the sentence does not say it twice.
 */
export function failureMessage(
  what: string,
  err: unknown,
  { settled = null, retry = TRY_AGAIN_LATER }: { settled?: string | null; retry?: string | null } = {},
): string {
  if (err instanceof UsageHttpError && err.serverError !== undefined) {
    const whole = CODE_SENTENCES.get(err.serverError);
    if (whole !== undefined) return whole;
  }
  const { why, next } = explain(err);
  return [what, settled, why, next ?? retry]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' ');
}
