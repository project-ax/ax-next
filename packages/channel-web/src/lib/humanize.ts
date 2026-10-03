/**
 * humanize — the ONE identifier humanizer now lives in `@ax/core/humanize`
 * (TASK-753), so `@ax/decisions`' approval card and this package's activity
 * rail and transcript cannot drift apart on how they say the same tool. This
 * re-export keeps the existing `@/lib/humanize` imports working; new code may
 * import either.
 */
export { humanizeId, humanizeSlotLabel } from '@ax/core/humanize';
