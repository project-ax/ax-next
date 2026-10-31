// ---------------------------------------------------------------------------
// The sentences a refused write carries.
//
// A refusal's `reason` is PROSE, not a code, and it is shown verbatim to the
// person on the upload paths. So these are written for a non-technical reader.
//
// There is no delete button, so a person-facing sentence never says "delete" or
// "remove". What is true: the agent can clean up files it no longer needs (a
// person asks it, in chat), and an admin can raise the limit. The upload one
// says both.
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
 * Person-facing: shown when an upload is refused (the chat send's attachment,
 * the skills routes). An agent's own refused publish reaches the agent as
 * `@ax/ipc-core`'s agent-addressed sentence instead (TASK-993).
 */
export function blobFullMessage(usedBytes: number, limitBytes: number): string {
  return (
    `You've used all of your storage (${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}), ` +
    "so that file wasn't saved. To make room, ask your agent to clean up files it no longer needs, " +
    'or ask an admin for more room. Then try again.'
  );
}

/** The gate could not check (database down, setting unreadable): nothing was saved. */
export const STORAGE_UNAVAILABLE_MESSAGE =
  "We couldn't check your storage just now, so nothing was saved. Please try again in a moment.";
