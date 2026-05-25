import type { IpcClient, WorkspaceCommitNotifyResponse } from '@ax/ipc-protocol';
import {
  advanceBaseline,
  commitTurnAndBundle,
  resyncBaselineAndReplay,
  rollbackToBaseline,
} from './git-workspace.js';
import { commitTrace } from './commit-trace.js';

// ---------------------------------------------------------------------------
// Shared commit-notify re-sync+retry helper.
//
// Extracted verbatim from main.ts's per-turn `result` loop so BOTH the
// per-turn commit AND the post-`result` final/idle commit run the same
// bounded re-sync logic. Lives in its OWN module (not inside
// git-workspace.ts) so main.test.ts's `vi.mock('../git-workspace.js')`
// intercepts the git ops this helper calls — a cross-module import resolves
// through the mock; an intra-module call would bypass it.
// ---------------------------------------------------------------------------

export const MAX_RESYNC_ATTEMPTS = 3;

export type CommitNotifyOutcome = 'accepted' | 'rolled-back' | 'kept';

/**
 * Commit-notify a turn bundle, recovering from a concurrent-writer advance by
 * rebasing onto the storage tier's new head and retrying — bounded. Shared by
 * the per-turn `result` handler AND the post-`result` final commit so both
 * survive a concurrent writer. Behavior is unchanged from the original per-turn
 * loop. The caller owns the initial `commitTurnAndBundle` and `chat:turn-end`
 * emission; this helper does neither.
 *
 *  - accepted              → advanceBaseline; return the new version ('accepted').
 *  - concurrent-writer      → resyncBaselineAndReplay + re-bundle + retry, up to
 *    envelope                 MAX_RESYNC_ATTEMPTS. An empty re-bundle (turn
 *                             absorbed) → promote parentVersion to the new head ('accepted').
 *  - true veto / exhausted  → rollbackToBaseline ('rolled-back'); parentVersion unchanged.
 *  - network/5xx/resync-fail→ keep the working tree ('kept'); parentVersion unchanged.
 */
export async function commitNotifyWithResync(input: {
  client: Pick<IpcClient, 'call'>;
  root: string;
  bundleBytes: string;
  parentVersion: string | null;
  reason: string;
}): Promise<{ parentVersion: string | null; outcome: CommitNotifyOutcome }> {
  const { client, root, reason } = input;
  let bundleB64 = input.bundleBytes;
  let currentParentVersion: string | null = input.parentVersion;
  let attempt = 0;
  commitTrace(
    `[commit-trace] commit-notify enter reason=${reason} parent=${currentParentVersion ?? 'null'} bundleB64Len=${bundleB64.length}\n`,
  );
  for (;;) {
    let resp: WorkspaceCommitNotifyResponse;
    try {
      commitTrace(
        `[commit-trace] → workspace.commit-notify call parent=${currentParentVersion ?? 'null'} attempt=${attempt}\n`,
      );
      resp = (await client.call('workspace.commit-notify', {
        parentVersion: currentParentVersion,
        reason,
        bundleBytes: bundleB64,
      })) as WorkspaceCommitNotifyResponse;
      commitTrace(
        `[commit-trace] ← commit-notify resp accepted=${resp.accepted} version=${(resp as { version?: string }).version ?? '-'} actualParent=${(resp as { actualParent?: string }).actualParent ?? '-'} hasBundle=${(resp as { baselineBundleBytes?: string }).baselineBundleBytes !== undefined} reason=${(resp as { reason?: string }).reason ?? '-'}\n`,
      );
    } catch (err) {
      // Network / 5xx / timeout: keep the working tree intact so the next
      // turn's accumulated changes flow as one bundle. Don't advance baseline;
      // don't rollback. Same trade-off the legacy accumulator path made.
      process.stderr.write(
        `runner: commit-notify failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return { parentVersion: input.parentVersion, outcome: 'kept' };
    }
    if (resp.accepted) {
      await advanceBaseline(root);
      commitTrace(
        `[commit-trace] outcome=accepted version=${resp.version as unknown as string} (after attempt=${attempt})\n`,
      );
      return { parentVersion: resp.version as unknown as string, outcome: 'accepted' };
    }
    // Concurrent-writer advance → re-sync + retry (bounded). currentParentVersion
    // must be non-null: resyncBaselineAndReplay needs the old baseline OID to
    // compute the rebase upstream.
    if (
      resp.actualParent &&
      resp.baselineBundleBytes &&
      currentParentVersion !== null &&
      attempt < MAX_RESYNC_ATTEMPTS
    ) {
      attempt++;
      commitTrace(
        `[commit-trace] concurrent-writer: parent=${currentParentVersion} actualParent=${resp.actualParent} → resync+replay (attempt=${attempt})\n`,
      );
      try {
        await resyncBaselineAndReplay({
          root,
          baselineBundleBytes: resp.baselineBundleBytes,
          oldBaseline: currentParentVersion,
          newBaseline: resp.actualParent,
        });
      } catch (e) {
        process.stderr.write(
          `runner: resync failed (${e instanceof Error ? e.message : String(e)})\n`,
        );
        commitTrace(`[commit-trace] outcome=kept (resync threw)\n`);
        return { parentVersion: input.parentVersion, outcome: 'kept' };
      }
      currentParentVersion = resp.actualParent;
      const rebasedBundleBytes = await commitTurnAndBundle({ root, reason });
      commitTrace(
        `[commit-trace] resync replayed; rebundle=${rebasedBundleBytes === null ? 'EMPTY(absorbed)' : `${rebasedBundleBytes.length}B`}\n`,
      );
      if (rebasedBundleBytes === null) {
        // Replay produced no new commit — the workspace is already aligned to
        // the advanced baseline (resyncBaselineAndReplay re-pinned `baseline` to
        // currentParentVersion). Promote `parentVersion` now so the NEXT turn's
        // commit-notify uses the new baseline instead of triggering a spurious
        // re-sync against a stale parent.
        commitTrace(
          `[commit-trace] outcome=accepted (turn absorbed; promoted parent=${currentParentVersion})\n`,
        );
        return { parentVersion: currentParentVersion, outcome: 'accepted' };
      }
      bundleB64 = rebasedBundleBytes;
      continue;
    }
    // Retries exhausted on concurrent-writer rejection vs. true veto: log
    // distinctly so an operator can tell a stuck re-sync from a policy rejection.
    if (resp.actualParent && attempt >= MAX_RESYNC_ATTEMPTS) {
      process.stderr.write(
        `runner: commit-notify re-sync exhausted after ${attempt} attempts; rolling back turn\n`,
      );
    } else {
      process.stderr.write(`runner: workspace rejected: ${resp.reason}\n`);
    }
    await rollbackToBaseline(root);
    commitTrace(
      `[commit-trace] outcome=rolled-back (actualParent=${resp.actualParent ?? '-'} attempt=${attempt})\n`,
    );
    return { parentVersion: input.parentVersion, outcome: 'rolled-back' };
  }
}
