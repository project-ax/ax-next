import { describe, expect, it } from 'vitest';
import type { RoutineReportStatus } from '@ax/routines-contract';
import {
  entryCount,
  foldTimeline,
  latestUpdateCheckIn,
  missCheckIn,
  runFailureText,
  sharedConversationIds,
  updateText,
  withoutLatest,
} from '../task-updates.js';
import type { TaskReply, TaskUpdate } from '../workspace-types.js';

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
    report: report === null ? null : { status: report, update: `update ${n}`, reading: null },
    conversationId: null,
    ...over,
  };
}

describe('foldTimeline', () => {
  it('shows the newest of a run of on-track check-ins and folds the rest', () => {
    const ups = Array.from({ length: 6 }, () => u('on-track'));
    expect(foldTimeline(ups, [])).toEqual([
      { kind: 'update', update: ups[0] },
      { kind: 'fold', updates: ups.slice(1) },
    ]);
  });

  it("doesn't fold a run with only one to hide", () => {
    const ups = [u('on-track'), u('on-track')];
    expect(foldTimeline(ups, [])).toEqual([
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
    expect(foldTimeline([a, b, c, d, e, f, g], [])).toEqual([
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
    expect(foldTimeline(ups, [])).toEqual(ups.map((update) => ({ kind: 'update', update })));
  });

  it("doesn't fold a silenced check-in that reported something else", () => {
    const ups = [u('on-track'), u('off-track', { status: 'silenced' }), u('on-track')];
    expect(foldTimeline(ups, []).every((i) => i.kind === 'update')).toBe(true);
  });

  it("keeps the order and doesn't change its input", () => {
    const ups = [u('on-track'), u('on-track'), u('on-track'), u('needs-you'), u('on-track')];
    const copy = structuredClone(ups);
    const items = foldTimeline(ups, []);
    expect(ups).toEqual(copy);
    const flat = items.flatMap((i) =>
      i.kind === 'update' ? [i.update] : i.kind === 'fold' ? i.updates : [],
    );
    expect(flat).toEqual(ups);
  });
});

/** A check-in fired at 10:`mm` on 2026-10-22. */
function at(mm: number, report: RoutineReportStatus | null = 'on-track'): TaskUpdate {
  return {
    firedAt: `2026-10-22T10:${String(mm).padStart(2, '0')}:00.000Z`,
    status: 'ok',
    error: null,
    report: report === null ? null : { status: report, update: `at ${mm}`, reading: null },
    conversationId: null,
  };
}

function reply(mm: number, over: Partial<TaskReply> = {}): TaskReply {
  return {
    sentAt: `2026-10-22T10:${String(mm).padStart(2, '0')}:00.000Z`,
    text: `reply ${mm}`,
    byYou: true,
    ...over,
  };
}

describe('foldTimeline with replies (TASK-931)', () => {
  it('interleaves replies and check-ins, newest first', () => {
    const u50 = at(50, 'needs-you');
    const u30 = at(30, 'needs-you');
    const u10 = at(10, 'needs-you');
    const r40 = reply(40);
    const r20 = reply(20);
    expect(foldTimeline([u50, u30, u10], [r40, r20])).toEqual([
      { kind: 'update', update: u50 },
      { kind: 'reply', reply: r40 },
      { kind: 'update', update: u30 },
      { kind: 'reply', reply: r20 },
      { kind: 'update', update: u10 },
    ]);
  });

  it('at the same instant, the check-in a reply started shows above the reply', () => {
    const up = at(30, 'needs-you');
    const r = reply(30);
    expect(foldTimeline([up], [r])).toEqual([
      { kind: 'update', update: up },
      { kind: 'reply', reply: r },
    ]);
  });

  it('a reply breaks a quiet run and never folds', () => {
    const [u50, u40, u30, u20, u10] = [50, 40, 30, 20, 10].map((m) => at(m)) as [
      TaskUpdate,
      TaskUpdate,
      TaskUpdate,
      TaskUpdate,
      TaskUpdate,
    ];
    const r35 = reply(35);
    expect(foldTimeline([u50, u40, u30, u20, u10], [r35])).toEqual([
      { kind: 'update', update: u50 },
      { kind: 'update', update: u40 },
      { kind: 'reply', reply: r35 },
      { kind: 'update', update: u30 },
      { kind: 'fold', updates: [u20, u10] },
    ]);
  });

  it('replies alone come out as given', () => {
    const rs = [reply(40), reply(30), reply(20)];
    expect(foldTimeline([], rs)).toEqual(rs.map((r) => ({ kind: 'reply', reply: r })));
  });

  it('a reply with an unreadable time goes after every check-in', () => {
    const up = at(10, 'needs-you');
    const bad = reply(5, { sentAt: 'not a time' });
    expect(foldTimeline([up], [bad])).toEqual([
      { kind: 'update', update: up },
      { kind: 'reply', reply: bad },
    ]);
  });

  it("doesn't change its inputs", () => {
    const ups = [at(50), at(40), at(30)];
    const rs = [reply(45), reply(35)];
    const upsCopy = structuredClone(ups);
    const rsCopy = structuredClone(rs);
    foldTimeline(ups, rs);
    expect(ups).toEqual(upsCopy);
    expect(rs).toEqual(rsCopy);
  });
});

describe('updateText (TASK-911)', () => {
  it('says the update, or why there is none', () => {
    expect(updateText({ status: 'ok', report: { status: 'on-track', update: 'Queue is empty.', reading: null } })).toBe(
      'Queue is empty.',
    );
    expect(updateText({ status: 'ok', report: { status: 'needs-you', update: null, reading: null } })).toBe(
      'It left an update we can’t show.',
    );
    expect(updateText({ status: 'ok', report: { status: 'needs-you', update: '', reading: null } })).toBe(
      'It left an update we can’t show.',
    );
    expect(updateText({ status: 'error', report: null })).toBe('This check-in didn’t finish.');
    expect(updateText({ status: 'ok', report: null })).toBe('Checked in but didn’t leave an update');
  });
});

describe('latestUpdateCheckIn (TASK-911)', () => {
  const SAID = { status: 'on-track', update: 'Queue is empty.', reading: null } as const;
  const task = { status: 'on-track', update: 'Queue is empty.' } as const;

  it('the latest update came from the newest check-in that left one', () => {
    const updates: TaskUpdate[] = [
      u(null, { status: 'error', conversationId: 'c3' }),
      u('on-track', { report: SAID, conversationId: 'c2' }),
      u('on-track', { report: { status: 'on-track', update: 'Older.', reading: null }, conversationId: 'c1' }),
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

  it('none when its conversation is shared with another check-in', () => {
    // A routine that was once a repeat routine with one shared conversation:
    // the link would open that conversation's newest run, not this one.
    const updates = [
      u('on-track', { report: SAID, conversationId: 'shared' }),
      u('on-track', { report: { status: 'on-track', update: 'Older.', reading: null }, conversationId: 'shared' }),
    ];
    expect(latestUpdateCheckIn(task, updates)).toBeNull();
  });

  it('none when no check-in in Updates left a report', () => {
    expect(latestUpdateCheckIn(task, [u(null, { conversationId: 'c1' })])).toBeNull();
    expect(latestUpdateCheckIn(task, [])).toBeNull();
  });
});

describe('sharedConversationIds (TASK-911)', () => {
  it('names each conversation more than one check-in recorded, and nothing else', () => {
    const updates = [
      u('on-track', { conversationId: 'a' }),
      u('on-track', { conversationId: 'b' }),
      u('on-track', { conversationId: 'a' }),
      u('on-track', { conversationId: null }),
      u('on-track', { conversationId: null }),
      u('on-track', { conversationId: 'c' }),
    ];
    expect([...sharedConversationIds(updates)]).toEqual(['a']);
    expect(sharedConversationIds([]).size).toBe(0);
  });
});

describe('missCheckIn', () => {
  const AT = '2026-10-22T09:00:00.000Z';
  const missed = (over: Partial<TaskUpdate> = {}): TaskUpdate =>
    u(null, { firedAt: AT, conversationId: 'conv-miss', ...over });
  const newer = (): TaskUpdate => u('on-track', { conversationId: 'conv-new' });

  it('is the entry whose firedAt equals the miss time, even with a newer entry', () => {
    expect(missCheckIn({ at: AT }, [newer(), missed()])).toBe('conv-miss');
  });

  it('is null when the miss time is null', () => {
    expect(missCheckIn(null, [missed()])).toBeNull();
  });

  it('is null when no entry fired at that time', () => {
    expect(missCheckIn({ at: '2026-01-01T00:00:00.000Z' }, [newer(), missed()])).toBeNull();
  });

  it('is null when that entry reported', () => {
    expect(
      missCheckIn({ at: AT }, [missed({ report: { status: 'on-track', update: 'fine', reading: null } })]),
    ).toBeNull();
  });

  it('is null when that entry has no conversation', () => {
    expect(missCheckIn({ at: AT }, [missed({ conversationId: null })])).toBeNull();
  });

  it('is null when another check-in shares that conversation', () => {
    expect(
      missCheckIn({ at: AT }, [u('on-track', { conversationId: 'conv-miss' }), missed()]),
    ).toBeNull();
  });
});

describe('runFailureText (2026-10-29)', () => {
  it('words the routines store’s own sentences plainly, and keeps any other reason as recorded', () => {
    expect(runFailureText('The routine run was interrupted by a host restart.')).toBe(
      'Stopped early because we restarted. It tries again next time.',
    );
    expect(runFailureText('The routine run closed before it could start.')).toBe(
      'Something went wrong, so this check-in didn’t finish.',
    );
    expect(runFailureText(null)).toBe('No reason was recorded.');
    expect(runFailureText('The mailbox said no.')).toBe('The mailbox said no.');
  });
});

describe('withoutLatest and entryCount (2026-10-29)', () => {
  const said = (status: RoutineReportStatus, update: string): TaskUpdate => ({
    firedAt: '2026-10-22T10:00:00.000Z',
    status: 'ok',
    error: null,
    report: { status, update, reading: null },
    conversationId: null,
  });

  it('drops the newest entry only when it says what the latest card says', () => {
    const items = foldTimeline([said('off-track', 'A'), said('off-track', 'B')], []);
    expect(withoutLatest(items, { status: 'off-track', update: 'A' })).toEqual(items.slice(1));
    expect(withoutLatest(items, { status: 'on-track', update: 'A' })).toEqual(items);
    expect(withoutLatest(items, { status: 'off-track', update: 'B' })).toEqual(items);
    expect(withoutLatest(items, null)).toEqual(items);
  });

  it('drops the latest card’s entry even when a newer reply sits above it, and never the reply', () => {
    const reply: TaskReply = { sentAt: '2026-10-22T11:00:00.000Z', text: 'A', byYou: true };
    const items = foldTimeline([said('off-track', 'A'), said('off-track', 'B')], [reply]);
    expect(items.map((i) => i.kind)).toEqual(['reply', 'update', 'update']);
    const before = [...items];
    expect(withoutLatest(items, { status: 'off-track', update: 'A' })).toEqual([items[0], items[2]]);
    expect(items).toEqual(before);
  });

  it('only the newest check-in can be the latest card’s: an older one saying the same stays', () => {
    const items = foldTimeline([said('off-track', 'B'), said('off-track', 'A')], []);
    expect(withoutLatest(items, { status: 'off-track', update: 'A' })).toEqual(items);
  });

  it('counts a fold as the check-ins it holds', () => {
    const quiet = [1, 2, 3, 4].map(() => said('on-track', 'Fine'));
    const items = foldTimeline(quiet, []);
    expect(items.map((i) => i.kind)).toEqual(['update', 'fold']);
    expect(entryCount(items)).toBe(4);
  });
});
