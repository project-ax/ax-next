import { describe, it, expect } from 'vitest';
import { WorkspaceCommitNotifyResponseSchema } from '../actions.js';

describe('WorkspaceCommitNotifyResponseSchema', () => {
  it('accepted:false carries optional re-sync envelope', () => {
    const resync = WorkspaceCommitNotifyResponseSchema.safeParse({
      accepted: false, reason: 'parent-mismatch',
      actualParent: 'deadbeef', baselineBundleBytes: 'AAAA',
    });
    expect(resync.success).toBe(true);
    if (resync.success && resync.data.accepted === false) {
      expect(resync.data.actualParent).toBe('deadbeef');
      expect(resync.data.baselineBundleBytes).toBe('AAAA');
    }
    expect(WorkspaceCommitNotifyResponseSchema.safeParse(
      { accepted: false, reason: 'bundle author verification failed' },
    ).success).toBe(true);
  });
});
