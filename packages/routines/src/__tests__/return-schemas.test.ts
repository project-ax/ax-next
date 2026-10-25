import { describe, it, expect } from 'vitest';
import * as C from '@ax/routines-contract';
import { routinePermissions, routineView, ROUTINE_SERVICES } from '../services.js';
import type { StoredReading, StoredRoutine, StoredStep } from '../types.js';
/** TASK-952. A task report's reading, as the store hands it over. */
const OPEN_3: StoredReading = { value: 3, label: 'Open tickets' };
const row: StoredRoutine = {
  ...C.RoutineDefinitionSchema.parse({ name: 'Notify', promptBody: 'Do the thing', trigger: { kind: 'interval', every: '1h' } }),
  agentId: 'agent', routineId: 'routine', revision: 'revision', ownerUserId: 'owner',
  definitionId: null, definitionUpdatedAt: null, nextRunAt: new Date('2030-01-01T00:00:00Z'), lastRunAt: null,
  lastStatus: null, lastError: null, lastWarning: null, task: null, noRecentUpdate: null, steps: [], finishBy: null, done: null,
};
describe('canonical routine return schemas', () => {
  it('projects every editable/status field without private owner or storage state', () => {
    const projected = routineView(row, 'owner', true);
    expect(C.RoutineViewSchema.parse(projected)).toEqual(projected);
    expect(projected).not.toHaveProperty('ownerUserId');
    expect(projected).not.toHaveProperty('definitionUpdatedAt');
    expect(projected.nextRunAt).toBe('2030-01-01T00:00:00.000Z');
    for (const schema of [C.RoutineGetOutputSchema, C.RoutineCreateOutputSchema, C.RoutineUpdateOutputSchema]) expect(schema.parse(projected)).toEqual(projected);
    expect(() => C.RoutineViewSchema.parse({ ...projected, token: 'secret' })).toThrow();
  });
  it("projects a task's latest report, and nothing for a repeat routine", () => {
    const task: StoredRoutine = {
      ...row,
      ...C.RoutineDefinitionSchema.parse({
        name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
        kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
      }),
      task: {
        status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?',
        agentNotes: 'Order 1234 waits on a refund.', reportedAt: new Date('2030-01-01T00:05:00Z'), reading: OPEN_3, doneClaimed: false,
      },
    };
    const projected = routineView(task, 'owner', true);
    expect(projected.task).toEqual({
      status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?',
      reading: OPEN_3, doneClaimed: false, reportedAt: '2030-01-01T00:05:00.000Z', agentNotes: 'Order 1234 waits on a refund.',
    });
    for (const schema of [C.RoutineGetOutputSchema, C.RoutineCreateOutputSchema, C.RoutineUpdateOutputSchema]) expect(schema.parse(projected)).toEqual(projected);
    // The list tools' view is the same report without its agent notes: the reading stays (TASK-952). It
    // leaves a get-done task's steps out too (TASK-948), so the tools' view has no steps key at all.
    const { agentNotes: _agentNotes, ...listed } = projected.task!;
    const { steps: _steps, ...toolView } = projected;
    expect(C.RoutineListToolOutputSchema.parse({ routines: [{ ...toolView, task: listed }] })).toEqual({ routines: [{ ...toolView, task: listed }] });
    expect(C.RoutineUpdateToolOutputSchema.parse({ ...toolView, task: listed }).task?.reading).toEqual(OPEN_3);
    // Field by field, never a spread: a key the store's reading picked up never reaches the view.
    const stray = { ...task, task: { ...task.task!, reading: { ...OPEN_3, unit: 'tickets' } as StoredReading } };
    expect(routineView(stray, 'owner', true).task?.reading).toStrictEqual(OPEN_3);
    // Anyone but its owner sees the routine without its task state, its reading included.
    const teammate = routineView(task, 'teammate', true);
    expect(teammate).toEqual({ ...projected, permissions: routinePermissions(task, 'teammate', true), task: null });
    expect(C.RoutineViewSchema.parse(teammate)).toEqual(teammate);
    // A repeat routine shows none, even when its row holds some.
    const repeat = routineView({ ...task, kind: 'repeat', goodWhen: null }, 'owner', true);
    expect(repeat.task).toBeNull();
    expect(C.RoutineViewSchema.parse(repeat)).toEqual(repeat);
    for (const view of [teammate, repeat]) expect(JSON.stringify(view)).not.toContain(OPEN_3.label);
  });
  describe("a task's misses (TASK-930)", () => {
    const task: StoredRoutine = {
      ...row,
      ...C.RoutineDefinitionSchema.parse({
        name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
        kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
      }),
      noRecentUpdate: { inARow: 3, reason: 'brief-too-long', at: new Date('2030-01-01T00:10:00Z'), autoPausedAt: null },
    };
    it('projects them for its owner only, never for a repeat routine', () => {
      const projected = routineView(task, 'owner', true);
      expect(projected.noRecentUpdate).toEqual({ inARow: 3, reason: 'brief-too-long', at: '2030-01-01T00:10:00.000Z', autoPaused: false });
      // Anyone but its owner sees the routine without them.
      const teammate = routineView(task, 'teammate', true);
      expect(teammate).toEqual({ ...projected, permissions: routinePermissions(task, 'teammate', true), noRecentUpdate: null });
      // A repeat routine shows none, even when its row holds some.
      const repeat = routineView({ ...task, kind: 'repeat', goodWhen: null }, 'owner', true);
      expect(repeat.noRecentUpdate).toBeNull();
      // Every answer takes each view: the services' and, with no report to project, the tools', which
      // leave a get-done task's steps out (TASK-948).
      for (const view of [projected, teammate, repeat]) {
        for (const schema of [C.RoutineViewSchema, C.RoutineGetOutputSchema, C.RoutineCreateOutputSchema, C.RoutineUpdateOutputSchema]) {
          expect(schema.parse(view)).toEqual(view);
        }
        const { steps: _steps, ...toolView } = view;
        expect(C.RoutineUpdateToolOutputSchema.parse(toolView)).toEqual(toolView);
        expect(C.RoutineListToolOutputSchema.parse({ routines: [toolView] })).toEqual({ routines: [toolView] });
      }
    });
    it('says ax paused the task only while it is still paused', () => {
      const pausedAt = new Date('2030-01-01T01:00:00Z');
      const fifth: StoredRoutine = { ...task, noRecentUpdate: { inARow: 5, reason: 'no-report', at: new Date('2030-01-01T00:55:00Z'), autoPausedAt: pausedAt } };
      expect(routineView({ ...fifth, enabled: false }, 'owner', true).noRecentUpdate).toEqual({ inARow: 5, reason: 'no-report', at: '2030-01-01T00:55:00.000Z', autoPaused: true });
      // Running again with the pause time still set (resumed by older code after a rollback, a hand edit): not paused by ax.
      expect(routineView({ ...fifth, enabled: true }, 'owner', true).noRecentUpdate).toMatchObject({ inARow: 5, autoPaused: false });
      // A person's pause, with misses ax hadn't acted on yet.
      expect(routineView({ ...task, enabled: false }, 'owner', true).noRecentUpdate).toMatchObject({ inARow: 3, autoPaused: false });
    });
  });
  describe("a get-done task's steps (TASK-948)", () => {
    const stored: StoredStep[] = [
      { id: 's000001', text: 'Ask Dana to review the billing articles', done: false, addedBy: 'person' },
      { id: 's000002', text: 'Export every article', done: true, addedBy: 'agent' },
    ];
    const task: StoredRoutine = {
      ...row,
      ...C.RoutineDefinitionSchema.parse({
        name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
        kind: 'get-done', goodWhen: 'Every article is on the new site.',
      }),
      steps: stored,
    };
    it('projects them for its owner only, as copies, and for no other kind', () => {
      const projected = routineView(task, 'owner', true);
      expect(projected.steps).toEqual(stored);
      expect(projected.steps[0]).not.toBe(stored[0]);
      // Anyone but its owner sees the routine without them, and a stay-on-top task shows none, even when its row holds some.
      const teammate = routineView(task, 'teammate', true);
      expect(teammate.steps).toEqual([]);
      const stayOnTop = routineView({ ...task, kind: 'stay-on-top' }, 'owner', true);
      expect(stayOnTop.steps).toEqual([]);
      for (const view of [projected, teammate, stayOnTop]) {
        for (const schema of [C.RoutineViewSchema, C.RoutineGetOutputSchema, C.RoutineCreateOutputSchema, C.RoutineUpdateOutputSchema]) {
          expect(schema.parse(view)).toEqual(view);
        }
      }
      // The services' view isn't a tool view: routine_list and routine_update leave the steps out.
      expect(C.RoutineUpdateToolOutputSchema.safeParse(projected).success).toBe(false);
      expect(C.RoutineListToolOutputSchema.safeParse({ routines: [projected] }).success).toBe(false);
      // Who added a step is one of the two the host writes.
      expect(C.RoutineViewSchema.safeParse({ ...projected, steps: [{ ...stored[1], addedBy: 'robot' }] }).success).toBe(false);
    });
    it('answers a report with its step counts only when it sent changes', () => {
      expect(C.RoutineReportOutputSchema.parse({ recorded: true })).toStrictEqual({ recorded: true });
      const counted = { recorded: true, steps: { applied: 2, skipped: 1 } };
      expect(C.RoutineReportOutputSchema.parse(counted)).toStrictEqual(counted);
      expect(C.RoutineReportOutputSchema.safeParse({ recorded: true, steps: { applied: 2 } }).success).toBe(false);
    });
  });
  describe("a get-done task's finish date (TASK-951)", () => {
    const task: StoredRoutine = {
      ...row,
      ...C.RoutineDefinitionSchema.parse({
        name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
        kind: 'get-done', goodWhen: 'Every article is on the new site.',
      }),
      steps: [{ id: 's000001', text: 'Export every article', done: true, addedBy: 'agent' }],
      finishBy: '2026-11-14',
    };
    it("projects a get-done task's finish date to whoever sees it, and none for any other kind", () => {
      const projected = routineView(task, 'owner', true);
      expect(projected.finishBy).toBe('2026-11-14');
      // Not owner-gated, unlike the task's steps: the date is about the work, and holds no agent text.
      const teammate = routineView(task, 'teammate', true);
      expect(teammate).toEqual({ ...projected, permissions: routinePermissions(task, 'teammate', true), steps: [] });
      // The list tools' view keeps it: they leave only the agent notes and the steps out.
      const { steps: _steps, ...toolView } = projected;
      expect(C.RoutineListToolOutputSchema.parse({ routines: [toolView] })).toEqual({ routines: [toolView] });
      expect(C.RoutineUpdateToolOutputSchema.parse(toolView)).toEqual(toolView);
      // Any other kind shows none, even when its row holds one.
      const stayOnTop = routineView({ ...task, kind: 'stay-on-top' }, 'owner', true);
      const repeat = routineView({ ...task, kind: 'repeat', goodWhen: null }, 'owner', true);
      for (const view of [stayOnTop, repeat]) expect(view.finishBy, view.kind).toBeNull();
      for (const view of [projected, teammate, stayOnTop, repeat]) {
        for (const schema of [C.RoutineViewSchema, C.RoutineGetOutputSchema, C.RoutineCreateOutputSchema, C.RoutineUpdateOutputSchema]) {
          expect(schema.parse(view)).toEqual(view);
        }
      }
      // Required, so a view from a producer that doesn't know it is refused; and a type, not the rule (TASK-913).
      const { finishBy: _finishBy, ...without } = projected;
      expect(C.RoutineViewSchema.safeParse(without).success).toBe(false);
      expect(C.RoutineViewSchema.safeParse({ ...projected, finishBy: 3 }).success).toBe(false);
      expect(C.RoutineViewSchema.parse({ ...projected, finishBy: 'not a date' }).finishBy).toBe('not a date');
    });
  });
  describe("a get-done task's claim and Done (TASK-950)", () => {
    // Both at once, which a real row never holds (Mark done takes the claim back), so one row shows both projections.
    const task: StoredRoutine = {
      ...row,
      ...C.RoutineDefinitionSchema.parse({
        name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
        kind: 'get-done', goodWhen: 'Every article is on the new site.', enabled: false,
      }),
      nextRunAt: null,
      task: {
        status: 'needs-you', update: 'Every article is on the new site.', ask: null, agentNotes: null,
        reportedAt: new Date('2030-01-01T01:00:00Z'), reading: null, doneClaimed: true,
      },
      done: { at: new Date('2030-01-01T02:00:00Z'), byUserId: 'owner' },
    };
    it('projects them for its owner only, and for no other kind: when it was marked done, never who', () => {
      const projected = routineView(task, 'owner', true);
      expect(projected.done).toStrictEqual({ at: '2030-01-01T02:00:00.000Z' });
      expect(projected.task).toMatchObject({ status: 'needs-you', doneClaimed: true });
      for (const schema of [C.RoutineViewSchema, C.RoutineGetOutputSchema, C.RoutineCreateOutputSchema, C.RoutineUpdateOutputSchema]) {
        expect(schema.parse(projected)).toEqual(projected);
      }
      // The tools' views carry both: routine_list's report keeps the claim, and done is beside it.
      const { agentNotes: _agentNotes, ...listed } = projected.task!;
      const { steps: _steps, ...toolView } = projected;
      expect(C.RoutineListToolOutputSchema.parse({ routines: [{ ...toolView, task: listed }] })).toEqual({ routines: [{ ...toolView, task: listed }] });
      expect(C.RoutineUpdateToolOutputSchema.parse({ ...toolView, task: listed })).toMatchObject({ done: projected.done, task: { doneClaimed: true } });
      // Anyone but its owner sees the routine without either.
      const teammate = routineView(task, 'teammate', true);
      expect(teammate).toEqual({ ...projected, permissions: routinePermissions(task, 'teammate', true), task: null, done: null });
      // No other kind is ever done, nor claimed, even when its row holds both.
      const stayOnTop = routineView({ ...task, kind: 'stay-on-top' }, 'owner', true);
      expect(stayOnTop.done).toBeNull();
      expect(stayOnTop.task).toMatchObject({ status: 'needs-you', doneClaimed: false });
      for (const view of [teammate, stayOnTop]) expect(C.RoutineViewSchema.parse(view)).toEqual(view);
      // Who marked it done never crosses: the view is strict, and the store's shape is refused.
      expect(JSON.stringify(projected)).not.toContain('byUserId');
      expect(C.RoutineViewSchema.safeParse({ ...projected, done: { at: projected.done!.at, byUserId: 'owner' } }).success).toBe(false);
      expect(C.RoutineViewSchema.safeParse({ ...projected, done: { at: new Date('2030-01-01T02:00:00Z') } }).success).toBe(false);
    });
    it('answers Mark done with done true, and nothing else', () => {
      expect(C.RoutineCompleteOutputSchema.parse({ done: true })).toStrictEqual({ done: true });
      for (const output of [{ done: false }, {}, { done: true, at: '2030-01-01T02:00:00.000Z' }]) {
        expect(C.RoutineCompleteOutputSchema.safeParse(output).success, JSON.stringify(output)).toBe(false);
      }
    });
  });
  it("declares every canonical service, including the host-only secret lifecycle, a check-in's report and clearing its notes, naming a check-in's task, a person's replies and step changes, a task's finish date, finishing or reopening a task, and a person's copy of a task", () => {
    expect(ROUTINE_SERVICES).toHaveLength(25);
    expect(ROUTINE_SERVICES).toContain('routines:set-webhook-secret');
    expect(ROUTINE_SERVICES).toContain('routines:report');
    expect(ROUTINE_SERVICES).toContain('routines:clear-notes');
    expect(ROUTINE_SERVICES).toContain('routines:tasks-for-conversations');
    expect(ROUTINE_SERVICES).toContain('routines:reply');
    expect(ROUTINE_SERVICES).toContain('routines:recent-replies');
    expect(ROUTINE_SERVICES).toContain('routines:set-steps');
    expect(ROUTINE_SERVICES).toContain('routines:set-finish-by');
    expect(ROUTINE_SERVICES).toContain('routines:complete');
    expect(ROUTINE_SERVICES).toContain('routines:reopen');
    expect(ROUTINE_SERVICES).toContain('routines:duplicate');
    expect(C.RoutineSecretOutputSchema.parse({ saved: true })).toEqual({ saved: true });
    expect(C.RoutineClearNotesOutputSchema.parse({ cleared: true })).toEqual({ cleared: true });
    expect(C.RoutineSetFinishByOutputSchema.parse({ finishBy: '2026-11-14' })).toStrictEqual({ finishBy: '2026-11-14' });
  });
  it("answers a person's step changes with the steps and a count, and nothing else (TASK-949)", () => {
    const answer = { steps: [{ id: 's000001', text: 'Ask Dana to review billing', done: false, addedBy: 'person' }], skipped: 1 };
    expect(C.RoutineSetStepsOutputSchema.parse(answer)).toStrictEqual(answer);
    // Never a change's text beside the list.
    expect(() => C.RoutineSetStepsOutputSchema.parse({ ...answer, text: 'Ask Dana to review billing' })).toThrow();
  });
  it('answers a copy with its id alone (TASK-953)', () => {
    expect(C.RoutineDuplicateOutputSchema.parse({ routineId: 'rtn_1' })).toStrictEqual({ routineId: 'rtn_1' });
    // Never the copy's name, or anything else of it, beside its id.
    expect(() => C.RoutineDuplicateOutputSchema.parse({ routineId: 'rtn_1', name: 'Copy of Notify' })).toThrow();
  });
  it("answers a reply with its id and what its check-in did, and reads a reply back without its task's owner (TASK-931)", () => {
    expect(C.RoutineReplyOutputSchema.parse({ replyId: 'reply_1', checkIn: 'started' })).toStrictEqual({ replyId: 'reply_1', checkIn: 'started' });
    // Never the text back.
    expect(() => C.RoutineReplyOutputSchema.parse({ replyId: 'reply_1', checkIn: 'started', text: 'Refunds under $100 are fine.' })).toThrow();
    const reply = { replyId: 'reply_1', authorUserId: 'owner', text: 'Refunds under $100 are fine.', sentAt: '2031-01-01T00:00:00.000Z' };
    expect(C.RoutineRecentRepliesOutputSchema.parse({ replies: [reply] })).toStrictEqual({ replies: [reply] });
    expect(() => C.RoutineRecentRepliesOutputSchema.parse({ replies: [{ ...reply, ownerUserId: 'owner' }] })).toThrow();
  });
  it("projects a check-in as its conversation, its task's id and its name, and nothing else", () => {
    const checkIn = { conversationId: 'c1', routineId: 'routine', name: 'Support queue' };
    expect(C.RoutineTasksForConversationsOutputSchema.parse({ checkIns: [checkIn] })).toStrictEqual({ checkIns: [checkIn] });
    // Never the routine's owner, and nothing beside the list.
    expect(() => C.RoutineTasksForConversationsOutputSchema.parse({ checkIns: [{ ...checkIn, ownerUserId: 'owner' }] })).toThrow();
    expect(() => C.RoutineTasksForConversationsOutputSchema.parse({ checkIns: [checkIn], kind: 'stay-on-top' })).toThrow();
  });
});
