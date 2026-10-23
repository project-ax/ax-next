import { TASK_NEEDS_YOU_AFTER_MISSES, type RoutineReportStatus } from '@ax/routines-contract';
import type { TaskRow } from './workspace-types.js';

export type TaskGroup =
  | 'needs-you'
  | 'off-track'
  | 'no-recent-update'
  | 'on-track'
  | 'no-update'
  | 'paused';
export type ActiveTaskGroup = Exclude<TaskGroup, 'paused'>;

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
};

/**
 * Where a task's missed check-ins put it: one or two in a row is "No recent
 * update"; at `TASK_NEEDS_YOU_AFTER_MISSES` it needs a person (TASK-930).
 */
export function missGroup(noRecentUpdate: { inARow: number }): 'needs-you' | 'no-recent-update' {
  return noRecentUpdate.inARow >= TASK_NEEDS_YOU_AFTER_MISSES ? 'needs-you' : 'no-recent-update';
}

/**
 * Which group a task sits in. Paused wins over everything, including an
 * escalated miss count. Then anything that needs a person: three misses in a
 * row, or a last report that said needs-you. A report waiting on a person is
 * never demoted by fewer misses, because its ask would be hidden with it
 * (TASK-930 decisions); off-track holds the same way. Otherwise one or two
 * misses outrank a quieter report (the report is older than the silence),
 * then "never reported", then the last report's status.
 */
export function taskGroup(row: {
  enabled: boolean;
  task: { status: RoutineReportStatus } | null;
  noRecentUpdate: { inARow: number } | null;
}): TaskGroup {
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

/** Buckets rows into the page's groups (empty ones left out) plus paused. Never mutates its input. */
export function groupTasks(rows: readonly TaskRow[]): {
  groups: Array<{ group: ActiveTaskGroup; rows: TaskRow[] }>;
  paused: TaskRow[];
} {
  const sorted = [...rows].sort(compareRows);
  const paused = sorted.filter((r) => taskGroup(r) === 'paused');
  const groups = ACTIVE_TASK_GROUPS.map((group) => ({
    group,
    rows: sorted.filter((r) => taskGroup(r) === group),
  })).filter((g) => g.rows.length > 0);
  return { groups, paused };
}
