import { describe, expect, it } from 'vitest';
import type { RoutineReportStatus } from '@ax/routines-contract';
import { foldUpdates, latestUpdateCheckIn, updateText } from '../task-updates.js';
import type { TaskUpdate } from '../workspace-types.js';

let n = 0;
/** An update with a report of `report` (or none), newest-first numbering via `n`. */
function u(
  report: RoutineReportStatus | null,
  over: Partial<TaskUpdate> = {},
): TaskUpdate {
  n += 1;
  return {
    firedAt: `2026-10-22T10:${String(60 - n).padStart(2, '0')}:00.000Z`,
    status: 'ok',
    error: null,
    report: report === null ? null : { status: report, update: `update ${n}` },
    conversationId: null,
    ...over,
  };
}

describe('foldUpdates', () => {
  it('shows the newest of a run of on-track check-ins and folds the rest', () => {
    const ups = Array.from({ length: 6 }, () => u('on-track'));
    expect(foldUpdates(ups)).toEqual([
      { kind: 'update', update: ups[0] },
      { kind: 'fold', updates: ups.slice(1) },
    ]);
  });

  it("doesn't fold a run with only one to hide", () => {
    const ups = [u('on-track'), u('on-track')];
    expect(foldUpdates(ups)).toEqual([
      { kind: 'update', update: ups[0] },
      { kind: 'update', update: ups[1] },
    ]);
  });

  it('any other check-in breaks a run', () => {
    const [a, b, c, d, e, f, g] = [
      u('needs-you'),
      u('on-track'),
      u('on-track'),
      u('on-track'),
      u('off-track'),
      u('on-track'),
      u('on-track'),
    ] as [TaskUpdate, TaskUpdate, TaskUpdate, TaskUpdate, TaskUpdate, TaskUpdate, TaskUpdate];
    expect(foldUpdates([a, b, c, d, e, f, g])).toEqual([
      { kind: 'update', update: a },
      { kind: 'update', update: b },
      { kind: 'fold', updates: [c, d] },
      { kind: 'update', update: e },
      { kind: 'update', update: f },
      { kind: 'update', update: g },
    ]);
  });

  it('never folds a failed check-in, or one without a report', () => {
    const failed = [1, 2, 3].map(() => u('on-track', { status: 'error', error: 'it fell over' }));
    const bare = [1, 2, 3].map(() => u(null));
    const ups = [...failed, ...bare];
    expect(foldUpdates(ups)).toEqual(ups.map((update) => ({ kind: 'update', update })));
  });

  it("doesn't fold a silenced check-in that reported something else", () => {
    const ups = [u('on-track'), u('off-track', { status: 'silenced' }), u('on-track')];
    expect(foldUpdates(ups).every((i) => i.kind === 'update')).toBe(true);
  });

  it("keeps the order and doesn't change its input", () => {
    const ups = [u('on-track'), u('on-track'), u('on-track'), u('needs-you'), u('on-track')];
    const copy = structuredClone(ups);
    const items = foldUpdates(ups);
    expect(ups).toEqual(copy);
    const flat = items.flatMap((i) => (i.kind === 'update' ? [i.update] : i.updates));
    expect(flat).toEqual(ups);
  });
});

describe('updateText (TASK-911)', () => {
  it('says the update, or why there is none', () => {
    expect(updateText({ status: 'ok', report: { status: 'on-track', update: 'Queue is empty.' } })).toBe(
      'Queue is empty.',
    );
    expect(updateText({ status: 'ok', report: { status: 'needs-you', update: null } })).toBe(
      'It left an update we can’t show.',
    );
    expect(updateText({ status: 'ok', report: { status: 'needs-you', update: '' } })).toBe(
      'It left an update we can’t show.',
    );
    expect(updateText({ status: 'error', report: null })).toBe('This check-in didn’t finish.');
    expect(updateText({ status: 'ok', report: null })).toBe('Checked in but didn’t leave an update');
  });
});

describe('latestUpdateCheckIn (TASK-911)', () => {
  const SAID = { status: 'on-track', update: 'Queue is empty.' } as const;
  const task = { status: 'on-track', update: 'Queue is empty.' } as const;

  it('the latest update came from the newest check-in that left one', () => {
    const updates: TaskUpdate[] = [
      u(null, { status: 'error', conversationId: 'c3' }),
      u('on-track', { report: SAID, conversationId: 'c2' }),
      u('on-track', { report: { status: 'on-track', update: 'Older.' }, conversationId: 'c1' }),
    ];
    // This is also the answer while a check-in that repeated those exact words
    // is still running: the data can't tell the two apart, and decisions row
    // 12 accepts it.
    expect(latestUpdateCheckIn(task, updates)).toBe('c2');
  });

  it('none while a check-in that said something new is still running', () => {
    const updates = [u('on-track', { report: SAID, conversationId: 'c2' })];
    expect(latestUpdateCheckIn({ status: 'on-track', update: 'Something new.' }, updates)).toBeNull();
    expect(latestUpdateCheckIn({ status: 'needs-you', update: 'Queue is empty.' }, updates)).toBeNull();
  });

  it('none for a task that hasn’t reported, or a check-in that recorded no conversation', () => {
    expect(latestUpdateCheckIn(null, [u('on-track', { report: SAID, conversationId: 'c2' })])).toBeNull();
    expect(latestUpdateCheckIn(task, [u('on-track', { report: SAID, conversationId: null })])).toBeNull();
  });

  it('none when no check-in in Updates left a report', () => {
    expect(latestUpdateCheckIn(task, [u(null, { conversationId: 'c1' })])).toBeNull();
    expect(latestUpdateCheckIn(task, [])).toBeNull();
  });
});
