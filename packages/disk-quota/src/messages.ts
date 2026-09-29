// ---------------------------------------------------------------------------
// The sentences a refused write carries.
//
// A refusal's `reason` is PROSE, not a code, and it is shown verbatim: to the
// agent on the runner-commit path (which relays it to the person), and to the
// person on the upload paths. So these are written for a non-technical reader.
//
// One thing they never say is "delete something to make room". Nothing frees
// bytes today (attachments and artifacts cannot be deleted, git history keeps
// every blob), so that advice would send someone on a hunt that cannot end.
// What is true is that an admin can raise the limit.
// ---------------------------------------------------------------------------

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Bytes as a short human string, 1024-based: "0 B", "512 KB", "3.4 MB",
 * "1 GB", "1.5 GB". One decimal only when it is needed (a trailing ".0" is
 * trimmed). Anything that is not a finite, non-negative number reads as "0 B".
 */
export function formatBytes(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0 B';
  let unit = 0;
  let value = n;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.floor(value)} B`;
  let rounded = Math.round(value * 10) / 10;
  // 1023.96 KB rounds to "1024 KB"; say "1 MB" instead.
  if (rounded >= 1024 && unit < UNITS.length - 1) {
    rounded = Math.round((rounded / 1024) * 10) / 10;
    unit++;
  }
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * Model-facing: the agent reads this as the reason its turn's file changes
 * were refused, and relays it. The runner discards refused work (it is not
 * retried), so the sentence says the changes are gone and asks the agent not
 * to try again.
 */
export function workspaceFullMessage(usedBytes: number, limitBytes: number): string {
  return (
    `The storage limit has been reached (${formatBytes(usedBytes)} of ${formatBytes(limitBytes)} used), ` +
    "so this turn's file changes were not saved and have been removed. " +
    "Please don't try to save them again. " +
    "Let the person know their storage is full and that an admin can make more room."
  );
}

/** Person-facing: shown when an upload or a published file is refused. */
export function blobFullMessage(usedBytes: number, limitBytes: number): string {
  return (
    `You've used all of your storage (${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}), ` +
    "so that file wasn't saved. An admin can make more room, and then you can try again."
  );
}

/** The gate could not check (database down, setting unreadable): nothing was saved. */
export const STORAGE_UNAVAILABLE_MESSAGE =
  "We couldn't check your storage just now, so nothing was saved. Please try again in a moment.";
