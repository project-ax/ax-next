import {
  PluginError,
  type FileChange,
  type WorkspaceApplyOutput,
  type WorkspaceVersion,
} from '@ax/core';
import type {
  WorkspaceApplyBundleInput,
  WorkspaceApplyBundleOutput,
  WorkspaceExportBaselineBundleInput,
  WorkspaceExportBaselineBundleOutput,
} from '@ax/workspace-bundle-protocol';
import {
  WorkspaceCommitNotifyRequestSchema,
  WorkspaceCommitNotifyResponseSchema,
} from '@ax/ipc-protocol';
import { filterToPolicy } from '../bundler/filter.js';
import { prepareScratchRepo } from '../bundler/scratch.js';
import { verifyBundleAuthor } from '../bundler/verify.js';
import { walkBundleChanges } from '../bundler/walk.js';
import {
  internalError,
  logInternalError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// Pull the re-sync HEAD signal (`actualParent`) out of a parent-mismatch
// PluginError's `cause`. Both backends signal a concurrent-writer advance with
// an `actualParent` on the cause:
//   - multi-replica (@ax/workspace-git-server): mismatch detected at export.
//   - single-replica (@ax/workspace-git-core): mismatch detected at
//     apply-bundle's parent-CAS.
// The runner uses `actualParent` to fetch the baseline bundle out-of-band via
// the binary `workspace.export-baseline-bundle` action (octet-stream, uncapped),
// then rebases its turn and retries. We deliberately DO NOT read any inline
// `baselineBundleBytes` off the cause anymore — inlining the bundle in this
// JSON response blew the runner's 4 MiB cap on aged workspaces (same bug class
// as materialize BUG-W3). The bytes now travel over the dedicated binary action.
function resyncEnvelopeFromCause(cause: unknown): { actualParent?: string } {
  const out: { actualParent?: string } = {};
  if (cause !== null && typeof cause === 'object') {
    const c = cause as Record<string, unknown>;
    if (typeof c.actualParent === 'string') out.actualParent = c.actualParent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST /workspace.commit-notify — the host side of the thin-bundle commit wire.
//
// The runner finishes a turn, bundles `baseline..HEAD` as a thin git bundle, and
// POSTs it here (see @ax/agent-runner-core's `commit-notify-resync.ts` for the
// sender). The host reconstructs the turn in a throwaway scratch repo, verifies
// who authored it, shows the policy-visible slice of the diff to the pre-apply
// validators, and only then asks the workspace backend to land it.
//
// Pipeline:
//   1. Parse + validate the request schema (parentVersion, reason, bundleBytes).
//      The pre-bundle wire shape schema-rejects as 400.
//   2. Empty-bundle short-circuit: the turn wrote nothing → accepted:true
//      against the parentVersion the runner sent. No apply, no subscribers.
//   3. Export the workspace's baseline bundle at `parentVersion` via
//      `workspace:export-baseline-bundle`. No `workspace:list` / `workspace:read`
//      snapshot is involved — the baseline travels as a bundle so the runner's
//      thin bundle's prereq is satisfied by construction. The hook is REQUIRED;
//      the gate right below turns away any backend that doesn't register it.
//   4. prepareScratchRepo: load the baseline bundle + the runner's thin bundle
//      into a one-shot scratch repo. Returns {repoPath, baselineCommit, dispose}.
//   5. verifyBundleAuthor: walk every commit in baseline..HEAD and check author
//      + committer == ax-runner. Reject loud on drift.
//   6. walkBundleChanges: build the canonical FileChange[] for the per-turn diff.
//   7. filterToPolicy: narrow that diff to the policy-visible paths — the
//      `.ax/**` and `.claude/**` prefixes PLUS the root exact paths `CLAUDE.md`
//      and `CLAUDE.local.md`. Validators are policy, and policy covers the
//      agent's own memory plus anything the SDK reads as configuration; ordinary
//      user code is not policy-checked. Source of truth: `workspace-policy.ts`
//      in @ax/core.
//   8. fire `workspace:pre-apply` with that filtered set. Subscribers may veto;
//      a veto surfaces as accepted:false (see the veto branch below).
//   9. APPLY via `workspace:apply-bundle`. There is NO `workspace:apply`
//      fallback — apply-bundle and export-baseline-bundle ship together as the
//      Phase 3 backend contract, so step 3's gate stands in for both.
//  10. fire `workspace:applied` with the resulting WorkspaceDelta. Observers
//      only: a veto there is post-fact misuse, and is logged, not honored.
//  11. Dispose the scratch repo (in a `finally`).
//
// Wire response shapes (all HTTP 200 unless noted) — the authoritative
// definition is the discriminated union in @ax/ipc-protocol's `actions.ts`,
// which documents each optional field in more detail than this summary:
//   - accepted → {accepted: true, version, delta: null}
//   - rejected → {accepted: false, reason}, plus — depending on which branch
//     rejected — `actualParent` (the parent-mismatch re-sync signal),
//     `recoverable: false` (the runner must discard the work), and
//     `discardPaths` (scope that discard to named paths — TASK-287).
// The wire NEVER carries the delta payload (Invariant I5 — `WorkspaceDelta`
// carries lazy fetchers that don't survive JSON, and exposing the content set
// across the trust boundary widens the blast radius of a compromised sandbox).
//
// Which failures are 500s and which are 200 accepted:false is NOT uniform, and
// the split is deliberate — the rule is "can the runner do something about it?":
//   - prepareScratchRepo failure → 200 accepted:false ("baseline drift"). The
//     runner can re-sync and retry, so it needs a body, not a 500.
//   - verifyBundleAuthor failure → 200 accepted:false + recoverable:false. The
//     runner must throw the turn away, which is also an instruction, not a 500.
//   - walkBundleChanges failure  → 500. We could not even read the diff, so
//     there is nothing coherent to tell the runner to do.
// All three sanitize before they answer: raw git stderr can echo a temp path or
// a filename that the sandbox has no business seeing. The real diagnostic goes
// to the host log via `logInternalError`.
//
// Test pins live in `__tests__/workspace-commit-notify.test.ts` (schema, backend
// gate, veto + discard scoping) and
// `__tests__/workspace-commit-notify-core-resync.test.ts` (the single-replica
// re-sync path). Neither pins the prose above, and this block has drifted from
// the code more than once — if you change a branch here, re-read it.
// ---------------------------------------------------------------------------

export const workspaceCommitNotifyHandler: ActionHandler = async (
  rawPayload,
  ctx,
  bus,
) => {
  const parsed = WorkspaceCommitNotifyRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`workspace.commit-notify: ${parsed.error.message}`);
  }
  const { parentVersion, reason, bundleBytes } = parsed.data;

  // Empty-bundle short-circuit: the runner observed an empty turn (no
  // commits in baseline..HEAD) and shipped the empty wire shape. No
  // apply needed; the workspace stays at parentVersion.
  if (bundleBytes === '') {
    const body = {
      accepted: true as const,
      // Preserve the parentVersion the runner sent. The runner's local
      // baseline ref is still pinned at this version, so subsequent
      // turns will line up.
      version: (parentVersion ?? '') as WorkspaceVersion,
      delta: null,
    };
    const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
    if (!checked.success) {
      logInternalError(
        ctx.logger,
        'workspace.commit-notify',
        new Error(`response shape drift (empty-bundle): ${checked.error.message}`),
      );
      return internalError();
    }
    return { status: 200, body: checked.data };
  }

  const parent = (parentVersion as WorkspaceVersion | null) ?? null;

  // Get the workspace's baseline bundle. The workspace plugin (e.g.,
  // workspace-git-server) bundles its mirror cache state at `parent`;
  // we load it into our scratch repo so the runner's thin bundle's
  // prereq is satisfied by construction.
  //
  // PHASE 3 BACKEND CONTRACT: any workspace backend participating in
  // the bundle wire MUST register `workspace:export-baseline-bundle`.
  // Without it, the host can't load the runner's thin bundle on top
  // of the prior workspace state — there's no way to reconstruct the
  // prior turn's actual commit OID (it had real wall-clock timestamps
  // from the runner side).
  //
  // For the FIRST apply only (parent=null), a deterministic empty-
  // baseline reconstruction would work, but we don't take that
  // shortcut: it would let a non-Phase-3 backend appear to work for
  // turn 1 then break loudly on turn 2 (worst kind of silent
  // regression). Reject up front.
  if (!bus.hasService('workspace:export-baseline-bundle')) {
    logInternalError(
      ctx.logger,
      'workspace.commit-notify',
      new Error(
        'no registered workspace plugin implements workspace:export-baseline-bundle (Phase 3 thin-bundle wire requires it; provided by @ax/workspace-git and @ax/workspace-git-server)',
      ),
    );
    return internalError();
  }
  let baselineBundleBytes: string;
  try {
    const out = await bus.call<
      WorkspaceExportBaselineBundleInput,
      WorkspaceExportBaselineBundleOutput
    >('workspace:export-baseline-bundle', ctx, { version: parent });
    baselineBundleBytes = out.bundleBytes;
  } catch (err) {
    // parent-mismatch: a concurrent writer (e.g. the attachments plugin)
    // advanced the mirror past the runner's parent version between the
    // runner's materialize and now. Return accepted:false carrying only the head
    // signal (`actualParent`) alongside the reason — no inline bundle — so the
    // runner can fetch a baseline bundle AT that head out-of-band, rebase, and
    // retry (mirrors the apply-bundle parent-mismatch handling below). Why the
    // bundle is not inlined: see the forwarding note below.
    if (err instanceof PluginError && err.code === 'parent-mismatch') {
      const env = resyncEnvelopeFromCause(err.cause);
      const body: Record<string, unknown> = {
        accepted: false as const,
        reason: `parent-mismatch: ${err.message}`,
      };
      // Forward ONLY the head signal — the baseline bundle is NO LONGER inlined
      // here. The runner fetches it out-of-band at `actualParent` via the binary
      // `workspace.export-baseline-bundle` action (octet-stream, uncapped). The
      // old shape rode the bundle base64-in-JSON, which blew the runner's 4 MiB
      // response cap on aged workspaces (same bug class as materialize BUG-W3) →
      // the re-sync never completed → turn timed out → unknown-token loop.
      // `actualParent` alone is enough: the runner's resync fetch resolves the
      // bytes. Without it, this degrades to a bare veto (runner rolls back).
      if (env.actualParent !== undefined) {
        body.actualParent = env.actualParent;
      }
      const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
      if (!checked.success) {
        logInternalError(
          ctx.logger,
          'workspace.commit-notify',
          new Error(
            `response shape drift (export-baseline parent-mismatch): ${checked.error.message}`,
          ),
        );
        return internalError();
      }
      return { status: 200, body: checked.data };
    }
    logInternalError(ctx.logger, 'workspace.commit-notify', err);
    return internalError();
  }

  // Prepare scratch repo: load baseline bundle + thin bundle.
  let scratch: Awaited<ReturnType<typeof prepareScratchRepo>>;
  try {
    scratch = await prepareScratchRepo({
      bundleBytes,
      baselineBundleBytes,
    });
  } catch (err) {
    // Most failures here mean the runner's bundle's prereq doesn't
    // match the workspace's baseline state (e.g., a concurrent writer
    // landed something between the runner's snapshot and now).
    // Surface as accepted:false so the runner can take recovery
    // action; sanitize the message.
    logInternalError(ctx.logger, 'workspace.commit-notify', err);
    const body = {
      accepted: false as const,
      reason: 'bundle prerequisite not satisfied (baseline drift)',
    };
    const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
    if (!checked.success) return internalError();
    return { status: 200, body: checked.data };
  }

  try {
    // Verify bundle authorship before showing changes to anyone.
    try {
      await verifyBundleAuthor({
        repoPath: scratch.repoPath,
        baselineCommit: scratch.baselineCommit,
      });
    } catch (err) {
      // Authorship failure is a security signal — the runner's pod-spec
      // env was bypassed or the bundle was tampered with. Reject loud,
      // but sanitize the wire response (the err message includes the
      // commit OID + offending name, which is host-internal).
      logInternalError(
        ctx.logger,
        'workspace.commit-notify',
        err,
      );
      const body = {
        accepted: false as const,
        reason: 'bundle author verification failed',
        // A tampered / bypassed-env bundle is not recoverable agent work — the
        // runner discards it with --hard.
        //
        // Deliberately NOT scoped with `discardPaths` (TASK-287), unlike the
        // pre-apply veto below. There is no trustworthy path set to name here:
        // we could not establish who authored the bundle, so nothing it claims
        // to contain can be believed, and "keep the rest" is not a coherent
        // offer. This branch keeps the whole-tree reset on purpose.
        recoverable: false as const,
      };
      const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
      if (!checked.success) return internalError();
      return { status: 200, body: checked.data };
    }

    // Walk the bundle's per-turn diff into FileChange[].
    let allChanges: FileChange[];
    try {
      allChanges = await walkBundleChanges({
        repoPath: scratch.repoPath,
        baselineCommit: scratch.baselineCommit,
      });
    } catch (err) {
      logInternalError(ctx.logger, 'workspace.commit-notify', err);
      return internalError();
    }

    // Filter to policy-visible paths for the pre-apply hook — the `.ax/**` and
    // `.claude/**` prefixes PLUS the root exact paths (`CLAUDE.md`,
    // `CLAUDE.local.md`), which is the pair that catches the ordinary
    // agent-writes-CLAUDE.md case. See POLICY_EXACT_PATHS in @ax/core.
    // Subscribers — @ax/validator-skill's SDK-config veto,
    // @ax/validator-identity, and @ax/validator-routine — see ONLY
    // agent-managed memory and SDK setting-source paths; user-code changes are
    // not policy-checked.
    const policyChanges = filterToPolicy(allChanges);

    // ---- pre-apply: subscribers can transform or veto ----
    const pre = await bus.fire<{
      changes: FileChange[];
      parent: WorkspaceVersion | null;
      reason: string;
    }>(
      'workspace:pre-apply',
      ctx,
      { changes: policyChanges, parent, reason },
    );
    if (pre.rejected) {
      // Three plugins reject on `workspace:pre-apply`: @ax/validator-skill's
      // SDK-config veto, @ax/validator-identity, and @ax/validator-routine.
      //
      // validator-skill's SKILL.md *content* scan is NOT a fourth: TASK-74 took
      // it off `workspace:pre-apply` altogether and moved it to the
      // `skills:scan` service, called from the authoring chokepoint, where it is
      // accept-but-annotate (a quarantined skill is inert until promoted). The
      // SDK-config veto is the only thing that plugin still rejects here.
      //
      // `recoverable: false` is unconditional on this branch, so the vetoed
      // write must not survive into the next turn: the runner re-stages its
      // whole tree every turn, so a preserved refused file would be
      // re-submitted and re-refused forever — the agent wedges (B1).
      //
      // TASK-287 bounds the collateral of that rule without loosening it. A
      // rejecter that knows WHICH path offended says so via
      // `Rejection.offendingPaths`; we hand those to the runner as
      // `discardPaths`, and it undoes exactly those instead of resetting the
      // whole tree (reverting each to its baseline state, or deleting it when
      // the baseline had no such file). The wedge is then answered by
      // construction — the refused content is gone, so the next turn's
      // re-stage cannot re-submit it — while everything else the agent wrote
      // (this turn AND every earlier turn still sitting above the last
      // accepted baseline) survives.
      //
      // We only forward paths that were actually in the batch we sent. A
      // subscriber is plugin code, and this field decides which files get
      // taken back off the agent in the sandbox; an unrecognised path means we
      // have lost track of what the veto is about, so we fail CLOSED to the
      // whole-tree reset rather than act on it.
      //
      // Log the reason on the way out. Of the three rejecters only
      // @ax/validator-identity logs its own vetoes, and it logs the offending
      // path (plus a scan category), never the reason text — so without this
      // line the host discards a turn's work with no account of why.
      const changedPaths = new Set(policyChanges.map((c) => c.path));
      const named = pre.offendingPaths ?? [];
      const discardPaths = named.filter((p) => changedPaths.has(p));
      const scoped = named.length > 0 && discardPaths.length === named.length;
      if (named.length > 0 && !scoped) {
        ctx.logger.warn('workspace_pre_apply_discard_paths_unrecognized', {
          action: 'workspace.commit-notify',
          rejectedBy: pre.source ?? 'unknown',
          // The paths themselves, not just a count: this fires when a
          // subscriber names something outside the batch, and the whole point
          // of the log line is being able to see which one.
          unrecognized: named.filter((p) => !changedPaths.has(p)),
        });
      }
      ctx.logger.warn('workspace_pre_apply_rejected', {
        action: 'workspace.commit-notify',
        rejectedBy: pre.source ?? 'unknown',
        reason: pre.reason,
        scoped,
      });
      const body = {
        accepted: false as const,
        reason: pre.reason,
        recoverable: false as const,
        ...(scoped ? { discardPaths } : {}),
      };
      const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
      if (!checked.success) {
        logInternalError(
          ctx.logger,
          'workspace.commit-notify',
          new Error(`response shape drift (rejected): ${checked.error.message}`),
        );
        return internalError();
      }
      return { status: 200, body: checked.data };
    }

    // ---- apply: workspace:apply-bundle is required (the export-
    //      baseline-bundle gate above already rejected backends that
    //      don't implement the bundle wire — apply-bundle and export-
    //      baseline-bundle ship together as the Phase 3 backend
    //      contract).
    let applied: WorkspaceApplyOutput;
    try {
      const out = await bus.call<
        WorkspaceApplyBundleInput,
        WorkspaceApplyBundleOutput
      >('workspace:apply-bundle', ctx, {
        bundleBytes,
        baselineCommit: scratch.baselineCommit,
        parent,
        reason,
      });
      applied = out;
    } catch (err) {
      if (err instanceof PluginError && err.code === 'parent-mismatch') {
        // A concurrent writer advanced the mirror past the runner's parent. On
        // the multi-replica backend the mismatch surfaces earlier (at export)
        // WITH actualParent; on the single-replica backend it surfaces HERE.
        // Either way we forward ONLY the head signal — the runner fetches the
        // baseline bundle AT `actualParent` out-of-band via the binary
        // `workspace.export-baseline-bundle` action (octet-stream, uncapped),
        // rebases, and retries. The bundle is NO LONGER inlined here (it blew
        // the runner's 4 MiB JSON response cap on aged workspaces — same bug
        // class as materialize BUG-W3). If `actualParent` advanced AGAIN before
        // the runner's fetch lands, that fetch 500s and the runner re-syncs
        // from a fresh materialize — no need to chase the head here.
        const env = resyncEnvelopeFromCause(err.cause);
        const body: Record<string, unknown> = {
          accepted: false as const,
          reason: `parent-mismatch: ${err.message}`,
        };
        if (env.actualParent !== undefined) {
          body.actualParent = env.actualParent;
        }
        const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
        if (!checked.success) {
          logInternalError(
            ctx.logger,
            'workspace.commit-notify',
            new Error(
              `response shape drift (apply-bundle parent-mismatch): ${checked.error.message}`,
            ),
          );
          return internalError();
        }
        return { status: 200, body: checked.data };
      }
      // Other errors bubble to the dispatcher's catch-all (sanitized 500).
      throw err;
    }

    // ---- applied: observers (audit, canary, future analytics) get
    // the host-side delta with its lazy fetchers intact. ----
    const post = await bus.fire('workspace:applied', ctx, applied.delta);
    if (post.rejected) {
      // workspace:applied is post-fact — a "rejection" here means a
      // subscriber tried to veto something already landed. Treat as
      // misuse: log the reason but DO NOT fail the request. The
      // workspace already mutated; returning 500 here would tell the
      // runner the turn failed and force a parent-mismatch on the
      // next turn (the runner's local baseline would be behind the
      // storage tier's HEAD). Observe-only hooks must stay observe-
      // only.
      logInternalError(
        ctx.logger,
        'workspace.commit-notify',
        new Error(
          `workspace:applied subscriber rejected post-fact (ignored — apply already landed): ${post.reason}`,
        ),
      );
    }

    const body = {
      accepted: true as const,
      version: applied.version as string,
      delta: null,
    };
    const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
    if (!checked.success) {
      logInternalError(
        ctx.logger,
        'workspace.commit-notify',
        new Error(`response shape drift (accepted): ${checked.error.message}`),
      );
      return internalError();
    }
    return { status: 200, body: checked.data };
  } finally {
    await scratch.dispose();
  }
};
