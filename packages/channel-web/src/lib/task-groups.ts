import type { TaskRow } from './workspace-types.js';

export type TaskGroup = 'needs-you' | 'off-track' | 'on-track' | 'no-update' | 'paused';
export type ActiveTaskGroup = Exclude<TaskGroup, 'paused'>;

export const ACTIVE_TASK_GROUPS: readonly ActiveTaskGroup[] = [
  'needs-you',
  'off-track',
  'on-track',
  'no-update',
];

/** Which group a task sits in. Paused wins over whatever the last report said. */
export function taskGroup(row: TaskRow): TaskGroup {
  if (!row.enabled) return 'paused';
  if (row.task === null) return 'no-update';
  return row.task.status;
}

function reportedMs(row: TaskRow): number | null {
  if (row.task === null) return null;
  const ms = Date.parse(row.task.reportedAt);
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
