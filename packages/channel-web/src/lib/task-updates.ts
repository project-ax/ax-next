/**
 * task-updates — which check-ins the Updates thread shows, and which it folds
 * into "N earlier check-ins, all on track" (TASK-910).
 *
 * A task that checks in every hour writes a dozen "all on track" lines a day.
 * Showing each one buries the lines that matter, so a run of quiet check-ins
 * keeps its newest and folds the rest. Anything else (a failed check-in, one
 * with no report, one that said needs-you or off-track) always stands alone.
 *
 * It also says what an entry says (`updateText`, shared with a check-in's
 * page) and which check-in the latest update came from (`latestUpdateCheckIn`,
 * TASK-911).
 *
 * Pure, with relative imports only: the server-side wire types live next door.
 */
import type { TaskDetailReport, TaskUpdate } from './workspace-types.js';

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

/** What an Updates entry says: the agent's update, or why there isn't one (TASK-910's words, now shared with a check-in's page). */
export function updateText(update: Pick<TaskUpdate, 'status' | 'report'>): string {
  const { report } = update;
  if (report !== null) {
    return report.update === null || report.update === ''
      ? 'It left an update we can’t show.'
      : report.update;
  }
  return update.status === 'error'
    ? 'This check-in didn’t finish.'
    : 'Checked in but didn’t leave an update';
}

/**
 * The check-in the task's latest update came from (TASK-911, decisions row
 * 12), or null.
 *
 * A check-in still running when the page was read has already reported, but it
 * isn't in Updates until it finishes (`finishDispatch` writes the fire row).
 * Without the equality check, the card would open the check-in before it,
 * which said something else. One that repeated the earlier report word for
 * word still links to the earlier check-in, which ended with that same report.
 * The exact signal would be the run's start (`task_report_accepted_at`), which
 * the task view doesn't carry.
 */
export function latestUpdateCheckIn(
  task: Pick<TaskDetailReport, 'status' | 'update'> | null,
  updates: readonly TaskUpdate[],
): string | null {
  if (task === null) return null;
  const newest = updates.find((u) => u.report !== null);
  if (newest === undefined || newest.report === null || newest.conversationId === null) return null;
  return newest.report.status === task.status && newest.report.update === task.update
    ? newest.conversationId
    : null;
}
