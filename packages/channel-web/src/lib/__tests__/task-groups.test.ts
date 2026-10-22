import { describe, expect, it } from 'vitest';
import { TASK_GROUP_LABELS, groupTasks, taskGroup } from '../task-groups.js';

describe('shared status words', () => {
  it('words each mark the same way on every page', () => {
    expect(TASK_GROUP_LABELS).toEqual({
      'needs-you': 'Needs you',
      'off-track': 'Off track',
      'on-track': 'On track',
      'no-update': 'No update yet',
      paused: 'Paused',
    });
  });

  it('groups a task page’s detail like a Tasks row', () => {
    expect(taskGroup({ enabled: false, task: { status: 'needs-you' } })).toBe('paused');
    expect(taskGroup({ enabled: true, task: null })).toBe('no-update');
    expect(taskGroup({ enabled: true, task: { status: 'off-track' } })).toBe('off-track');
  });
});
import type { TaskRow, TaskRowReport } from '../workspace-types.js';

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    agentId: 'a1',
    agentName: 'Caveman',
    routineId: 'r1',
    name: 'Zero open tickets',
    enabled: true,
    task: null,
    ...over,
  };
}

function report(
  status: TaskRowReport['status'],
  reportedAt = '2026-10-22T10:00:00.000Z',
): TaskRowReport {
  return { status, update: 'Queue is empty.', reportedAt };
}

describe('taskGroup', () => {
  it('puts a paused task under paused, whatever its report says', () => {
    expect(taskGroup(row({ enabled: false, task: report('needs-you') }))).toBe('paused');
  });

  it('puts a task that has never reported under no-update', () => {
    expect(taskGroup(row())).toBe('no-update');
  });

  it.each(['needs-you', 'off-track', 'on-track'] as const)(
    'puts a %s report under its own group',
    (status) => {
      expect(taskGroup(row({ task: report(status) }))).toBe(status);
    },
  );
});

describe('groupTasks', () => {
  it('orders the groups needs-you, off-track, on-track, no-update, and leaves empty ones out', () => {
    const { groups } = groupTasks([
      row({ routineId: 'a', task: report('on-track') }),
      row({ routineId: 'b' }),
      row({ routineId: 'c', task: report('needs-you') }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['needs-you', 'on-track', 'no-update']);
  });

  it('lists the newest update first, then never-reported tasks by name', () => {
    const older = row({ routineId: 'old', task: report('on-track', '2026-10-22T10:00:00.000Z') });
    const newer = row({ routineId: 'new', task: report('on-track', '2026-10-22T10:05:00.000Z') });
    const { groups } = groupTasks([older, newer]);
    expect(groups[0]!.rows.map((r) => r.routineId)).toEqual(['new', 'old']);

    const quiet = groupTasks([
      row({ routineId: '1', name: 'b' }),
      row({ routineId: '2', name: 'A' }),
      row({ routineId: '3', name: 'c' }),
    ]);
    expect(quiet.groups[0]!.rows.map((r) => r.name)).toEqual(['A', 'b', 'c']);
  });

  it('keeps paused tasks out of the groups and sorts them the same way', () => {
    const { groups, paused } = groupTasks([
      row({ routineId: 'never', enabled: false }),
      row({ routineId: 'seen', enabled: false, task: report('needs-you') }),
    ]);
    expect(groups).toEqual([]);
    expect(paused.map((r) => r.routineId)).toEqual(['seen', 'never']);
  });

  it('breaks ties by agent name, then ids', () => {
    const { groups } = groupTasks([
      row({ agentId: 'a2', agentName: 'Juniper', routineId: 'x' }),
      row({ agentId: 'a1', agentName: 'Caveman', routineId: 'x' }),
    ]);
    expect(groups[0]!.rows.map((r) => r.agentName)).toEqual(['Caveman', 'Juniper']);
  });

  it('does not reorder the array it is given', () => {
    const input = [row({ routineId: 'b', name: 'b' }), row({ routineId: 'a', name: 'a' })];
    const copy = [...input];
    groupTasks(input);
    expect(input).toEqual(copy);
  });
});
