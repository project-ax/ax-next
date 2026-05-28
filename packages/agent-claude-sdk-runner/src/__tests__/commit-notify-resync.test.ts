import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Unit test for commitNotifyWithResync — the shared per-turn / final-commit
// re-sync+retry helper extracted from main.ts. We mock the git ops in
// `./git-workspace.js` (cross-module import → the mock intercepts the
// helper's calls) and drive a fake `{ call }` IPC client through every
// outcome branch. This locks "preserve behavior exactly" from the original
// inline loop: which git op fires, and what parentVersion the caller gets.
// ---------------------------------------------------------------------------

// Declared via vi.hoisted so they exist before the hoisted vi.mock factory
// (and the hoisted helper import that triggers it) run.
const {
  advanceBaselineMock,
  commitTurnAndBundleMock,
  resyncBaselineAndReplayMock,
  rollbackToBaselineMock,
} = vi.hoisted(() => ({
  advanceBaselineMock: vi.fn().mockResolvedValue(undefined),
  commitTurnAndBundleMock: vi.fn().mockResolvedValue(null),
  resyncBaselineAndReplayMock: vi.fn().mockResolvedValue(undefined),
  rollbackToBaselineMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../git-workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-workspace.js')>();
  return {
    ...actual,
    advanceBaseline: advanceBaselineMock,
    commitTurnAndBundle: commitTurnAndBundleMock,
    resyncBaselineAndReplay: resyncBaselineAndReplayMock,
    rollbackToBaseline: rollbackToBaselineMock,
  };
});

import {
  commitNotifyWithResync,
  flushWorkspaceToHost,
  MAX_RESYNC_ATTEMPTS,
} from '../commit-notify-resync.js';

function fakeClient(call: Mock): { call: Mock } {
  return { call };
}

const ROOT = '/tmp/workspace';

beforeEach(() => {
  advanceBaselineMock.mockReset();
  advanceBaselineMock.mockResolvedValue(undefined);
  commitTurnAndBundleMock.mockReset();
  commitTurnAndBundleMock.mockResolvedValue(null);
  resyncBaselineAndReplayMock.mockReset();
  resyncBaselineAndReplayMock.mockResolvedValue(undefined);
  rollbackToBaselineMock.mockReset();
  rollbackToBaselineMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('commitNotifyWithResync', () => {
  it('accepted → advanceBaseline; returns the new version with outcome "accepted"', async () => {
    const call = vi.fn().mockResolvedValue({ accepted: true, version: 'v2' });
    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'BUNDLE',
      parentVersion: 'v1',
      reason: 'turn',
    });

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('workspace.commit-notify', {
      parentVersion: 'v1',
      reason: 'turn',
      bundleBytes: 'BUNDLE',
    });
    expect(advanceBaselineMock).toHaveBeenCalledTimes(1);
    expect(advanceBaselineMock).toHaveBeenCalledWith(ROOT);
    expect(resyncBaselineAndReplayMock).not.toHaveBeenCalled();
    expect(rollbackToBaselineMock).not.toHaveBeenCalled();
    expect(result).toEqual({ parentVersion: 'v2', outcome: 'accepted' });
  });

  it('concurrent-writer envelope → resync + re-bundle + retry → accepted', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: false,
        actualParent: 'v2',
        baselineBundleBytes: 'BBBB',
      })
      .mockResolvedValueOnce({ accepted: true, version: 'v3' });
    commitTurnAndBundleMock.mockResolvedValueOnce('BUNDLE_REBASED');

    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'BUNDLE_FIRST',
      parentVersion: 'v1',
      reason: 'turn',
    });

    // Resync used the original parent as oldBaseline, the new head as newBaseline.
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledTimes(1);
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledWith({
      root: ROOT,
      baselineBundleBytes: 'BBBB',
      oldBaseline: 'v1',
      newBaseline: 'v2',
    });
    // Two commit-notify calls; the retry uses the new head + the re-bundle.
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]?.[1]).toEqual({
      parentVersion: 'v1',
      reason: 'turn',
      bundleBytes: 'BUNDLE_FIRST',
    });
    expect(call.mock.calls[1]?.[1]).toEqual({
      parentVersion: 'v2',
      reason: 'turn',
      bundleBytes: 'BUNDLE_REBASED',
    });
    expect(advanceBaselineMock).toHaveBeenCalledTimes(1);
    expect(rollbackToBaselineMock).not.toHaveBeenCalled();
    expect(result).toEqual({ parentVersion: 'v3', outcome: 'accepted' });
  });

  it('resync → empty rebased bundle (reb===null) → promotes parentVersion, outcome "accepted"', async () => {
    const call = vi.fn().mockResolvedValueOnce({
      accepted: false,
      actualParent: 'v2',
      baselineBundleBytes: 'BBBB',
    });
    // Re-bundle after resync produces nothing new.
    commitTurnAndBundleMock.mockResolvedValueOnce(null);

    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'BUNDLE_FIRST',
      parentVersion: 'v1',
      reason: 'turn',
    });

    expect(resyncBaselineAndReplayMock).toHaveBeenCalledTimes(1);
    // Only ONE commit-notify (reb===null short-circuits before any retry).
    expect(call).toHaveBeenCalledTimes(1);
    expect(advanceBaselineMock).not.toHaveBeenCalled();
    expect(rollbackToBaselineMock).not.toHaveBeenCalled();
    // parentVersion promoted to the new head so the next turn is aligned.
    expect(result).toEqual({ parentVersion: 'v2', outcome: 'accepted' });
  });

  it('true veto (no actualParent) → rollbackToBaseline; outcome "rolled-back", parentVersion unchanged', async () => {
    const call = vi
      .fn()
      .mockResolvedValue({ accepted: false, reason: 'security veto' });

    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'BUNDLE',
      parentVersion: 'v1',
      reason: 'turn',
    });

    expect(resyncBaselineAndReplayMock).not.toHaveBeenCalled();
    expect(advanceBaselineMock).not.toHaveBeenCalled();
    expect(rollbackToBaselineMock).toHaveBeenCalledTimes(1);
    expect(rollbackToBaselineMock).toHaveBeenCalledWith(ROOT);
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'rolled-back' });
  });

  it('network/IPC throw → keeps the working tree; outcome "kept", parentVersion unchanged', async () => {
    const call = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'BUNDLE',
      parentVersion: 'v1',
      reason: 'turn',
    });

    expect(resyncBaselineAndReplayMock).not.toHaveBeenCalled();
    expect(advanceBaselineMock).not.toHaveBeenCalled();
    expect(rollbackToBaselineMock).not.toHaveBeenCalled();
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'kept' });
  });

  it('exhausted re-sync (envelope on every attempt) → rollbackToBaseline; outcome "rolled-back"', async () => {
    // The host keeps returning the concurrent-writer envelope. After
    // MAX_RESYNC_ATTEMPTS the helper gives up and rolls back.
    const call = vi.fn().mockResolvedValue({
      accepted: false,
      actualParent: 'vN',
      baselineBundleBytes: 'BBBB',
    });
    commitTurnAndBundleMock.mockResolvedValue('BUNDLE_REBASED');

    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'BUNDLE_FIRST',
      parentVersion: 'v1',
      reason: 'turn',
    });

    // MAX_RESYNC_ATTEMPTS resyncs, then a final commit-notify attempt that
    // exceeds the budget → rollback. Total commit-notify calls =
    // MAX_RESYNC_ATTEMPTS + 1 (the initial + one per resync retry).
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledTimes(MAX_RESYNC_ATTEMPTS);
    expect(call).toHaveBeenCalledTimes(MAX_RESYNC_ATTEMPTS + 1);
    expect(advanceBaselineMock).not.toHaveBeenCalled();
    expect(rollbackToBaselineMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'rolled-back' });
  });

  it('envelope with parentVersion=null → cannot resync → rollback (resync needs the old baseline OID)', async () => {
    const call = vi.fn().mockResolvedValue({
      accepted: false,
      actualParent: 'v2',
      baselineBundleBytes: 'BBBB',
    });

    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'BUNDLE',
      parentVersion: null,
      reason: 'turn',
    });

    expect(resyncBaselineAndReplayMock).not.toHaveBeenCalled();
    expect(rollbackToBaselineMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ parentVersion: null, outcome: 'rolled-back' });
  });
});

describe('flushWorkspaceToHost', () => {
  it('nothing staged (commitTurnAndBundle → null) → no commit-notify, parentVersion unchanged', async () => {
    commitTurnAndBundleMock.mockResolvedValueOnce(null);
    const call = vi.fn();
    const result = await flushWorkspaceToHost({
      client: fakeClient(call),
      root: ROOT,
      parentVersion: 'v1',
      reason: 'turn',
    });
    // A post-commit retry (the file was already committed on a prior turn)
    // has nothing to flush — we must NOT hit the host and must leave the
    // version untouched.
    expect(call).not.toHaveBeenCalled();
    expect(advanceBaselineMock).not.toHaveBeenCalled();
    expect(result).toEqual({ parentVersion: 'v1' });
  });

  it('staged bundle → commit-notify accepted → returns the advanced parentVersion', async () => {
    commitTurnAndBundleMock.mockResolvedValueOnce('BUNDLE_MIDTURN');
    const call = vi.fn().mockResolvedValue({ accepted: true, version: 'v2' });
    const result = await flushWorkspaceToHost({
      client: fakeClient(call),
      root: ROOT,
      parentVersion: 'v1',
      reason: 'turn',
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('workspace.commit-notify', {
      parentVersion: 'v1',
      reason: 'turn',
      bundleBytes: 'BUNDLE_MIDTURN',
    });
    expect(advanceBaselineMock).toHaveBeenCalledTimes(1);
    // The advanced version threads into the caller so the turn-end commit chains.
    expect(result).toEqual({ parentVersion: 'v2' });
  });
});
