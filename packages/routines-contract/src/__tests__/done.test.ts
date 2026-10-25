import { describe, expect, it } from 'vitest';
import {
  RoutineCompleteInputSchema, RoutineCompleteOutputSchema, RoutineReopenInputSchema, RoutineReopenOutputSchema,
  RoutineReplyOutputSchema, RoutineReportInputSchema, RoutineReportToolInputSchema, RoutineToolDescriptions, RoutineToolInputSchemas,
  RoutineToolJsonSchemas,
} from '../index.js';

// TASK-950: a "get-done" task's agent says it thinks the task is finished by sending done true with its report.
// Every reader of a claim keys on the report's status, so a claim comes with "needs-you". The rule's message is
// for the contract's own callers: the agent gets only the field's name (core's fixed template). Only a person
// marks a task done (routines:complete) or tells the agent what's left (routines:reopen).
const report = { status: 'needs-you', update: 'Every article is on the new site.' } as const;
const binding = { agentId: 'a', dispatchId: 'd', ask: null };
const NEEDS_YOU = 'When you think the task is done, send status "needs-you" with done true.';

/** The same report on the tool's input and on the service's, which also carries the binding. */
const both = (input: Record<string, unknown>) => [
  ['tool', RoutineReportToolInputSchema.safeParse(input)],
  ['service', RoutineReportInputSchema.safeParse({ ...input, ...binding })],
] as const;
type Parsed = { success: true } | { success: false; error: { issues: readonly { path: (string | number)[]; message: string }[] } };
/** A parse's issues as [path, message], or [] when it parses. */
const issuesOf = (result: Parsed): [(string | number)[], string][] =>
  result.success ? [] : result.error.issues.map(issue => [issue.path, issue.message]);

describe('a report’s done (TASK-950)', () => {
  it('takes done true with needs-you, on the tool and on the service, and reads it absent as no claim', () => {
    expect(RoutineReportToolInputSchema.parse({ ...report, done: true }).done).toBe(true);
    expect(RoutineReportInputSchema.parse({ ...report, ...binding, done: true }).done).toBe(true);
    expect('done' in RoutineReportToolInputSchema.parse(report)).toBe(false);
    expect('done' in RoutineReportInputSchema.parse({ ...report, ...binding })).toBe(false);
    // false is no claim, so it needs no "needs-you".
    const notDone = { ...report, status: 'on-track', done: false } as const;
    expect(RoutineReportToolInputSchema.parse(notDone).done).toBe(false);
    expect(RoutineReportInputSchema.parse({ ...notDone, ...binding }).done).toBe(false);
  });

  it.each(['on-track', 'off-track'] as const)('refuses done true with %s, naming done, in words that say what to send', status => {
    for (const [name, result] of both({ ...report, status, done: true })) {
      expect(result.success, name).toBe(false);
      expect(issuesOf(result), name).toEqual([[['done'], NEEDS_YOU]]);
    }
  });

  it('refuses a done that isn’t true or false', () => {
    for (const done of ['true', 1, null]) {
      for (const [name, result] of both({ ...report, done })) {
        expect(result.success, `${name} ${JSON.stringify(done)}`).toBe(false);
        expect(issuesOf(result).map(([path]) => path), `${name} ${JSON.stringify(done)}`).toEqual([['done']]);
      }
    }
  });

  it('the complete and reopen inputs are strict, and reopen’s text is a reply', () => {
    const complete = { agentId: 'a', routineId: 'r', requestId: 'q' } as const;
    expect(RoutineCompleteInputSchema.parse(complete)).toEqual(complete);
    for (const extra of [{ actorUserId: 'u' }, { text: 'x' }, { untrustedField: 1 }]) {
      expect(RoutineCompleteInputSchema.safeParse({ ...complete, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
    const reopen = { ...complete, text: 'Also redirect the old links.' } as const;
    expect(RoutineReopenInputSchema.parse(reopen)).toEqual(reopen);
    for (const extra of [{ actorUserId: 'u' }, { untrustedField: 1 }]) {
      expect(RoutineReopenInputSchema.safeParse({ ...reopen, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
    // Every key is required, the request id included: a retried press is told apart by it.
    for (const key of ['agentId', 'routineId', 'requestId'] as const) {
      const { [key]: _completeKey, ...completeRest } = complete;
      const { [key]: _reopenKey, ...reopenRest } = reopen;
      expect(RoutineCompleteInputSchema.safeParse(completeRest).success, key).toBe(false);
      expect(RoutineReopenInputSchema.safeParse(reopenRest).success, key).toBe(false);
    }
    expect(issuesOf(RoutineReopenInputSchema.safeParse({ ...reopen, text: '   ' }))).toEqual([[['text'], 'Write a reply first.']]);
    expect(issuesOf(RoutineReopenInputSchema.safeParse({ ...reopen, text: 'x'.repeat(2001) }))).toEqual([[['text'], 'A reply can be up to 2,000 characters.']]);
    expect(RoutineReopenInputSchema.safeParse(complete).success).toBe(false);
  });

  it('answers done true, and reopen answers as a reply does', () => {
    expect(RoutineCompleteOutputSchema.parse({ done: true })).toEqual({ done: true });
    for (const output of [{ done: false }, {}, { done: true, at: 'x' }]) {
      expect(RoutineCompleteOutputSchema.safeParse(output).success, JSON.stringify(output)).toBe(false);
    }
    expect(RoutineReopenOutputSchema).toBe(RoutineReplyOutputSchema);
  });

  it('pins the complete and reopen key sets, so an added field is a decision', () => {
    expect(Object.keys(RoutineCompleteInputSchema.shape).sort()).toEqual(['agentId', 'requestId', 'routineId']);
    expect(Object.keys(RoutineReopenInputSchema.shape).sort()).toEqual(['agentId', 'requestId', 'routineId', 'text']);
    expect(Object.keys(RoutineCompleteOutputSchema.shape)).toEqual(['done']);
  });

  it('applies the rule through the tool map that prepare and the approval path parse with', () => {
    expect(RoutineToolInputSchemas.routine_report).toBe(RoutineReportToolInputSchema);
    expect(RoutineToolInputSchemas.routine_report.safeParse({ status: 'on-track', update: 'x', done: true }).success).toBe(false);
  });

  it('offers the model done as an optional boolean', () => {
    const json = RoutineToolJsonSchemas.routine_report;
    expect(json.properties.done).toEqual({
      type: 'boolean',
      description: 'For a "get-done" task only: true when you think the whole task is finished. Send it with status "needs-you". Leave it out otherwise.',
    });
    expect(json.required).toEqual(['status', 'update']);
  });

  it('the tools say what done means and who marks a task done', () => {
    const words = RoutineToolDescriptions.routine_report;
    expect(words).toContain('a second call in the same check-in replaces the first’s status, update, ask, notes, reading and done, and applies its own steps changes');
    // Right before the line on who reads the report.
    expect(words).toContain('or a full list). done is for a "get-done" task only. Send true, with status "needs-you", when you think the whole task is finished: the person then marks it done or tells you what’s left. Only a person marks a task done. A later report without done takes the claim back. The person can read your report, your notes and your steps.');
    const done = ' A task’s done is { at } once a person marked a "get-done" task finished: it no longer checks in, and only a person can reopen it. It is null otherwise, and for a task another person owns.';
    for (const name of ['routine_list', 'routine_get'] as const) {
      const description = RoutineToolDescriptions[name];
      expect(description, name).toContain('A task’s task field is its latest report (status, update, ask, reading, doneClaimed, reportedAt)');
      expect(description, name).toContain('with its own label, or null. doneClaimed is true when that report said a "get-done" task is finished and the person hasn’t marked it done yet.');
      // Last, after the misses.
      expect(description.slice(-done.length), name).toBe(done);
    }
    expect(RoutineToolDescriptions.routine_update).toContain('A retry of an edit that already went through answers with task, noRecentUpdate, finishBy and done null, so read the task with routine_get.');
  });
});
