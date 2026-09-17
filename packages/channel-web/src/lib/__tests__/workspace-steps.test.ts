/**
 * The one shaping function both workspace paths call.
 *
 * Everything here is about what a reader ends up believing: that a failed step
 * says it failed, that a held one says it is waiting on them, that the header's
 * number is the number of rows underneath it, and that no MCP wire name ever
 * reaches the screen.
 */
import { describe, expect, it } from 'vitest';
import {
  UNNAMED_STEP,
  applyToolResult,
  applyToolUse,
  shapeSteps,
  type WorkspaceToolCall,
} from '../workspace-steps';

const done = (over: Partial<WorkspaceToolCall> = {}): WorkspaceToolCall => ({
  id: 'tu1',
  name: 'Bash',
  status: 'done',
  ...over,
});

describe('shapeSteps', () => {
  it('is null for a turn that ran nothing, so no empty disclosure appears', () => {
    expect(shapeSteps([])).toBeNull();
  });

  it('names a call by its host-authored phrase, never by the mcp wire name', () => {
    const panel = shapeSteps([
      done({ name: 'mcp__linear__create_issue', phrase: 'Filing a Linear issue' }),
    ]);
    expect(panel?.steps).toEqual(['Filing a Linear issue']);
  });

  it('falls back to the STRIPPED tool name when there is no phrase', () => {
    const panel = shapeSteps([done({ name: 'mcp__ax-sandbox-tools__artifact_publish' })]);
    expect(panel?.steps).toEqual(['artifact_publish']);
  });

  it('keeps a row, named, when nothing legible survives fencing', () => {
    // A tool name made entirely of the characters that rewrite a surface. The
    // row still appears: a shorter list would disagree with what happened.
    const panel = shapeSteps([done({ name: '\u202E\u200B' })]);
    expect(panel?.steps).toEqual([UNNAMED_STEP]);
  });

  it('flattens a name that tries to rewrite the line it sits on', () => {
    const panel = shapeSteps([done({ phrase: 'Reading\u202Egnp.dorp-eteled' })]);
    expect(panel?.steps[0]).toBe('Reading gnp.dorp-eteled');
    expect(panel?.steps[0]).not.toContain('\u202E');
  });

  it('bounds a name that arrived without one', () => {
    const panel = shapeSteps([done({ phrase: 'x'.repeat(500) })]);
    expect(panel?.steps[0]?.length).toBeLessThanOrEqual(80);
    expect(panel?.steps[0]?.endsWith('…')).toBe(true);
  });

  it('says a failed step failed, in words, not only in colour', () => {
    const panel = shapeSteps([done({ status: 'failed', phrase: 'Sending the email' })]);
    expect(panel?.steps).toEqual(["Sending the email — didn't finish"]);
    expect(panel?.label).toBe("1 step, 1 didn't finish");
  });

  it('says a held step is waiting on the reader', () => {
    const panel = shapeSteps([done({ status: 'waiting', phrase: 'Sending the email' })]);
    expect(panel?.steps).toEqual(['Sending the email — waiting for you']);
    expect(panel?.label).toBe('1 step, 1 waiting for you');
  });

  it('says a step still in flight is in progress', () => {
    const panel = shapeSteps([done({ status: 'running', phrase: 'Searching the web' })]);
    expect(panel?.steps).toEqual(['Searching the web — in progress']);
    expect(panel?.label).toBe('1 step, 1 in progress');
  });

  it('leads with the failure when a panel holds both a failure and a hold', () => {
    /*
      Across a panel, failure outranks a hold — the hold has the composer line
      and the approval card to announce itself, the failure has nowhere else.
      Per CALL the ordering is the other way round, which the two rows show.
    */
    const panel = shapeSteps([
      done({ id: 'a', status: 'waiting', phrase: 'Sending the email' }),
      done({ id: 'b', status: 'failed', phrase: 'Reading the calendar' }),
    ]);
    expect(panel?.label).toBe("2 steps, 1 didn't finish");
    expect(panel?.steps).toEqual([
      'Sending the email — waiting for you',
      "Reading the calendar — didn't finish",
    ]);
  });

  it('reports the count it renders, for every size', () => {
    for (const n of [1, 2, 7]) {
      const calls = Array.from({ length: n }, (_, i) => done({ id: `tu${i}` }));
      const panel = shapeSteps(calls);
      expect(panel).not.toBeNull();
      const reported = /^(\d+) steps?\b/.exec(panel!.label);
      expect(reported).not.toBeNull();
      expect(Number(reported![1])).toBe(panel!.steps.length);
      expect(panel!.steps).toHaveLength(n);
    }
  });
});

describe('the live accumulator', () => {
  it('starts a fresh call as running — a call made is not a call finished', () => {
    // `running` is the internal status word; the rendered row says "in progress".
    const calls = applyToolUse([], {
      toolCallId: 'tu1',
      toolName: 'Bash',
      activityPhrase: 'Running a command',
    });
    expect(calls).toEqual([
      { id: 'tu1', name: 'Bash', phrase: 'Running a command', status: 'running' },
    ]);
  });

  it('does not double-count a replayed tool-use', () => {
    const frame = { toolCallId: 'tu1', toolName: 'Bash', activityPhrase: undefined };
    const once = applyToolUse([], frame);
    const twice = applyToolUse(once, frame);
    expect(twice).toHaveLength(1);
  });

  it('does not walk a settled row back to running on a replay', () => {
    const frame = { toolCallId: 'tu1', toolName: 'Bash', activityPhrase: undefined };
    const settled = applyToolResult(applyToolUse([], frame), {
      toolCallId: 'tu1',
      isError: true,
    });
    expect(applyToolUse(settled, frame)[0]?.status).toBe('failed');
  });

  it('revises the row a result answers, rather than adding a second one', () => {
    const calls = applyToolResult(
      applyToolUse([], { toolCallId: 'tu1', toolName: 'Bash' }),
      { toolCallId: 'tu1' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('done');
  });

  it('reads a held result as waiting even when it also carries an error', () => {
    // The runners omit `is_error` on a hold, but a stale or foreign row
    // carrying both must still read as waiting on a person, not as a failure.
    const calls = applyToolResult(
      applyToolUse([], { toolCallId: 'tu1', toolName: 'Bash' }),
      { toolCallId: 'tu1', isError: true, held: true },
    );
    expect(calls[0]?.status).toBe('waiting');
  });

  it('drops a result for a call it never saw rather than inventing a row', () => {
    const calls = applyToolResult([], { toolCallId: 'ghost' });
    expect(calls).toEqual([]);
  });

  it('keeps call order, so the panel reads in the order things happened', () => {
    let calls = applyToolUse([], { toolCallId: 'a', toolName: 'First' });
    calls = applyToolUse(calls, { toolCallId: 'b', toolName: 'Second' });
    calls = applyToolResult(calls, { toolCallId: 'b' });
    calls = applyToolResult(calls, { toolCallId: 'a' });
    expect(shapeSteps(calls)?.steps).toEqual(['First', 'Second']);
  });
});
