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
  flushPreconditionMessage,
  flushWorkspaceToHost,
  MAX_RESYNC_ATTEMPTS,
} from '../commit-notify-resync.js';

// The re-sync path now fetches the baseline bundle out-of-band via
// client.callBinary('workspace.export-baseline-bundle', { version }). The
// default mock returns a fake temp-file handle; resync-branch tests assert on
// its call args.
function fakeClient(call: Mock, callBinary?: Mock): { call: Mock; callBinary: Mock } {
  return {
    call,
    callBinary:
      callBinary ??
      vi.fn().mockResolvedValue({ path: '/tmp/fetched-baseline.bundle', bytes: 42 }),
  };
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

  it('concurrent-writer signal → binary-fetch baseline + resync + re-bundle + retry → accepted', async () => {
    // The re-sync response carries ONLY actualParent (no inline bundle bytes —
    // they blew the 4 MiB JSON cap on aged workspaces). The runner fetches the
    // baseline bundle for actualParent out-of-band via callBinary.
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: false,
        actualParent: 'v2',
      })
      .mockResolvedValueOnce({ accepted: true, version: 'v3' });
    const callBinary = vi
      .fn()
      .mockResolvedValue({ path: '/tmp/v2-baseline.bundle', bytes: 99 });
    commitTurnAndBundleMock.mockResolvedValueOnce('BUNDLE_REBASED');

    const result = await commitNotifyWithResync({
      client: fakeClient(call, callBinary),
      root: ROOT,
      bundleBytes: 'BUNDLE_FIRST',
      parentVersion: 'v1',
      reason: 'turn',
    });

    // The baseline bundle was fetched out-of-band for the advanced head.
    expect(callBinary).toHaveBeenCalledTimes(1);
    expect(callBinary).toHaveBeenCalledWith('workspace.export-baseline-bundle', {
      version: 'v2',
    });
    // Resync used the fetched bundle FILE, the original parent as oldBaseline,
    // and the new head as newBaseline.
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledTimes(1);
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledWith({
      root: ROOT,
      bundlePath: '/tmp/v2-baseline.bundle',
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

  it('terminal rejection (no actualParent) → rollbackToBaseline; outcome "rolled-back", parentVersion unchanged', async () => {
    // No `recoverable` on the wire ⟹ recoverable ⟹ `--mixed`, so this is NOT a
    // security veto (those always send `recoverable: false`; see the case
    // below). Naming it one used to make this fixture read as proof of
    // something it never exercised.
    const call = vi
      .fn()
      .mockResolvedValue({ accepted: false, reason: 'bundle prerequisite not satisfied (baseline drift)' });

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
    expect(rollbackToBaselineMock).toHaveBeenCalledWith(ROOT, 'mixed');
    // The working tree survived, and the host's words stay off the wire out:
    // baseline drift is a race the agent cannot address, and a plain retry may
    // well clear it.
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'rolled-back' });
    expect(result.rejectionReason).toBeUndefined();
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

  it('baseline-bundle fetch fails (head moved again) → re-enters loop with same parent+bundle → accepted', async () => {
    // Double-writer race: commit-notify returns actualParent=v2, but ANOTHER
    // writer advances the head to v3 before the runner fetches the v2 baseline
    // bundle. The backend throws parent-mismatch → handler maps it to a
    // NON-retryable 409 (P2b) → callBinary rejects PROMPTLY (no 5xx retry
    // storm). This catch is status-agnostic — ANY thrown fetch error re-enters
    // the loop. The fetch failure must NOT be terminal 'kept'; instead the
    // helper re-calls commit-notify (same parentVersion=v1, same original
    // bundle) which now returns the fresher actualParent=v3, whose bundle fetch
    // succeeds, and the turn is ultimately accepted.
    const call = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, actualParent: 'v2' })
      .mockResolvedValueOnce({ accepted: false, actualParent: 'v3' })
      .mockResolvedValueOnce({ accepted: true, version: 'v4' });
    const callBinary = vi
      .fn()
      // First fetch (for v2) fails — head moved again.
      .mockRejectedValueOnce(new Error('500'))
      // Second fetch (for v3) succeeds.
      .mockResolvedValueOnce({ path: '/tmp/v3-baseline.bundle', bytes: 77 });
    commitTurnAndBundleMock.mockResolvedValueOnce('BUNDLE_REBASED');

    const result = await commitNotifyWithResync({
      client: fakeClient(call, callBinary),
      root: ROOT,
      bundleBytes: 'BUNDLE_FIRST',
      parentVersion: 'v1',
      reason: 'turn',
    });

    // Three commit-notify calls: initial → fetch-fail re-enter → resync retry.
    expect(call).toHaveBeenCalledTimes(3);
    // The fetch-fail re-entry uses the ORIGINAL parent+bundle (no resync ran).
    expect(call.mock.calls[0]?.[1]).toEqual({
      parentVersion: 'v1',
      reason: 'turn',
      bundleBytes: 'BUNDLE_FIRST',
    });
    expect(call.mock.calls[1]?.[1]).toEqual({
      parentVersion: 'v1',
      reason: 'turn',
      bundleBytes: 'BUNDLE_FIRST',
    });
    // The successful resync retry uses the fresher head + the re-bundle.
    expect(call.mock.calls[2]?.[1]).toEqual({
      parentVersion: 'v3',
      reason: 'turn',
      bundleBytes: 'BUNDLE_REBASED',
    });
    expect(callBinary).toHaveBeenCalledTimes(2);
    expect(callBinary.mock.calls[0]?.[1]).toEqual({ version: 'v2' });
    expect(callBinary.mock.calls[1]?.[1]).toEqual({ version: 'v3' });
    // Resync ran exactly once (only on the second, successful fetch).
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledTimes(1);
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledWith({
      root: ROOT,
      bundlePath: '/tmp/v3-baseline.bundle',
      oldBaseline: 'v1',
      newBaseline: 'v3',
    });
    expect(rollbackToBaselineMock).not.toHaveBeenCalled();
    expect(result).toEqual({ parentVersion: 'v4', outcome: 'accepted' });
  });

  it('baseline-bundle fetch fails on every attempt → terminates (rolled-back) without spinning', async () => {
    // Pathological writer storm: the head moves on every fetch, so every
    // export-baseline-bundle 500s. The bounded loop must terminate after
    // MAX_RESYNC_ATTEMPTS rather than spin forever — falling back to rollback.
    const call = vi.fn().mockResolvedValue({ accepted: false, actualParent: 'vN' });
    const callBinary = vi.fn().mockRejectedValue(new Error('500'));

    const result = await commitNotifyWithResync({
      client: fakeClient(call, callBinary),
      root: ROOT,
      bundleBytes: 'BUNDLE_FIRST',
      parentVersion: 'v1',
      reason: 'turn',
    });

    // The fetch is attempted exactly MAX_RESYNC_ATTEMPTS times (each increments
    // the attempt counter so a storm can't spin). commit-notify is called once
    // more than that: the initial + one re-entry per failed fetch, then the
    // budget is exhausted on the final loop.
    expect(callBinary).toHaveBeenCalledTimes(MAX_RESYNC_ATTEMPTS);
    expect(call).toHaveBeenCalledTimes(MAX_RESYNC_ATTEMPTS + 1);
    expect(resyncBaselineAndReplayMock).not.toHaveBeenCalled();
    expect(advanceBaselineMock).not.toHaveBeenCalled();
    expect(rollbackToBaselineMock).toHaveBeenCalledTimes(1);
    expect(rollbackToBaselineMock).toHaveBeenCalledWith(ROOT, 'mixed');
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'rolled-back' });
  });

  it('signal with parentVersion=null → cannot resync → rollback (resync needs the old baseline OID)', async () => {
    const call = vi.fn().mockResolvedValue({
      accepted: false,
      actualParent: 'v2',
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
    expect(rollbackToBaselineMock).toHaveBeenCalledWith(ROOT, 'mixed');
    expect(result).toEqual({ parentVersion: null, outcome: 'rolled-back' });
  });

  it('recoverable:false rejection → hard rollback, and the host reason comes back', async () => {
    const call = vi.fn().mockResolvedValue({ accepted: false, reason: 'SDK-config', recoverable: false });
    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'B',
      parentVersion: 'v1',
      reason: 'turn',
    });
    expect(rollbackToBaselineMock).toHaveBeenCalledWith(ROOT, 'hard');
    // A hard rollback discards the turn's work. If the reason died here, the
    // agent would only ever learn that something was thrown away, never what
    // the host objected to — so it must ride out with the outcome.
    expect(result).toEqual({
      parentVersion: 'v1',
      outcome: 'rolled-back',
      rejectionReason: 'SDK-config',
    });
  });

  it('rejection without recoverable → mixed rollback (preserve work), and NO reason surfaced', async () => {
    // The reason rides out on exactly the condition that destroys the work.
    // Here nothing was destroyed — the files are still in the working tree —
    // and the rejections that land here are races (concurrent writer, baseline
    // drift) whose host reason is a `parent-mismatch:` line naming storage-tier
    // commit ids. Surfacing that would tell the agent to address an objection
    // that does not exist and would suppress the retry advice that is correct.
    const call = vi.fn().mockResolvedValue({ accepted: false, reason: 'baseline drift' });
    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'B',
      parentVersion: 'v1',
      reason: 'turn',
    });
    expect(rollbackToBaselineMock).toHaveBeenCalledWith(ROOT, 'mixed');
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'rolled-back' });
    expect(result.rejectionReason).toBeUndefined();
  });

  it('a concurrent-writer rollback carries NO rejectionReason (a race is not an objection)', async () => {
    // parentVersion=null → we cannot re-sync, so this falls straight through to
    // the rollback. The host DID send a reason, but it is a `parent-mismatch:`
    // line naming two storage-tier commit ids: nothing the agent can act on,
    // and backend vocabulary we must not put in front of the model. The
    // forwarder shows the plain retry message for this instead — correctly, a
    // retry may well land. The host marks it recoverable (no `recoverable`
    // field), which is what keeps the reason off.
    const call = vi.fn().mockResolvedValue({
      accepted: false,
      actualParent: 'v2',
      reason:
        'parent-mismatch: mirror head 9f2c1ab does not match requested version 3d4e5f6 (concurrent writer or stale version)',
    });
    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'B',
      parentVersion: null,
      reason: 'turn',
    });
    expect(rollbackToBaselineMock).toHaveBeenCalledWith(ROOT, 'mixed');
    expect(result).toEqual({ parentVersion: null, outcome: 'rolled-back' });
    expect(result.rejectionReason).toBeUndefined();
  });

  it('a re-sync EXHAUSTED rollback also carries NO rejectionReason', async () => {
    // Same rule at the other entrance to the concurrent-writer branch: we
    // re-synced MAX_RESYNC_ATTEMPTS times and the head kept moving. Still a
    // race, still recoverable, still nothing to address.
    const call = vi.fn().mockResolvedValue({
      accepted: false,
      actualParent: 'v2',
      reason: 'parent-mismatch: expected parent 3d4e5f6, got 9f2c1ab',
    });
    commitTurnAndBundleMock.mockResolvedValue('REBUNDLED');
    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'B',
      parentVersion: 'v1',
      reason: 'turn',
    });
    expect(call).toHaveBeenCalledTimes(MAX_RESYNC_ATTEMPTS + 1);
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'rolled-back' });
    expect(result.rejectionReason).toBeUndefined();
  });

  it('a parent-mismatch WITHOUT actualParent still carries NO rejectionReason', async () => {
    // The host attaches `actualParent` only when it could resolve a head, so a
    // race genuinely arrives without one — an empty-repo mismatch (the server
    // backend sends `actualParent: null`, which the host handler drops), or a
    // git-core integrity guard that throws with no cause at all. Keying the
    // gate off `actualParent` would have let exactly these through, commit ids
    // and all. `recoverable` is set on the branch itself and has no such gap.
    const call = vi.fn().mockResolvedValue({
      accepted: false,
      reason:
        'parent-mismatch: bundle tip 9f2c1ab does not descend from baseline 3d4e5f6',
    });
    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'B',
      parentVersion: 'v1',
      reason: 'turn',
    });
    expect(rollbackToBaselineMock).toHaveBeenCalledWith(ROOT, 'mixed');
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'rolled-back' });
    expect(result.rejectionReason).toBeUndefined();
  });

  it('an accepted commit-notify carries NO rejectionReason', async () => {
    // The field means "the host refused, and here is why". On a success there
    // is nothing to explain, and a caller that renders it unconditionally must
    // not find stale prose sitting there.
    const call = vi.fn().mockResolvedValue({ accepted: true, version: 'v2' });
    const result = await commitNotifyWithResync({
      client: fakeClient(call),
      root: ROOT,
      bundleBytes: 'B',
      parentVersion: 'v1',
      reason: 'turn',
    });
    expect(result).toEqual({ parentVersion: 'v2', outcome: 'accepted' });
    expect(result.rejectionReason).toBeUndefined();
  });
});

describe('flushWorkspaceToHost', () => {
  it('nothing staged (commitTurnAndBundle → null) → no commit-notify, outcome "noop"', async () => {
    commitTurnAndBundleMock.mockResolvedValueOnce(null);
    const call = vi.fn();
    const result = await flushWorkspaceToHost({
      client: fakeClient(call),
      root: ROOT,
      parentVersion: 'v1',
      reason: 'turn',
    });
    // A post-commit retry (the file was already committed+pushed on a prior
    // turn) has nothing to flush — we must NOT hit the host, must leave the
    // version untouched, and must report "noop" (mirror already current) so the
    // forwarder still forwards.
    expect(call).not.toHaveBeenCalled();
    expect(advanceBaselineMock).not.toHaveBeenCalled();
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'noop' });
  });

  it('staged bundle → commit-notify accepted → advanced parentVersion + outcome "accepted"', async () => {
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
    expect(result).toEqual({ parentVersion: 'v2', outcome: 'accepted' });
  });

  it('staged bundle → commit-notify network error → outcome "kept" (caller must NOT forward)', async () => {
    commitTurnAndBundleMock.mockResolvedValueOnce('BUNDLE_MIDTURN');
    const call = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await flushWorkspaceToHost({
      client: fakeClient(call),
      root: ROOT,
      parentVersion: 'v1',
      reason: 'turn',
    });
    // Committed locally but never pushed — the host mirror is stale. The
    // outcome surfaces so the forwarder gates on it instead of forwarding a 404.
    expect(advanceBaselineMock).not.toHaveBeenCalled();
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'kept' });
  });

  it('staged bundle → recoverable rejection → "rolled-back" (caller must NOT forward)', async () => {
    commitTurnAndBundleMock.mockResolvedValueOnce('BUNDLE_MIDTURN');
    const call = vi
      .fn()
      .mockResolvedValue({ accepted: false, reason: 'bundle prerequisite not satisfied (baseline drift)' });
    const result = await flushWorkspaceToHost({
      client: fakeClient(call),
      root: ROOT,
      parentVersion: 'v1',
      reason: 'turn',
    });
    // The turn's commit was rolled back and nothing reached the host mirror, so
    // the forwarder must surface an error rather than install an older draft —
    // even though this reset is `--mixed` and the agent's file survives in the
    // working tree. Recoverable ⟹ no reason travels; the forwarder shows the
    // retry message.
    expect(rollbackToBaselineMock).toHaveBeenCalledTimes(1);
    expect(rollbackToBaselineMock).toHaveBeenCalledWith(ROOT, 'mixed');
    expect(result).toEqual({ parentVersion: 'v1', outcome: 'rolled-back' });
    expect(result.rejectionReason).toBeUndefined();
  });

  it('staged bundle → NON-recoverable veto → the host\'s reason travels with the outcome', async () => {
    commitTurnAndBundleMock.mockResolvedValueOnce('BUNDLE_MIDTURN');
    const call = vi.fn().mockResolvedValue({
      accepted: false,
      reason: '.ax/routines/nightly.md: schedule is not a valid cron expression',
      recoverable: false,
    });
    const result = await flushWorkspaceToHost({
      client: fakeClient(call),
      root: ROOT,
      parentVersion: 'v1',
      reason: 'turn',
    });
    // `--hard`: the file the agent just wrote is GONE. This is the one case
    // where the agent needs the reason, and it is what the forwarder renders
    // into the tool error the model reads.
    expect(rollbackToBaselineMock).toHaveBeenCalledWith(ROOT, 'hard');
    expect(result).toEqual({
      parentVersion: 'v1',
      outcome: 'rolled-back',
      rejectionReason: '.ax/routines/nightly.md: schedule is not a valid cron expression',
    });
  });
});

// ---------------------------------------------------------------------------
// The sentence both runners hand the model when a pre-call flush did not sync.
// It is shared precisely so the two loops stay host-indistinguishable, which
// makes every clause in it a claim BOTH runners make.
// ---------------------------------------------------------------------------
describe('flushPreconditionMessage', () => {
  it('states the host reason and the rollback, and does NOT say to try again', () => {
    const text = flushPreconditionMessage('skill_install', {
      outcome: 'rolled-back',
      rejectionReason: '.claude/settings.json: agent writes to the SDK config are refused',
    });
    expect(text).toContain('.claude/settings.json: agent writes to the SDK config are refused');
    expect(text).toContain("The turn's commit was rolled back.");
    // Against a policy veto the identical retry is vetoed identically, so
    // telling the model to retry is advice we know to be wrong.
    expect(text).not.toContain('please try again');
  });

  it('keeps the retry advice when the host gave no reason', () => {
    // `kept` (host unreachable) and a thrown flush are transient — here a
    // retry really is the right thing to do.
    for (const outcome of ['kept', 'error'] as const) {
      const text = flushPreconditionMessage('skill_install', { outcome });
      expect(text).toContain(`flush outcome: ${outcome}`);
      expect(text).toContain('please try again');
      expect(text).not.toContain('rolled back');
    }
  });

  it('a rolled-back flush with NO reason still gets the retry message', () => {
    // A real production shape: a mid-turn flush hits a concurrent-writer race,
    // rolls back `--mixed`, and carries no reason. The forwarder must show the
    // retry sentence — not the veto one with an empty objection in it.
    const text = flushPreconditionMessage('skill_install', { outcome: 'rolled-back' });
    expect(text).toContain('flush outcome: rolled-back');
    expect(text).toContain('please try again');
    expect(text).not.toContain('The host refused the change');
  });

  it('punctuates a reason that does not end in a sentence', () => {
    // Reasons are prose from a plugin; nothing forces a trailing period, and
    // without one the next sentence runs straight on from theirs.
    const text = flushPreconditionMessage('skill_install', {
      outcome: 'rolled-back',
      rejectionReason: 'bundle prerequisite not satisfied (baseline drift)',
    });
    expect(text).toContain('(baseline drift). The turn');
  });

  it('never claims a rollback for an outcome that did not roll back', () => {
    // Only `rolled-back` carries a reason today, but that is a caller
    // convention the parameter type cannot enforce. The sentence must not
    // assert something that did not happen.
    const text = flushPreconditionMessage('skill_install', {
      outcome: 'kept',
      rejectionReason: 'something the host said',
    });
    expect(text).toContain('something the host said');
    expect(text).not.toContain('rolled back');
  });
});
