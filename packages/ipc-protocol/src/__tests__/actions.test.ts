import { describe, it, expect } from 'vitest';
import { HOLD_NOTE_MAX } from '@ax/core';
import {
  WorkspaceCommitNotifyResponseSchema,
  WorkspaceCommitNotifyRequestSchema,
  WorkspaceCommitBundleQuerySchema,
  ToolPreCallResponseSchema,
  SessionNextMessageResponseSchema,
  SkillProposeResponseSchema,
  PRE_CALL_REJECT_REASON_MAX,
  SKILL_PROPOSE_REASON_MAX,
  WORKSPACE_COMMIT_REASON_MAX,
  WORKSPACE_COMMIT_REJECT_REASON_MAX,
} from '../actions.js';

describe('WorkspaceCommitNotifyResponseSchema', () => {
  it('accepted:false carries only the actualParent re-sync signal (no inline bundle)', () => {
    const resync = WorkspaceCommitNotifyResponseSchema.safeParse({
      accepted: false, reason: 'parent-mismatch',
      actualParent: 'deadbeef',
    });
    expect(resync.success).toBe(true);
    if (resync.success && resync.data.accepted === false) {
      expect(resync.data.actualParent).toBe('deadbeef');
    }
    expect(WorkspaceCommitNotifyResponseSchema.safeParse(
      { accepted: false, reason: 'bundle author verification failed' },
    ).success).toBe(true);
  });

  it('does NOT surface a stray baselineBundleBytes field (removed from the wire — BUG: blew the 4 MiB JSON cap on aged workspaces)', () => {
    // The runner now fetches the baseline bundle out-of-band via the binary
    // workspace.export-baseline-bundle action; the JSON re-sync response no
    // longer carries the bytes. A response that still includes the old field
    // must parse (forward-compat / non-strict) but the parsed data must NOT
    // expose it — so no runner could regress to reading it from JSON.
    const parsed = WorkspaceCommitNotifyResponseSchema.safeParse({
      accepted: false, reason: 'parent-mismatch',
      actualParent: 'deadbeef', baselineBundleBytes: 'AAAA',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        (parsed.data as { baselineBundleBytes?: unknown }).baselineBundleBytes,
      ).toBeUndefined();
    }
  });
});

describe('WorkspaceCommitNotifyResponse recoverable', () => {
  it('accepts recoverable:false on a rejection and preserves the value', () => {
    const r = WorkspaceCommitNotifyResponseSchema.safeParse({
      accepted: false,
      reason: 'SDK-config veto',
      recoverable: false,
    });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { recoverable?: boolean }).recoverable).toBe(false);
  });

  it('TASK-287: discardPaths rides alongside recoverable:false', () => {
    const r = WorkspaceCommitNotifyResponseSchema.safeParse({
      accepted: false,
      reason: 'CLAUDE.md: SDK-config paths are host-only',
      recoverable: false,
      discardPaths: ['CLAUDE.md'],
    });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { discardPaths?: string[] }).discardPaths).toEqual([
      'CLAUDE.md',
    ]);
  });

  it('TASK-287: absent discardPaths still parses (older host, older runner)', () => {
    // The field is additive and optional in BOTH directions: a host that never
    // sends it leaves the runner on its previous whole-tree behaviour, and a
    // runner that has never heard of it ignores one that arrives. Neither side
    // needs the other deployed first.
    const r = WorkspaceCommitNotifyResponseSchema.safeParse({
      accepted: false,
      reason: 'bundle author verification failed',
      recoverable: false,
    });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { discardPaths?: unknown }).discardPaths).toBeUndefined();
  });

  it('TASK-287: rejects an unbounded or empty-string discardPaths', () => {
    // These become `rm` targets in the sandbox. Bound them at the wire.
    expect(
      WorkspaceCommitNotifyResponseSchema.safeParse({
        accepted: false,
        reason: 'x',
        recoverable: false,
        discardPaths: [''],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceCommitNotifyResponseSchema.safeParse({
        accepted: false,
        reason: 'x',
        recoverable: false,
        discardPaths: Array.from({ length: 257 }, (_, i) => `p${i}`),
      }).success,
    ).toBe(false);
  });

  it('absent recoverable still parses (runner defaults to preserve)', () => {
    const r = WorkspaceCommitNotifyResponseSchema.safeParse({
      accepted: false,
      reason: 'baseline drift',
    });
    expect(r.success).toBe(true);
  });
});

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

  it('caps the commit label on both save carriers', () => {
    const jsonAt = (n: number) =>
      WorkspaceCommitNotifyRequestSchema.safeParse({
        parentVersion: null,
        reason: 'x'.repeat(n),
        bundleBytes: '',
      }).success;
    expect(jsonAt(WORKSPACE_COMMIT_REASON_MAX)).toBe(true);
    expect(jsonAt(WORKSPACE_COMMIT_REASON_MAX + 1)).toBe(false);

    const queryAt = (n: number) =>
      WorkspaceCommitBundleQuerySchema.safeParse({
        reason: 'x'.repeat(n),
        parentVersion: null,
      }).success;
    expect(queryAt(WORKSPACE_COMMIT_REASON_MAX)).toBe(true);
    expect(queryAt(WORKSPACE_COMMIT_REASON_MAX + 1)).toBe(false);
  });

  it("caps the host's commit rejection reason", () => {
    const at = (n: number) =>
      WorkspaceCommitNotifyResponseSchema.safeParse({
        accepted: false,
        reason: 'x'.repeat(n),
      }).success;
    expect(at(WORKSPACE_COMMIT_REJECT_REASON_MAX)).toBe(true);
    expect(at(WORKSPACE_COMMIT_REJECT_REASON_MAX + 1)).toBe(false);
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
