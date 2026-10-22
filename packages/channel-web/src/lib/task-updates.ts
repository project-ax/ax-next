/**
 * task-updates — which check-ins the Updates thread shows, and which it folds
 * into "N earlier check-ins, all on track" (TASK-910).
 *
 * A task that checks in every hour writes a dozen "all on track" lines a day.
 * Showing each one buries the lines that matter, so a run of quiet check-ins
 * keeps its newest and folds the rest. Anything else (a failed check-in, one
 * with no report, one that said needs-you or off-track) always stands alone.
 *
 * Pure, with relative imports only: the server-side wire types live next door.
 */
import type { TaskUpdate } from './workspace-types.js';

/** A fold hides at least this many; a shorter tail stays as single updates. */
export const FOLD_MIN_HIDDEN = 2;

export type UpdateItem =
  | { kind: 'update'; update: TaskUpdate }
  | { kind: 'fold'; updates: TaskUpdate[] };

function isQuiet(update: TaskUpdate): boolean {
  return update.status !== 'error' && update.report?.status === 'on-track';
}

/** Newest-first in, newest-first out. Never mutates its input. */
export function foldUpdates(updates: readonly TaskUpdate[]): UpdateItem[] {
  const items: UpdateItem[] = [];
  let i = 0;
  while (i < updates.length) {
    const head = updates[i] as TaskUpdate;
    items.push({ kind: 'update', update: head });
    i += 1;
    if (!isQuiet(head)) continue;
    let end = i;
    while (end < updates.length && isQuiet(updates[end] as TaskUpdate)) end += 1;
    const tail = updates.slice(i, end);
    if (tail.length >= FOLD_MIN_HIDDEN) {
      items.push({ kind: 'fold', updates: tail });
    } else {
      for (const update of tail) items.push({ kind: 'update', update });
    }
    i = end;
  }
  return items;
}
