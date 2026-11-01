import { describe, it, expect } from 'vitest';
import { HOLD_NOTE_MAX } from '@ax/core';
import {
  ToolPreCallResponseSchema,
  SessionNextMessageResponseSchema,
  SkillProposeResponseSchema,
  PRE_CALL_REJECT_REASON_MAX,
  SKILL_PROPOSE_REASON_MAX,
} from '../actions.js';

describe('ToolPreCallResponseSchema hold arm', () => {
  it('accepts a hold verdict', () => {
    const parsed = ToolPreCallResponseSchema.parse({
      verdict: 'hold',
      decisionId: 'dec_1',
      note: 'I stopped before sending this. Check the queue.',
    });
    expect(parsed).toEqual({
      verdict: 'hold',
      decisionId: 'dec_1',
      note: 'I stopped before sending this. Check the queue.',
    });
  });

  it('rejects a hold with no decision id', () => {
    expect(() =>
      ToolPreCallResponseSchema.parse({ verdict: 'hold', decisionId: '', note: 'n' }),
    ).toThrow();
  });

  it('rejects a hold with an empty note', () => {
    // A hold with nothing to say is worse than a deny: the model is told to
    // stop and relay, and there is nothing to relay.
    expect(() =>
      ToolPreCallResponseSchema.parse({ verdict: 'hold', decisionId: 'dec_1', note: '' }),
    ).toThrow();
  });

  it('rejects a note past the 2000-character ceiling', () => {
    // `hold()` in @ax/core clamps to this same ceiling. This test is the wire
    // boundary for anything that does NOT go through that constructor.
    expect(() =>
      ToolPreCallResponseSchema.parse({
        verdict: 'hold',
        decisionId: 'dec_1',
        note: 'x'.repeat(2001),
      }),
    ).toThrow();
    expect(() =>
      ToolPreCallResponseSchema.parse({
        verdict: 'hold',
        decisionId: 'dec_1',
        note: 'x'.repeat(2000),
      }),
    ).not.toThrow();
  });
});

describe('ToolPreCallResponseSchema reject arm', () => {
  it('caps a deny reason at the same 2000 characters as a hold note', () => {
    // The host handler truncates before it parses; this is the wire boundary
    // for anything that does not go through that handler.
    expect(PRE_CALL_REJECT_REASON_MAX).toBe(2000);
    expect(
      ToolPreCallResponseSchema.safeParse({ verdict: 'reject', reason: 'x'.repeat(2001) })
        .success,
    ).toBe(false);
    expect(
      ToolPreCallResponseSchema.safeParse({ verdict: 'reject', reason: 'x'.repeat(2000) })
        .success,
    ).toBe(true);
  });
});

// TASK-781 — every remaining free-text reason/note on these wires has a cap,
// and the note caps are @ax/core's HOLD_NOTE_MAX, not a repeated literal.
describe('wire reason/note caps (TASK-781)', () => {
  it('the deny reason and both note fields share HOLD_NOTE_MAX', () => {
    expect(PRE_CALL_REJECT_REASON_MAX).toBe(HOLD_NOTE_MAX);
    const holdAt = (n: number) =>
      ToolPreCallResponseSchema.safeParse({
        verdict: 'hold',
        decisionId: 'dec_1',
        note: 'x'.repeat(n),
      }).success;
    expect(holdAt(HOLD_NOTE_MAX)).toBe(true);
    expect(holdAt(HOLD_NOTE_MAX + 1)).toBe(false);

    const resolvedAt = (n: number) =>
      SessionNextMessageResponseSchema.safeParse({
        type: 'decision-resolved',
        decisionId: 'dec_1',
        outcome: 'approved',
        note: 'x'.repeat(n),
        cursor: 1,
      }).success;
    expect(resolvedAt(HOLD_NOTE_MAX)).toBe(true);
    expect(resolvedAt(HOLD_NOTE_MAX + 1)).toBe(false);
  });

  it("caps skill.propose's reason", () => {
    const at = (n: number) =>
      SkillProposeResponseSchema.safeParse({
        skillId: 's',
        status: 'quarantined',
        reason: 'x'.repeat(n),
      }).success;
    expect(at(SKILL_PROPOSE_REASON_MAX)).toBe(true);
    expect(at(SKILL_PROPOSE_REASON_MAX + 1)).toBe(false);
  });
});
