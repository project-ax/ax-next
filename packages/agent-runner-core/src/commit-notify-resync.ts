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
 * What a commit-notify attempt ended in, plus — on a NON-RECOVERABLE refusal —
 * the host's own words for why.
 *
 * `rejectionReason` exists so that refusal is legible to the agent instead of
 * dying inside this function: it is exactly the case where the rollback is
 * `--hard`, so the turn's work is destroyed and a bare `rolled-back` gives the
 * model nothing to correct. It is host-authored prose, not a machine code —
 * callers surface it, they don't branch on it.
 *
 * It is carried iff `recoverable === false` — the same wire field that picks
 * `--hard` over `--mixed`. Two host branches set it, and both state a
 * self-contained objection: the `workspace:pre-apply` veto (a validator's
 * reason) and bundle-author verification (a sanitized fixed string).
 *
 * Everything else stays silent, deliberately. A concurrent-writer or
 * baseline-drift rejection is a RACE, not an objection: it leaves the working
 * tree alone (`--mixed`) and a plain retry may well clear it. Its reason is
 * either a `parent-mismatch:` line naming two storage-tier commit ids —
 * backend vocabulary we must not put in front of the model — or the sanitized
 * catch-all `'bundle prerequisite not satisfied (baseline drift)'`, which
 * leaks nothing but tells the agent nothing either. Neither is actionable.
 * `actualParent` is NOT the discriminator for this: the
 * host attaches it only when it could resolve a head, so a race can and does
 * arrive without one (an empty-repo mismatch, or a git-core integrity guard
 * that throws with no cause). `recoverable` is set on the branch itself and
 * has no such gap.
 */
export interface CommitNotifyResult {
  parentVersion: string | null;
  outcome: CommitNotifyOutcome;
  rejectionReason?: string;
}

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
 *  - true veto / exhausted  → rollbackToBaseline ('rolled-back'); parentVersion unchanged,
 *                             and the host's stated reason comes back as `rejectionReason`.
 *  - network/5xx/resync-fail→ keep the working tree ('kept'); parentVersion unchanged.
 */
export async function commitNotifyWithResync(input: {
  // Needs `callBinary` too: on the re-sync path the runner fetches the baseline
  // bundle for `actualParent` out-of-band via the binary
  // `workspace.export-baseline-bundle` action (octet-stream, uncapped) instead
  // of reading it inline from the JSON response — the inline bytes blew the
  // 4 MiB response cap on aged workspaces (same bug class as materialize BUG-W3).
  client: Pick<IpcClient, 'call' | 'callBinary'>;
  root: string;
  bundleBytes: string;
  parentVersion: string | null;
  reason: string;
}): Promise<CommitNotifyResult> {
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
        `[commit-trace] ← commit-notify resp accepted=${resp.accepted} version=${(resp as { version?: string }).version ?? '-'} actualParent=${(resp as { actualParent?: string }).actualParent ?? '-'} reason=${(resp as { reason?: string }).reason ?? '-'}\n`,
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
      currentParentVersion !== null &&
      attempt < MAX_RESYNC_ATTEMPTS
    ) {
      attempt++;
      commitTrace(
        `[commit-trace] concurrent-writer: parent=${currentParentVersion} actualParent=${resp.actualParent} → fetch baseline + resync+replay (attempt=${attempt})\n`,
      );
      // STEP 1 — fetch the baseline bundle for `actualParent` OUT-OF-BAND via the
      // binary octet-stream action (NOT the JSON response, which no longer
      // carries it). callBinary streams the raw bundle straight to a temp file
      // under the disk-bounded cap, so an aged workspace's MiB-scale bundle never
      // hits the 4 MiB JSON response cap that previously broke re-sync.
      //
      // A FAILED fetch is NOT terminal: in a double-writer race a THIRD writer can
      // advance the head past `actualParent` between commit-notify returning it
      // and this fetch, so the backend throws parent-mismatch → host maps it to a
      // NON-retryable 409 (P2b — a 500 would make callBinary's 5xx retry reissue
      // the same stale fetch several times, rebuilding the large bundle each time,
      // before we ever re-ask commit-notify) → callBinary rejects PROMPTLY. We
      // catch ANY thrown error here (status-agnostic) — that just means "the head
      // moved again" — and re-enter the bounded loop with the SAME parentVersion +
      // SAME bundle so the next commit-notify hands back the NEW (fresher)
      // actualParent and we fetch that instead. (`attempt` already incremented above, so a pathological
      // writer storm still terminates at MAX_RESYNC_ATTEMPTS via the
      // exhausted-rollback path below.) On success, resyncBaselineAndReplay TAKES
      // OWNERSHIP of the temp file (deletes it). On failure the runner ipc-client
      // deletes its own partial temp file, so no leak accrues per retry.
      let fetched: { path: string; bytes: number };
      try {
        fetched = await client.callBinary('workspace.export-baseline-bundle', {
          version: resp.actualParent,
        });
      } catch (e) {
        process.stderr.write(
          `runner: baseline-bundle fetch failed (${e instanceof Error ? e.message : String(e)}); head moved again — retrying commit-notify (attempt=${attempt})\n`,
        );
        commitTrace(
          `[commit-trace] baseline-bundle fetch threw (head moved) → re-enter loop with same parent=${currentParentVersion ?? 'null'} (attempt=${attempt})\n`,
        );
        // Re-enter: do NOT advance currentParentVersion, do NOT re-bundle (no
        // resync ran). The next iteration re-calls commit-notify with the
        // unchanged parent + bundle.
        continue;
      }
      commitTrace(
        `[commit-trace]   fetched baseline bundle ${fetched.bytes}B → ${fetched.path}\n`,
      );
      // STEP 2 — rebase the local turn onto the fetched baseline. A failure HERE
      // (the git rebase/replay itself) IS terminal 'kept': we have the right
      // baseline but couldn't replay onto it, so keep the working tree intact and
      // let the next turn flow as one bundle. resyncBaselineAndReplay owns +
      // deletes the temp file in all cases.
      try {
        await resyncBaselineAndReplay({
          root,
          bundlePath: fetched.path,
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
    // Per-path rollback (Phase 2): preserve the agent's work by default
    // (`--mixed`), only HARD-reset a non-recoverable rejection (SDK-config veto /
    // tampered bundle, signaled by `recoverable: false`) so a perpetually-vetoed
    // write can't wedge the atomic transcript bundle.
    const mode: 'mixed' | 'hard' = resp.recoverable === false ? 'hard' : 'mixed';
    await rollbackToBaseline(root, mode);
    commitTrace(
      `[commit-trace] outcome=rolled-back (actualParent=${resp.actualParent ?? '-'} attempt=${attempt} mode=${mode})\n`,
    );
    // Hand the host's stated reason back to the caller when — and only when —
    // we just destroyed the agent's work. Everything else on this path is
    // write-only (a stderr line and an off-by-default commit trace), so this is
    // the only channel by which the agent can learn what it did wrong.
    //
    // Keyed off the SAME `mode` that decided the reset, so the two can't drift:
    // `hard` ⟺ `recoverable === false` ⟺ the host refused on the merits and
    // stated a self-contained objection. A `mixed` rollback is a race
    // (concurrent writer, baseline drift) whose reason is either commit-id
    // noise or a sanitized catch-all — no objection to address either way, and
    // the forwarder's retry message is the right advice. See CommitNotifyResult.
    return {
      parentVersion: input.parentVersion,
      outcome: 'rolled-back',
      ...(mode === 'hard' ? { rejectionReason: resp.reason } : {}),
    };
  }
}

/**
 * Mid-turn workspace flush — commit the live `/agent` tree and push it to
 * the host's workspace mirror, NOW, without waiting for the turn boundary.
 *
 * Why this exists: a host tool that declares `flushWorkspaceBeforeCall` reads
 * workspace files the agent may have written earlier in the SAME turn. The host
 * only sees the committed + pushed mirror, which lags the runner's live tree
 * until the turn-end commit. Flushing here makes the just-written file visible
 * to the host read before the tool runs (BUG-W2).
 *
 * Mechanically identical to the turn-end commit (commitTurnAndBundle →
 * commitNotifyWithResync), minus the transcript-uuid wait — the file we need
 * to surface is already on disk (the agent wrote it before calling the tool),
 * and the partial-turn jsonl committed here is superseded by the fuller
 * turn-end commit. Returns the advanced `parentVersion` so the caller threads
 * it into the subsequent turn-end commit (the commit chain stays coherent).
 *
 * Returns `outcome: 'noop'` when there is nothing staged to flush (the file was
 * already committed+pushed on a prior turn — a post-commit retry; the host
 * mirror is already current). Otherwise returns the underlying
 * `commitNotifyWithResync` outcome. The caller MUST treat anything other than
 * `accepted`/`noop` as "not synced": on `kept` the commit landed locally but
 * never reached the host mirror, and on `rolled-back` the live tree was reset
 * to baseline (the just-authored file is GONE) — forwarding a host read in
 * either case reads a stale (or, post-rollback, an older committed) state. See
 * the precondition gate in host-mcp-server.ts.
 */
export type FlushOutcome = 'accepted' | 'noop' | CommitNotifyOutcome;

/**
 * A flush's outcome plus, on `rolled-back`, the host's reason for refusing —
 * see {@link CommitNotifyResult.rejectionReason}. The tool-call path renders it
 * into the error it hands the model, so a veto reads as "the host refused
 * because X" rather than an unexplained `rolled-back`.
 */
export interface FlushResult {
  parentVersion: string | null;
  outcome: FlushOutcome;
  rejectionReason?: string;
}

/**
 * What `flushWorkspaceForHostTool` hands a loop's tool forwarder: the flush
 * outcome and, on a refusal, the host's reason. `parentVersion` is deliberately
 * NOT part of this — the runner shell owns the commit chain and threads the new
 * parent internally; a loop has no business seeing a workspace token.
 */
export type HostToolFlush = Omit<FlushResult, 'parentVersion'>;

/**
 * The message a loop hands the model when a pre-call workspace flush did NOT
 * sync the host mirror. Shared by both runners so they stay
 * host-indistinguishable: same words, and the same reason, whichever loop is
 * driving.
 *
 * `outcome` widens past {@link FlushOutcome} to include `'error'`, which the
 * loops use for a flush that threw — that is not a commit-notify outcome, so it
 * lives here rather than in the type.
 *
 * When the host stated a reason we say what it was and drop the "please try
 * again" tail: against a policy veto the identical retry is vetoed identically.
 * We do NOT replace it with "fix this and retry" either — the reason is the
 * payload; what to do with it is the model's call.
 *
 * The "rolled back" clause is gated on the outcome rather than on the reason's
 * presence. Only a `rolled-back` carries a reason today, but that is a caller
 * convention the parameter type cannot enforce, and this sentence must never
 * assert a rollback that did not happen.
 */
export function flushPreconditionMessage(
  toolName: string,
  flush: { outcome: FlushOutcome | 'error'; rejectionReason?: string },
): string {
  const head =
    `Could not sync your just-authored workspace files to the host before ` +
    `'${toolName}' (flush outcome: ${flush.outcome}).`;
  const stated = flush.rejectionReason?.trim() ?? '';
  if (stated !== '') {
    // Host reasons are prose from a plugin and are not required to end in a
    // period; without this the next sentence runs straight on from theirs.
    const sentence = /[.!?]$/.test(stated) ? stated : `${stated}.`;
    const rolledBack =
      flush.outcome === 'rolled-back' ? ` The turn's commit was rolled back.` : '';
    return `${head} The host refused the change: ${sentence}${rolledBack}`;
  }
  return `${head} The files are not visible to the installer yet — please try again.`;
}

export async function flushWorkspaceToHost(input: {
  client: Pick<IpcClient, 'call' | 'callBinary'>;
  root: string;
  parentVersion: string | null;
  reason: string;
}): Promise<FlushResult> {
  const { client, root, parentVersion, reason } = input;
  const bundleB64 = await commitTurnAndBundle({ root, reason });
  if (bundleB64 === null) {
    commitTrace(`[commit-trace] flushWorkspaceToHost: nothing staged (no-op)\n`);
    return { parentVersion, outcome: 'noop' };
  }
  const result = await commitNotifyWithResync({
    client,
    root,
    bundleBytes: bundleB64,
    parentVersion,
    reason,
  });
  return {
    parentVersion: result.parentVersion,
    outcome: result.outcome,
    ...(result.rejectionReason !== undefined
      ? { rejectionReason: result.rejectionReason }
      : {}),
  };
}
