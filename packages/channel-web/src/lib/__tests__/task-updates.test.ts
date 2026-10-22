import { describe, expect, it } from 'vitest';
import type { RoutineReportStatus } from '@ax/routines-contract';
import { foldUpdates } from '../task-updates.js';
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
