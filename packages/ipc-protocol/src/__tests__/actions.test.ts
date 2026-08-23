import { describe, it, expect } from 'vitest';
import { WorkspaceCommitNotifyResponseSchema, ToolPreCallResponseSchema } from '../actions.js';

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
