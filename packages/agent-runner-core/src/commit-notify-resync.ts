import {
  IpcRequestError,
  WORKSPACE_COMMIT_BUNDLE_MAX_BYTES,
  type IpcClient,
  type SaveRefusedCode,
  type WorkspaceCommitNotifyResponse,
} from '@ax/ipc-protocol';
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
 * dying inside this function: something the agent wrote has just been taken
 * away from it, and a bare `rolled-back` gives the model nothing to correct.
 * It is host-authored prose, not a machine code — callers surface it, they
 * don't branch on it.
 *
 * It is carried iff `recoverable === false`. Two host branches set that, and
 * both state a self-contained objection: the `workspace:pre-apply` veto (a
 * validator's reason) and bundle-author verification (a sanitized fixed
 * string).
 *
 * Note it is NOT keyed off the reset mode, which it once was. Since TASK-287 a
 * refusal the host can pin to specific paths resets `--mixed` and undoes only
 * those — still `recoverable === false`, and still very much something the
 * agent needs told about. Keying off `--hard` would silence exactly that case.
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
 *
 * `rejectionCode` is the machine half of the same refusal (TASK-720), for
 * callers that DO branch: the end-of-turn commit maps it to the closed
 * `saveRefused` code on `event.turn-end` (see {@link saveRefusedFrom}). It is
 * the host's `code` on a `recoverable: false` answer (the pre-apply veto's
 * slug, e.g. `storage-full`), or `'too-large'` when the save was too big to
 * carry — which the runner decides itself, before sending or on a host 413.
 * Absent whenever the refusal named no code; never present without
 * `rejectionReason`.
 */
export interface CommitNotifyResult {
  parentVersion: string | null;
  outcome: CommitNotifyOutcome;
  rejectionReason?: string;
  rejectionCode?: string;
}

/**
 * What the model is told when a save was too big to carry (TASK-720). Written
 * for the model, in the same register as a host veto's reason: say what
 * happened to the files, and what to do about it. The size is the protocol's
 * cap, not an injected test cap — it is the one limit a person can act on.
 */
export const TOO_LARGE_REJECTION_REASON =
  `This turn's file changes were too large to save in one go ` +
  `(over ${Math.round(WORKSPACE_COMMIT_BUNDLE_MAX_BYTES / (1024 * 1024))} MB), ` +
  `so they were removed. Tell the person, and suggest saving large files in ` +
  `smaller pieces or outside the workspace.`;

/**
 * The closed `event.turn-end` code for a commit result, or `undefined` when the
 * save was not REFUSED. Only a terminal refusal counts: the host objected on
 * the merits (`rejectionReason` present) or the save was too big to carry.
 * `accepted`, `kept` (host unreachable — the files ride the next turn) and a
 * recoverable race rollback (`--mixed`, no reason) are not refusals.
 *
 * A code outside the two the person-facing surface has a sentence for maps to
 * `'refused'`: the runner forwards a choice among three fixed sentences, never
 * a host string.
 */
export function saveRefusedFrom(result: CommitNotifyResult): SaveRefusedCode | undefined {
  if (result.outcome !== 'rolled-back') return undefined;
  if (result.rejectionReason === undefined && result.rejectionCode !== 'too-large') {
    return undefined;
  }
  if (result.rejectionCode === 'storage-full') return 'storage-full';
  if (result.rejectionCode === 'too-large') return 'too-large';
  return 'refused';
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
 *                             and the host's stated reason comes back as `rejectionReason`
 *                             (plus its `code`, if any, as `rejectionCode`).
 *  - too large to carry     → NOT sent (over the cap) or refused by the host with a 413:
 *                             HARD rollback ('rolled-back', `rejectionCode: 'too-large'`).
 *  - network/5xx/resync-fail→ keep the working tree ('kept'); parentVersion unchanged.
 *
 * Wire (TASK-720): the raw bundle is the octet-stream body of the binary
 * `workspace.commit-bundle` action, with `reason` and `parentVersion` (omitted
 * when null) as query params; the answer is the same JSON shape
 * `workspace.commit-notify` returns, Zod-parsed by the client. The JSON action
 * carried the bundle as base64 inside the 4 MiB frame, which capped one save at
 * about 3 MiB.
 */
export async function commitNotifyWithResync(input: {
  // `callBinaryUpload` sends the save. `callBinary` is the re-sync path: the
  // runner fetches the baseline bundle for `actualParent` out-of-band via the
  // binary `workspace.export-baseline-bundle` action (octet-stream, uncapped)
  // instead of reading it inline from the JSON response — the inline bytes blew
  // the 4 MiB response cap on aged workspaces (same bug class as materialize
  // BUG-W3).
  client: Pick<IpcClient, 'callBinary' | 'callBinaryUpload'>;
  root: string;
  /** The raw bundle from `commitTurnAndBundle`. */
  bundle: Buffer;
  parentVersion: string | null;
  reason: string;
  /**
   * The most one save may carry. Defaults to the protocol's
   * `WORKSPACE_COMMIT_BUNDLE_MAX_BYTES`; injectable so a test need not build a
   * 100 MiB bundle.
   */
  maxBundleBytes?: number;
}): Promise<CommitNotifyResult> {
  const { client, root, reason } = input;
  const maxBundleBytes = input.maxBundleBytes ?? WORKSPACE_COMMIT_BUNDLE_MAX_BYTES;
  let bundle = input.bundle;
  let currentParentVersion: string | null = input.parentVersion;
  let attempt = 0;
  commitTrace(
    `[commit-trace] commit-notify enter reason=${reason} parent=${currentParentVersion ?? 'null'} bundleLen=${bundle.length}\n`,
  );
  // Too big to carry: fail LOUDLY. Never `kept` — `baseline` would not move, so
  // every later turn's `baseline..main` bundle would still carry the same bytes
  // and fail the same way, forever. `hard` because nothing smaller works: a
  // `--mixed` reset leaves the files in the tree for the next `git add -A`. The
  // bundle does not say which paths made it big, so there is no scoped discard.
  const tooLarge = async (why: string): Promise<CommitNotifyResult> => {
    process.stderr.write(
      `runner: workspace save too large (${why}); rolling back turn\n`,
    );
    await rollbackToBaseline(root, 'hard');
    commitTrace(`[commit-trace] outcome=rolled-back (too-large: ${why})\n`);
    return {
      parentVersion: input.parentVersion,
      outcome: 'rolled-back',
      rejectionReason: TOO_LARGE_REJECTION_REASON,
      rejectionCode: 'too-large',
    };
  };
  for (;;) {
    // Checked on EVERY send, not just the first: a re-bundle after a re-sync
    // can be bigger than the bundle it replaced.
    if (bundle.length > maxBundleBytes) {
      return tooLarge(`${bundle.length} bytes, over the ${maxBundleBytes}-byte cap; not sent`);
    }
    let resp: WorkspaceCommitNotifyResponse;
    try {
      commitTrace(
        `[commit-trace] → workspace.commit-bundle call parent=${currentParentVersion ?? 'null'} attempt=${attempt}\n`,
      );
      // Absent = null on the host. An empty `parentVersion=` is a schema error
      // there, and the string 'null' would read as a version.
      const query: Record<string, string> =
        currentParentVersion === null
          ? { reason }
          : { reason, parentVersion: currentParentVersion };
      resp = (await client.callBinaryUpload(
        'workspace.commit-bundle',
        bundle,
        query,
      )) as WorkspaceCommitNotifyResponse;
      commitTrace(
        `[commit-trace] ← commit-bundle resp accepted=${resp.accepted} version=${(resp as { version?: string }).version ?? '-'} actualParent=${(resp as { actualParent?: string }).actualParent ?? '-'} reason=${(resp as { reason?: string }).reason ?? '-'}\n`,
      );
    } catch (err) {
      // The host refused the BODY as too large (the dispatcher's binary-body
      // budget). Same loud failure as the pre-send check above — a body the
      // host will not take is not going to fit next turn either.
      if (err instanceof IpcRequestError && err.status === 413) {
        return tooLarge(`host answered 413: ${err.message}`);
      }
      // Network / 5xx / timeout — and any other 4xx: keep the working tree
      // intact so the next turn's accumulated changes flow as one bundle.
      // Don't advance baseline; don't rollback. A 404 from a host too old to
      // know `workspace.commit-bundle` lands here on purpose: an old host must
      // not cost the agent its files.
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
      bundle = rebasedBundleBytes;
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
    // (`--mixed`). A non-recoverable rejection (`recoverable: false`) is one
    // whose content must NOT survive the turn — we re-stage the entire tree
    // next turn, so a preserved refused file would be re-submitted and refused
    // again forever, wedging the agent.
    //
    // TASK-287: when the host can say WHICH paths it refused (`discardPaths`),
    // that argument only reaches those paths. Reset `--mixed` and undo exactly
    // them (rollbackToBaseline reverts them to their baseline state, or deletes
    // them if the baseline had no such file): the refused content is gone — so
    // it cannot be re-submitted, and the wedge is answered by construction —
    // while unrelated work from this turn, and from every earlier turn still
    // sitting above the last accepted baseline, survives. Only a refusal with
    // no paths to point at still takes the whole tree down.
    const scopedDiscards =
      resp.recoverable === false ? (resp.discardPaths ?? []) : [];
    const mode: 'mixed' | 'hard' =
      resp.recoverable === false && scopedDiscards.length === 0 ? 'hard' : 'mixed';
    await rollbackToBaseline(root, mode, scopedDiscards);
    commitTrace(
      `[commit-trace] outcome=rolled-back (actualParent=${resp.actualParent ?? '-'} attempt=${attempt} mode=${mode} discarded=${scopedDiscards.length})\n`,
    );
    // Hand the host's stated reason back to the caller when — and only when —
    // the host refused on the merits. Everything else on this path is
    // write-only (a stderr line and an off-by-default commit trace). The reason
    // is how the MODEL learns what it did wrong, on the mid-turn flush before a
    // host tool (the forwarder renders it into the tool error). The PERSON
    // learns of an end-of-turn refusal a different way: the runner maps this
    // result to `saveRefused` on `event.turn-end` (saveRefusedFrom, TASK-720),
    // a closed code — never this prose, which is written for the model.
    //
    // Keyed off `recoverable === false`, which is the actual condition: the
    // host objected to the content and said why. Everything else that lands
    // here is a race (concurrent writer, baseline drift) whose reason is either
    // commit-id noise or a sanitized catch-all — no objection to address, and
    // the forwarder's retry message is the right advice.
    //
    // NOT keyed off `mode === 'hard'`, which it used to be. That read the same
    // for as long as the two were synonyms, and stopped the moment a refusal
    // could be scoped (TASK-287): a scoped veto resets `--mixed`, so keying off
    // the mode would have silently dropped the reason on exactly the path the
    // agent most needs it — refused, a file taken back under it, told nothing.
    // That would have reverted TASK-240 without a single test going red, which
    // is why the two are decoupled here rather than left to drift.
    // See CommitNotifyResult.
    //
    // The veto's machine `code` (e.g. `storage-full`) rides on the same
    // condition: a race's code, if one ever sent one, is not a refusal.
    return {
      parentVersion: input.parentVersion,
      outcome: 'rolled-back',
      ...(resp.recoverable === false ? { rejectionReason: resp.reason } : {}),
      ...(resp.recoverable === false && resp.code !== undefined
        ? { rejectionCode: resp.code }
        : {}),
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
  client: Pick<IpcClient, 'callBinary' | 'callBinaryUpload'>;
  root: string;
  parentVersion: string | null;
  reason: string;
  /** See {@link commitNotifyWithResync}; tests only. */
  maxBundleBytes?: number;
}): Promise<FlushResult> {
  const { client, root, parentVersion, reason } = input;
  const bundle = await commitTurnAndBundle({ root, reason });
  if (bundle === null) {
    commitTrace(`[commit-trace] flushWorkspaceToHost: nothing staged (no-op)\n`);
    return { parentVersion, outcome: 'noop' };
  }
  const result = await commitNotifyWithResync({
    client,
    root,
    bundle,
    parentVersion,
    reason,
    ...(input.maxBundleBytes !== undefined ? { maxBundleBytes: input.maxBundleBytes } : {}),
  });
  return {
    parentVersion: result.parentVersion,
    outcome: result.outcome,
    ...(result.rejectionReason !== undefined
      ? { rejectionReason: result.rejectionReason }
      : {}),
  };
}
