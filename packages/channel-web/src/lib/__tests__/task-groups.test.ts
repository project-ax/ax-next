import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TASK_GROUPS,
  TASK_DONE_RECENT_MS,
  TASK_GROUP_LABELS,
  groupTasks as groupTasksAt,
  missGroup,
  taskGroup,
  todayTaskReason,
  todayTasks,
} from '../task-groups.js';

describe('shared status words', () => {
  it('words each mark the same way on every page', () => {
    expect(TASK_GROUP_LABELS).toEqual({
      'needs-you': 'Needs you',
      'off-track': 'Off track',
      'no-recent-update': 'No recent update',
      'on-track': 'On track',
      'no-update': 'No update yet',
      paused: 'Paused',
      done: 'Done',
    });
  });

  it('groups a task page’s detail like a Tasks row', () => {
    expect(taskGroup({ enabled: false, doneAt: null, task: { status: 'needs-you' }, noRecentUpdate: null })).toBe('paused');
    expect(taskGroup({ enabled: true, doneAt: null, task: null, noRecentUpdate: null })).toBe('no-update');
    expect(taskGroup({ enabled: true, doneAt: null, task: { status: 'off-track' }, noRecentUpdate: null })).toBe('off-track');
  });
});
import type { TaskRow, TaskRowReport } from '../workspace-types.js';

const NOW = new Date('2026-10-24T12:00:00Z');
/** Most cases don't care about Done, so they group against a fixed clock. */
function groupTasks(rows: readonly TaskRow[]) {
  return groupTasksAt(rows, NOW);
}

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    agentId: 'a1',
    agentName: 'Caveman',
    routineId: 'r1',
    name: 'Zero open tickets',
    enabled: true,
    kind: 'stay-on-top',
    steps: null,
    finishBy: null,
    task: null,
    noRecentUpdate: null,
    doneAt: null,
    canMarkDone: true,
    ...over,
  };
}

function report(
  status: TaskRowReport['status'],
  reportedAt = '2026-10-22T10:00:00.000Z',
  ask: string | null = null,
): TaskRowReport {
  return { status, update: 'Queue is empty.', ask, reading: null, doneClaimed: false, reportedAt };
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

function miss(inARow: number, at = '2026-10-22T11:00:00.000Z'): NonNullable<TaskRow['noRecentUpdate']> {
  return { inARow, reason: 'no-report', at, autoPaused: false };
}

describe('missed check-ins (TASK-930)', () => {
  it('escalates to needs-you at the threshold', () => {
    expect(missGroup({ inARow: 1 })).toBe('no-recent-update');
    expect(missGroup({ inARow: 2 })).toBe('no-recent-update');
    expect(missGroup({ inARow: 3 })).toBe('needs-you');
    expect(missGroup({ inARow: 7 })).toBe('needs-you');
  });

  it('lists the active groups in order', () => {
    expect(ACTIVE_TASK_GROUPS).toEqual([
      'needs-you',
      'off-track',
      'no-recent-update',
      'on-track',
      'no-update',
    ]);
  });

  it('puts paused ahead of an escalated count', () => {
    expect(taskGroup(row({ enabled: false, noRecentUpdate: miss(5) }))).toBe('paused');
  });

  it('puts two misses under no-recent-update, over an on-track report', () => {
    expect(taskGroup(row({ task: report('on-track'), noRecentUpdate: miss(2) }))).toBe(
      'no-recent-update',
    );
  });

  it('puts three misses under needs-you', () => {
    expect(taskGroup(row({ task: report('on-track'), noRecentUpdate: miss(3) }))).toBe('needs-you');
  });

  it('never demotes a needs-you report, however few misses follow it', () => {
    expect(taskGroup(row({ task: report('needs-you'), noRecentUpdate: miss(1) }))).toBe('needs-you');
  });

  it('never demotes an off-track report, however few misses follow it', () => {
    expect(taskGroup(row({ task: report('off-track'), noRecentUpdate: miss(1) }))).toBe('off-track');
  });

  it('puts one miss over an on-track report under no-recent-update', () => {
    expect(taskGroup(row({ task: report('on-track'), noRecentUpdate: miss(1) }))).toBe(
      'no-recent-update',
    );
  });

  it('escalates an off-track report to needs-you at three misses', () => {
    expect(taskGroup(row({ task: report('off-track'), noRecentUpdate: miss(3) }))).toBe('needs-you');
  });

  it('puts misses ahead of never reported', () => {
    expect(taskGroup(row({ task: null, noRecentUpdate: miss(1) }))).toBe('no-recent-update');
  });

  it('sorts an escalated row from minutes ago above an older needs-you report', () => {
    const { groups } = groupTasks([
      row({ routineId: 'report', task: report('needs-you', '2026-10-19T11:00:00.000Z') }),
      row({
        routineId: 'misses',
        task: report('on-track', '2026-10-01T11:00:00.000Z'),
        noRecentUpdate: miss(3, '2026-10-22T10:56:00.000Z'),
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group).toBe('needs-you');
    expect(groups[0]!.rows.map((r) => r.routineId)).toEqual(['misses', 'report']);
  });

  it('groups no-recent-update between off-track and on-track', () => {
    const { groups } = groupTasks([
      row({ routineId: 'a', task: report('on-track') }),
      row({ routineId: 'b', noRecentUpdate: miss(1) }),
      row({ routineId: 'c', task: report('off-track') }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['off-track', 'no-recent-update', 'on-track']);
  });
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

describe('Done (TASK-950)', () => {
  const doneAgo = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const done = (routineId: string, doneAt: string | null, over: Partial<TaskRow> = {}) =>
    row({ routineId, enabled: false, doneAt, ...over });

  it('is the first thing a done row is, whatever its report and misses say', () => {
    const r = done('d', doneAgo(1000), { task: report('needs-you'), noRecentUpdate: miss(3) });
    expect(taskGroup(r)).toBe('done');
  });

  it('leaves a disabled row without doneAt paused', () => {
    expect(taskGroup(row({ enabled: false }))).toBe('paused');
  });

  it('keeps a done row out of the groups and out of paused', () => {
    const { groups, paused, doneRecently, doneAll } = groupTasksAt(
      [done('d', doneAgo(1000), { task: report('needs-you') }), row({ routineId: 'p', enabled: false })],
      NOW,
    );
    expect(groups).toEqual([]);
    expect(paused.map((r) => r.routineId)).toEqual(['p']);
    expect(doneRecently.map((r) => r.routineId)).toEqual(['d']);
    expect(doneAll.map((r) => r.routineId)).toEqual(['d']);
  });

  it('counts a task done exactly 7 days ago as recent, and 1 ms more as not', () => {
    expect(TASK_DONE_RECENT_MS).toBe(7 * 86_400_000);
    const { doneRecently, doneAll } = groupTasksAt(
      [
        done('edge', doneAgo(TASK_DONE_RECENT_MS)),
        done('past', doneAgo(TASK_DONE_RECENT_MS + 1)),
      ],
      NOW,
    );
    expect(doneRecently.map((r) => r.routineId)).toEqual(['edge']);
    expect(doneAll.map((r) => r.routineId).sort()).toEqual(['edge', 'past']);
  });

  it('counts a future doneAt as recent and an unreadable one only under all', () => {
    const { doneRecently, doneAll } = groupTasksAt(
      [
        done('future', new Date(NOW.getTime() + 60_000).toISOString()),
        done('garbled', 'not a time'),
      ],
      NOW,
    );
    expect(doneRecently.map((r) => r.routineId)).toEqual(['future']);
    expect(doneAll.map((r) => r.routineId).sort()).toEqual(['future', 'garbled']);
  });

  it('lists the newest doneAt first, ties in the usual order, in both lists', () => {
    const { doneRecently, doneAll } = groupTasksAt(
      [
        done('old', doneAgo(3 * 86_400_000)),
        done('b', doneAgo(1000), { name: 'b' }),
        done('new', doneAgo(500)),
        done('a', doneAgo(1000), { name: 'a' }),
      ],
      NOW,
    );
    expect(doneRecently.map((r) => r.routineId)).toEqual(['new', 'a', 'b', 'old']);
    expect(doneAll.map((r) => r.routineId)).toEqual(['new', 'a', 'b', 'old']);
  });
});

describe('todayTasks (TASK-933)', () => {
  it('puts a task whose agent asked for a person on Today', () => {
    const asked = report('needs-you', undefined, 'Want me to draft a reply to #4410?');
    expect(todayTaskReason(row({ task: asked }))).toBe('asks');
    // A needs-you report whose ask didn't survive the fence still needs a person.
    expect(todayTaskReason(row({ task: report('needs-you') }))).toBe('asks');
    expect(todayTaskReason(row({ task: asked, noRecentUpdate: miss(1) }))).toBe('asks');
    expect(todayTaskReason(row({ task: asked, noRecentUpdate: miss(2) }))).toBe('asks');
  });

  it('puts a task with three or more misses in a row on Today, whatever its last report', () => {
    for (const task of [report('on-track'), report('off-track'), null]) {
      expect(todayTaskReason(row({ task, noRecentUpdate: miss(3) }))).toBe('escalated');
    }
    expect(todayTaskReason(row({ task: report('needs-you'), noRecentUpdate: miss(4) }))).toBe(
      'escalated',
    );
  });

  it('puts a task that thinks it’s done on Today as done-claimed (TASK-950)', () => {
    const claimed = { ...report('needs-you'), doneClaimed: true };
    expect(todayTaskReason(row({ task: claimed }))).toBe('done-claimed');
    // A claim is still a pending ask: one or two misses don't demote it.
    expect(todayTaskReason(row({ task: claimed, noRecentUpdate: miss(2) }))).toBe('done-claimed');
    // Three misses still say escalated.
    expect(todayTaskReason(row({ task: claimed, noRecentUpdate: miss(3) }))).toBe('escalated');
    // An unclaimed needs-you report is still an ask.
    expect(todayTaskReason(row({ task: report('needs-you') }))).toBe('asks');
    // Done, and paused by a person, never show, claim or no claim.
    expect(
      todayTaskReason(row({ enabled: false, doneAt: '2026-10-24T10:00:00.000Z', task: claimed })),
    ).toBeNull();
    expect(todayTaskReason(row({ enabled: false, task: claimed }))).toBeNull();
  });

  it('keeps an auto-paused task on Today until a person resumes it', () => {
    const autoPaused = row({
      enabled: false,
      task: report('on-track'),
      noRecentUpdate: { ...miss(5), autoPaused: true },
    });
    expect(todayTaskReason(autoPaused)).toBe('auto-paused');
    expect(todayTasks([autoPaused])).toEqual([autoPaused]);
  });

  it('never shows a task a person paused, whatever its last report said', () => {
    expect(todayTaskReason(row({ enabled: false, task: report('needs-you') }))).toBeNull();
    expect(todayTaskReason(row({ enabled: false, noRecentUpdate: miss(2) }))).toBeNull();
    // Paused by a person wins over an escalated count, as it does on the Tasks page.
    expect(todayTaskReason(row({ enabled: false, noRecentUpdate: miss(3) }))).toBeNull();
  });

  it('leaves out on track, off track, one or two misses, and never reported', () => {
    const rows = [
      row({ routineId: 'on', task: report('on-track') }),
      row({ routineId: 'off', task: report('off-track') }),
      row({ routineId: 'one', task: report('on-track'), noRecentUpdate: miss(1) }),
      row({ routineId: 'two', noRecentUpdate: miss(2) }),
      row({ routineId: 'never' }),
    ];
    for (const r of rows) expect(todayTaskReason(r)).toBeNull();
    expect(todayTasks(rows)).toEqual([]);
  });

  it('orders the newest first, by the miss or the report, then by name', () => {
    const rows = [
      row({ routineId: 'ada', name: 'Ada', task: report('needs-you', '2026-10-22T10:00:00.000Z') }),
      row({
        routineId: 'zed',
        name: 'Zed',
        task: report('on-track', '2026-10-22T08:00:00.000Z'),
        noRecentUpdate: miss(3, '2026-10-22T10:05:00.000Z'),
      }),
      row({
        routineId: 'alpha',
        name: 'Alpha',
        task: report('needs-you', '2026-10-22T10:05:00.000Z'),
      }),
      row({
        routineId: 'dee',
        name: 'Dee',
        enabled: false,
        task: report('on-track', '2026-10-22T07:00:00.000Z'),
        noRecentUpdate: { ...miss(5, '2026-10-22T09:00:00.000Z'), autoPaused: true },
      }),
    ];
    expect(todayTasks(rows).map((r) => r.name)).toEqual(['Alpha', 'Zed', 'Ada', 'Dee']);
  });

  it("doesn't change the rows it is given", () => {
    const input = [
      row({ routineId: 'old', task: report('needs-you', '2026-10-22T09:00:00.000Z') }),
      row({ routineId: 'calm', task: report('on-track') }),
      row({ routineId: 'new', task: report('needs-you', '2026-10-22T10:00:00.000Z') }),
    ];
    const copy = [...input];
    expect(todayTasks(input).map((r) => r.routineId)).toEqual(['new', 'old']);
    expect(input).toEqual(copy);
  });
});
