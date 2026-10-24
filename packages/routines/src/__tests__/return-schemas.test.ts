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
  lastStatus: null, lastError: null, lastWarning: null, task: null, noRecentUpdate: null, steps: [],
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
        agentNotes: 'Order 1234 waits on a refund.', reportedAt: new Date('2030-01-01T00:05:00Z'), reading: OPEN_3,
      },
    };
    const projected = routineView(task, 'owner', true);
    expect(projected.task).toEqual({
      status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?',
      reading: OPEN_3, reportedAt: '2030-01-01T00:05:00.000Z', agentNotes: 'Order 1234 waits on a refund.',
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
  it("declares every canonical service, including the host-only secret lifecycle, a check-in's report and clearing its notes, naming a check-in's task, and a person's replies", () => {
    expect(ROUTINE_SERVICES).toHaveLength(20);
    expect(ROUTINE_SERVICES).toContain('routines:set-webhook-secret');
    expect(ROUTINE_SERVICES).toContain('routines:report');
    expect(ROUTINE_SERVICES).toContain('routines:clear-notes');
    expect(ROUTINE_SERVICES).toContain('routines:tasks-for-conversations');
    expect(ROUTINE_SERVICES).toContain('routines:reply');
    expect(ROUTINE_SERVICES).toContain('routines:recent-replies');
    expect(C.RoutineSecretOutputSchema.parse({ saved: true })).toEqual({ saved: true });
    expect(C.RoutineClearNotesOutputSchema.parse({ cleared: true })).toEqual({ cleared: true });
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
