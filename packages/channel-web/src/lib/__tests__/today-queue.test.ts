import { describe, expect, it } from 'vitest';
import { decisionFixture, resolvedFixture } from '../../components/workspace/__tests__/decision-fixture.js';
import { todayQueue, waitingOnYou } from '../today-queue.js';
import type { Decision, TaskRow, TaskRowReport } from '../workspace-types.js';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    agentId: 'scheduler',
    agentName: 'Scheduler',
    routineId: 't1',
    name: 'Zero open tickets',
    enabled: true,
    kind: 'stay-on-top',
    steps: null,
    finishBy: null,
    task: null,
    noRecentUpdate: null,
    doneAt: null,
    ...over,
  };
}

function report(
  status: TaskRowReport['status'],
  reportedAt = '2026-10-23T10:00:00.000Z',
): TaskRowReport {
  return {
    status,
    update: 'Queue is empty.',
    ask: 'Want me to draft a reply?',
    reading: null,
    doneClaimed: false,
    reportedAt,
  };
}

function under(routineId: string, taskName = 'Zero open tickets'): Decision['checkIn'] {
  return { routineId, taskName };
}

const AGENTS = [
  { id: 'scheduler', name: 'Scheduler' },
  { id: 'other', name: 'Other' },
];

function open(id: string, over: Partial<Decision> = {}): Decision {
  return decisionFixture({ id, ...over });
}

function resolvedAgo(id: string, ms: number, over: Partial<Decision> = {}): Decision {
  return resolvedFixture('executed', {
    id,
    resolvedAt: new Date(NOW - ms).toISOString(),
    ...over,
  });
}

describe('waitingOnYou', () => {
  it('counts open decisions, grants and tasks that need you, each once', () => {
    const decisions = [
      open('d1'),
      open('d2', { checkIn: under('t1') }),
      resolvedFixture('executed', { id: 'd3' }),
    ];
    const tasks = [
      row({ routineId: 't1', task: report('needs-you') }),
      row({ routineId: 't2', task: report('on-track') }),
      row({ routineId: 't3', enabled: false, task: report('needs-you') }),
    ];
    expect(waitingOnYou({ decisions, grants: [{}], tasks })).toBe(4);
  });

  it('adds nothing for a task that is there only for its approvals', () => {
    const tasks = [row({ routineId: 't2', task: report('on-track') })];
    expect(
      waitingOnYou({ decisions: [open('d1', { checkIn: under('t2') })], grants: [], tasks }),
    ).toBe(1);
  });
});

describe('todayQueue', () => {
  it('a task that thinks it’s done counts once and makes one done-claimed block (TASK-950)', () => {
    const tasks = [row({ routineId: 't1', task: { ...report('needs-you'), doneClaimed: true } })];
    expect(waitingOnYou({ decisions: [], grants: [], tasks })).toBe(1);
    const out = todayQueue({ tasks, decisions: [], agents: AGENTS, now: NOW });
    expect(out.groups.map((g) => [g.routineId, g.reason])).toEqual([['t1', 'done-claimed']]);
  });

  it("puts a check-in's approval under its task, matched on agent and task", () => {
    const tasks = [row({ routineId: 't1', task: report('needs-you') })];
    const d1 = open('d1', { checkIn: under('t1') });
    const d2 = open('d2', { agentId: 'other', checkIn: under('t1') });
    const d3 = open('d3');
    const out = todayQueue({ tasks, decisions: [d1, d2, d3], agents: AGENTS, now: NOW });
    expect(out.groups.map((g) => [g.agentId, g.routineId, g.decisions.map((d) => d.id)])).toEqual([
      ['scheduler', 't1', ['d1']],
      ['other', 't1', ['d2']],
    ]);
    expect(out.groups[0]?.reason).toBe('asks');
    expect(out.groups[0]?.key).toBe(JSON.stringify(['scheduler', 't1']));
    expect(out.groups[1]?.reason).toBeNull();
    expect(out.loose.map((d) => d.id)).toEqual(['d3']);
  });

  it('lists tasks that need you first, then tasks there for their approvals, in queue order', () => {
    const tasks = [
      row({ routineId: 'tA', name: 'Alpha', task: report('needs-you', '2026-10-23T09:00:00.000Z') }),
      row({ routineId: 'tB', name: 'Bravo', task: report('needs-you', '2026-10-23T10:00:00.000Z') }),
    ];
    const decisions = [
      open('d1', { checkIn: under('tZ', 'Zulu') }),
      open('d2', { checkIn: under('tY', 'Yankee') }),
      open('d3', { checkIn: under('tA', 'Alpha') }),
    ];
    const out = todayQueue({ tasks, decisions, agents: AGENTS, now: NOW });
    expect(out.groups.map((g) => g.routineId)).toEqual(['tB', 'tA', 'tZ', 'tY']);
    expect(out.groups.map((g) => g.reason)).toEqual(['asks', 'asks', null, null]);
  });

  it('names a task there for its approvals from the tasks read, else from its label and the roster', () => {
    const onTrack = row({
      routineId: 't2',
      name: 'Row name',
      agentName: 'Row agent',
      task: report('on-track'),
    });
    const withRow = todayQueue({
      tasks: [onTrack],
      decisions: [open('d1', { checkIn: under('t2', 'Label name') })],
      agents: AGENTS,
      now: NOW,
    });
    expect(withRow.groups).toHaveLength(1);
    expect(withRow.groups[0]).toMatchObject({
      taskName: 'Row name',
      agentName: 'Row agent',
      reason: null,
      row: onTrack,
    });
    const without = todayQueue({
      tasks: [],
      decisions: [open('d1', { checkIn: under('t2', 'Label name') })],
      agents: AGENTS,
      now: NOW,
    });
    expect(without.groups[0]).toMatchObject({
      taskName: 'Label name',
      agentName: 'Scheduler',
      reason: null,
      row: null,
    });
  });

  it('keeps a just-resolved approval in its group, in its place, and drops one resolved long ago', () => {
    const tasks = [row({ routineId: 't1', task: report('needs-you') })];
    const d1 = open('d1', { checkIn: under('t1') });
    const d2 = resolvedAgo('d2', 1_000, { checkIn: under('t1') });
    const d3 = resolvedAgo('d3', 600_000, { checkIn: under('t1') });
    const out = todayQueue({ tasks, decisions: [d1, d2, d3], agents: AGENTS, now: NOW });
    expect(out.groups[0]?.decisions.map((d) => d.id)).toEqual(['d1', 'd2']);
    // Queue order, not opens-then-receipts: a receipt ahead of an open row stays
    // ahead, so a row that resolves keeps its place (and its focus) in the block.
    const receiptFirst = todayQueue({ tasks, decisions: [d2, d1], agents: AGENTS, now: NOW });
    expect(receiptFirst.groups[0]?.decisions.map((d) => d.id)).toEqual(['d2', 'd1']);

    const onlyOld = todayQueue({
      tasks: [],
      decisions: [resolvedAgo('d4', 600_000, { checkIn: under('tQ') })],
      agents: AGENTS,
      now: NOW,
    });
    expect(onlyOld.groups).toEqual([]);
    expect(onlyOld.loose).toEqual([]);
  });

  it('keeps approvals without a task, or from an older server, loose', () => {
    const { checkIn: _gone, ...older } = decisionFixture({ id: 'd2' });
    const out = todayQueue({
      tasks: [],
      decisions: [open('d1', { checkIn: null }), older as unknown as Decision],
      agents: AGENTS,
      now: NOW,
    });
    expect(out.groups).toEqual([]);
    expect(out.loose.map((d) => d.id)).toEqual(['d1', 'd2']);
  });

  it("drops an approval whose agent isn't on the roster, and makes no group for it", () => {
    const out = todayQueue({
      tasks: [],
      decisions: [
        open('d1', { agentId: 'gone', checkIn: under('t1') }),
        open('d2', { agentId: 'gone' }),
      ],
      agents: AGENTS,
      now: NOW,
    });
    expect(out.groups).toEqual([]);
    expect(out.loose).toEqual([]);
  });

  it("doesn't change its inputs", () => {
    const tasks = [
      row({ routineId: 'tB', name: 'B', task: report('needs-you', '2026-10-23T09:00:00.000Z') }),
      row({ routineId: 'tA', name: 'A', task: report('needs-you', '2026-10-23T10:00:00.000Z') }),
    ];
    const decisions = [open('d1', { checkIn: under('tB') }), open('d2')];
    const agents = [...AGENTS];
    const before = JSON.stringify({ tasks, decisions, agents });
    todayQueue({ tasks, decisions, agents, now: NOW });
    waitingOnYou({ tasks, decisions, grants: [] });
    expect(JSON.stringify({ tasks, decisions, agents })).toBe(before);
  });
});
