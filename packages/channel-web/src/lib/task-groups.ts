import { TASK_NEEDS_YOU_AFTER_MISSES, type RoutineReportStatus } from '@ax/routines-contract';
import type { TaskRow } from './workspace-types.js';

export type TaskGroup =
  | 'needs-you'
  | 'off-track'
  | 'no-recent-update'
  | 'on-track'
  | 'no-update'
  | 'paused'
  | 'done';
/** The groups that hold running tasks: neither paused nor done, each of which has its own place on the page. */
export type ActiveTaskGroup = Exclude<TaskGroup, 'paused' | 'done'>;

export const ACTIVE_TASK_GROUPS: readonly ActiveTaskGroup[] = [
  'needs-you',
  'off-track',
  'no-recent-update',
  'on-track',
  'no-update',
];

/** The group words, the same on the Tasks page and a task's own page. */
export const TASK_GROUP_LABELS: Record<TaskGroup, string> = {
  'needs-you': 'Needs you',
  'off-track': 'Off track',
  'no-recent-update': 'No recent update',
  'on-track': 'On track',
  'no-update': 'No update yet',
  paused: 'Paused',
  done: 'Done',
};

/** How long a Done task stays under Current, counted from `doneAt` against the browser's clock (TASK-950). */
export const TASK_DONE_RECENT_MS = 7 * 86_400_000;

/**
 * Where a task's missed check-ins put it: one or two in a row is "No recent
 * update"; at `TASK_NEEDS_YOU_AFTER_MISSES` it needs a person (TASK-930).
 */
export function missGroup(noRecentUpdate: { inARow: number }): 'needs-you' | 'no-recent-update' {
  return noRecentUpdate.inARow >= TASK_NEEDS_YOU_AFTER_MISSES ? 'needs-you' : 'no-recent-update';
}

/**
 * Which group a task sits in. Done wins over everything: a finished task is
 * off, and its last report is the claim the person accepted, which would
 * otherwise read as "Needs you" (TASK-950). Then paused, including an
 * escalated miss count. Then anything that needs a person: three misses in a
 * row, or a last report that said needs-you. A report waiting on a person is
 * never demoted by fewer misses, because its ask would be hidden with it
 * (TASK-930 decisions); off-track holds the same way. Otherwise one or two
 * misses outrank a quieter report (the report is older than the silence),
 * then "never reported", then the last report's status.
 */
export function taskGroup(row: {
  enabled: boolean;
  doneAt: string | null;
  task: { status: RoutineReportStatus } | null;
  noRecentUpdate: { inARow: number } | null;
}): TaskGroup {
  if (row.doneAt !== null) return 'done';
  if (!row.enabled) return 'paused';
  const miss = row.noRecentUpdate;
  if ((miss !== null && missGroup(miss) === 'needs-you') || row.task?.status === 'needs-you') {
    return 'needs-you';
  }
  if (row.task?.status === 'off-track') return 'off-track';
  if (miss !== null) return 'no-recent-update';
  if (row.task === null) return 'no-update';
  return row.task.status;
}

/** When the row last said something: the missed check-in if it has one, else its report. */
function reportedMs(row: TaskRow): number | null {
  const at = row.noRecentUpdate?.at ?? row.task?.reportedAt;
  if (at === undefined) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRows(a: TaskRow, b: TaskRow): number {
  const am = reportedMs(a);
  const bm = reportedMs(b);
  if (am !== bm) {
    if (am === null) return 1;
    if (bm === null) return -1;
    return bm - am;
  }
  return (
    a.name.localeCompare(b.name) ||
    a.agentName.localeCompare(b.agentName) ||
    cmpStr(a.agentId, b.agentId) ||
    cmpStr(a.routineId, b.routineId)
  );
}

/** When the task was marked done, in ms; null when the time can't be read. */
function doneMs(row: TaskRow): number | null {
  if (row.doneAt === null) return null;
  const ms = Date.parse(row.doneAt);
  return Number.isNaN(ms) ? null : ms;
}

/** Newest `doneAt` first (an unreadable one last), ties in `compareRows` order. */
function compareDone(a: TaskRow, b: TaskRow): number {
  const am = doneMs(a);
  const bm = doneMs(b);
  if (am !== bm) {
    if (am === null) return 1;
    if (bm === null) return -1;
    return bm - am;
  }
  return compareRows(a, b);
}

/**
 * Buckets rows into the page's groups (empty ones left out), paused, and Done.
 * `doneAll` is every done row; `doneRecently` is those done within
 * `TASK_DONE_RECENT_MS` of `now` (a future `doneAt` counts, an unreadable one
 * doesn't). Done rows are in neither `groups` nor `paused`. Never mutates its
 * input.
 */
export function groupTasks(
  rows: readonly TaskRow[],
  now: Date,
): {
  groups: Array<{ group: ActiveTaskGroup; rows: TaskRow[] }>;
  paused: TaskRow[];
  doneRecently: TaskRow[];
  doneAll: TaskRow[];
} {
  const sorted = [...rows].sort(compareRows);
  const paused = sorted.filter((r) => taskGroup(r) === 'paused');
  const groups = ACTIVE_TASK_GROUPS.map((group) => ({
    group,
    rows: sorted.filter((r) => taskGroup(r) === group),
  })).filter((g) => g.rows.length > 0);
  const doneAll = sorted.filter((r) => taskGroup(r) === 'done').sort(compareDone);
  const doneRecently = doneAll.filter((r) => {
    const ms = doneMs(r);
    return ms !== null && now.getTime() - ms <= TASK_DONE_RECENT_MS;
  });
  return { groups, paused, doneRecently, doneAll };
}

/** Why a task is on Today (TASK-933; `done-claimed` is TASK-950). */
export type TodayTaskReason = 'asks' | 'escalated' | 'auto-paused' | 'done-claimed';

/**
 * Why this task needs a person on Today, or null. In order: not enabled →
 * 'auto-paused' only when `noRecentUpdate?.autoPaused === true`, else null (a
 * task a person paused or marked done never shows, whatever its last report
 * said); not in the needs-you group (`taskGroup`) → null; three or more
 * misses in a row (`missGroup`) → 'escalated'; its last report claimed the
 * task is done → 'done-claimed'; else 'asks' (its last report said needs-you).
 * Escalated comes before the claim, and the claim before the ask: a pending
 * report is never demoted, so one or two misses leave a claim a claim.
 */
export function todayTaskReason(row: TaskRow): TodayTaskReason | null {
  if (!row.enabled) return row.noRecentUpdate?.autoPaused === true ? 'auto-paused' : null;
  if (taskGroup(row) !== 'needs-you') return null;
  const miss = row.noRecentUpdate;
  if (miss !== null && missGroup(miss) === 'needs-you') return 'escalated';
  return row.task?.doneClaimed === true ? 'done-claimed' : 'asks';
}

/** The rows `todayTaskReason` keeps, ordered by `compareRows` (newest `noRecentUpdate.at ?? task.reportedAt` first, then name, agent name, ids). Never mutates its input. */
export function todayTasks(rows: readonly TaskRow[]): TaskRow[] {
  return rows.filter((r) => todayTaskReason(r) !== null).sort(compareRows);
}
