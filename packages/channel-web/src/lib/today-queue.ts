/**
 * What Today shows, as pure functions (TASK-933).
 *
 * Two jobs, kept in one place so the screens can't disagree:
 *
 *  - `waitingOnYou` is THE count of what's waiting on a person: open
 *    decisions, grants and tasks that need them, each once. The sidebar badge,
 *    the Needs you tab and Today's headline all read it.
 *  - `todayQueue` arranges Today: a block per task (the tasks that need a
 *    person, then tasks that are there only for the approvals raised in their
 *    check-ins), and everything else loose, in queue order.
 *
 * No React, no I/O, no mutation of what it is given.
 */
import { todayTaskReason, todayTasks, type TodayTaskReason } from './task-groups.js';
import {
  isJustResolved,
  isOpenDecision,
  type Decision,
  type TaskRow,
} from './workspace-types.js';

/**
 * THE one count of what's waiting on you (TASK-933): open decisions, grants and
 * tasks that need you (`todayTasks`), each once. The sidebar badge, the Needs
 * you tab and Today's headline all read this, so they can't disagree. An
 * approval under a task counts as itself; a task there only for its approvals
 * adds nothing.
 */
export function waitingOnYou(q: {
  decisions: readonly Decision[];
  grants: readonly unknown[];
  tasks: readonly TaskRow[];
}): number {
  return q.decisions.filter(isOpenDecision).length + q.grants.length + todayTasks(q.tasks).length;
}

/** One task's block on Today. A task that needs you always has its row; a block there only for its approvals may not. */
export type TodayGroup = {
  /** `JSON.stringify([agentId, routineId])`: the task's address, and the React key. */
  key: string;
  agentId: string;
  routineId: string;
  /** The row's name, else the first approval's `checkIn.taskName`. */
  taskName: string;
  /** The row's agent name, else the roster's. */
  agentName: string;
  /** Its approvals, open and just resolved, in queue order. */
  decisions: Decision[];
} & (
  | {
      /** Why the task itself needs you. */
      reason: TodayTaskReason;
      row: TaskRow;
    }
  | {
      /** Here only for its approvals. */
      reason: null;
      /** The task as the tasks read has it; null when the read doesn't (failed, missed its agent, or the task is gone). */
      row: TaskRow | null;
    }
);

function groupKey(agentId: string, routineId: string): string {
  return JSON.stringify([agentId, routineId]);
}

/** Today's tasks and approvals, arranged (TASK-933). Never mutates its inputs. */
export function todayQueue(input: {
  tasks: readonly TaskRow[];
  decisions: readonly Decision[];
  agents: readonly { id: string; name: string }[];
  now: number;
}): { groups: TodayGroup[]; loose: Decision[] } {
  const roster = new Map(input.agents.map((a) => [a.id, a.name]));
  const byKey = new Map<string, TodayGroup>();
  const groups: TodayGroup[] = [];

  for (const row of todayTasks(input.tasks)) {
    const reason = todayTaskReason(row);
    // `todayTasks` keeps only rows with a reason; the check narrows the type.
    if (reason === null) continue;
    const group: TodayGroup = {
      key: groupKey(row.agentId, row.routineId),
      agentId: row.agentId,
      routineId: row.routineId,
      taskName: row.name,
      agentName: row.agentName,
      decisions: [],
      reason,
      row,
    };
    byKey.set(group.key, group);
    groups.push(group);
  }

  const taskRows = new Map(
    input.tasks.map((r) => [groupKey(r.agentId, r.routineId), r] as const),
  );
  const loose: Decision[] = [];

  for (const d of input.decisions) {
    // The roster rule `renderRow` applies: an agent we can't name isn't drawn.
    const agentName = roster.get(d.agentId);
    if (agentName === undefined) continue;
    if (!isOpenDecision(d) && !isJustResolved(d, input.now)) continue;

    const checkIn = d.checkIn ?? null;
    if (checkIn === null) {
      loose.push(d);
      continue;
    }
    const key = groupKey(d.agentId, checkIn.routineId);
    let group = byKey.get(key);
    if (group === undefined) {
      const row = taskRows.get(key) ?? null;
      group = {
        key,
        agentId: d.agentId,
        routineId: checkIn.routineId,
        taskName: row?.name ?? checkIn.taskName,
        agentName: row?.agentName ?? agentName,
        decisions: [],
        reason: null,
        row,
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.decisions.push(d);
  }

  return { groups, loose };
}
