import { describe, it, expect } from 'vitest';
import { WorkspaceCommitNotifyResponseSchema } from '../actions.js';

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
