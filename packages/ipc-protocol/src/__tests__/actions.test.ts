import { describe, it, expect } from 'vitest';
import { HOLD_NOTE_MAX } from '@ax/core';
import {
  ToolPreCallResponseSchema,
  SessionNextMessageResponseSchema,
  SkillProposeResponseSchema,
  ArtifactPublishRequestSchema,
  ArtifactPublishResponseSchema,
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

describe('artifact.publish wire', () => {
  const base = { conversationId: 'conv-1', sha256: 'a'.repeat(64), path: 'reports/q3.pdf' };

  it('artifact.publish requires title and refuses the old displayName / mediaType / size fields', () => {
    expect(ArtifactPublishRequestSchema.safeParse({ ...base, title: 'Report' }).success).toBe(true);
    expect(ArtifactPublishRequestSchema.safeParse({ ...base, title: 'Report', displayName: 'r.pdf' }).success).toBe(false);
    expect(ArtifactPublishRequestSchema.safeParse({ ...base, title: 'Report', mediaType: 'application/pdf' }).success).toBe(false);
    expect(ArtifactPublishRequestSchema.safeParse({ ...base, title: 'Report', size: 3 }).success).toBe(false);
    expect(ArtifactPublishRequestSchema.safeParse(base).success).toBe(false);
  });

  it('caps the title at 200 and takes an optional artifact id of the attachment-id shape', () => {
    expect(ArtifactPublishRequestSchema.safeParse({ ...base, title: 'x'.repeat(200) }).success).toBe(true);
    expect(ArtifactPublishRequestSchema.safeParse({ ...base, title: 'x'.repeat(201) }).success).toBe(false);
    expect(ArtifactPublishRequestSchema.safeParse({ ...base, title: 'R', artifactId: 'abc_123' }).success).toBe(true);
    expect(ArtifactPublishRequestSchema.safeParse({ ...base, title: 'R', artifactId: '../x' }).success).toBe(false);
  });

  it('answers {artifactId, version, title, kind, extension} and no download URL', () => {
    const ok = { artifactId: 'abc', version: 2, title: 'Report', kind: 'document', extension: 'PDF' };
    expect(ArtifactPublishResponseSchema.parse({ ...ok, downloadUrl: 'ax://artifact/abc' })).toEqual(ok);
    expect(ArtifactPublishResponseSchema.safeParse({ ...ok, version: 0 }).success).toBe(false);
    expect(ArtifactPublishResponseSchema.safeParse({ ...ok, kind: 'video' }).success).toBe(false);
  });
});
