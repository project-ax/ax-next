import {
  PluginError,
  type FileChange,
  type WorkspaceApplyBundleInput,
  type WorkspaceApplyBundleOutput,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceExportBaselineBundleInput,
  type WorkspaceExportBaselineBundleOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceVersion,
} from '@ax/core';
import {
  WorkspaceCommitNotifyRequestSchema,
  WorkspaceCommitNotifyResponseSchema,
} from '@ax/ipc-protocol';
import { filterToAx } from '../bundler/filter.js';
import { prepareScratchRepo } from '../bundler/scratch.js';
import { verifyBundleAuthor } from '../bundler/verify.js';
import { walkBundleChanges } from '../bundler/walk.js';
import {
  internalError,
  logInternalError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /workspace.commit-notify (Phase 3 — real implementation, Slice 6d)
//
// HALF-WIRED WINDOW PARTIALLY CLOSES HERE. Closes fully when Slice 7
// ships the runner sender (the runner currently still calls with the
// legacy commit-notify shape, which now schema-rejects as 400 — by
// design; the half-wired window is closed within this PR by S7).
//
// Pipeline:
//   1. Parse + validate request schema (parentVersion, reason,
//      bundleBytes).
//   2. Empty-bundle short-circuit: turn wrote nothing → accepted: true
//      against the existing parentVersion. No apply, no subscribers.
//   3. Snapshot the workspace at `parentVersion` via workspace:list +
//      workspace:read. This is the baseline state the deterministic
//      reconstructor needs.
//   4. prepareScratchRepo: rebuild deterministic baseline + load thin
//      bundle into a one-shot scratch repo. Returns
//      {repoPath, baselineCommit, dispose}.
//   5. verifyBundleAuthor: walk every commit in baseline..HEAD and
//      check author + committer == ax-runner. Reject loud on drift.
//   6. walkBundleChanges: build canonical FileChange[] for the per-turn
//      diff. This is what subscribers see.
//   7. filter to .ax/** for the pre-apply hook (subscribers only see
//      agent-managed memory; user code paths are not policy-checked).
//   8. fire workspace:pre-apply with the .ax-filtered changes.
//      Subscribers may reject; surface as accepted:false.
//   9. APPLY: prefer workspace:apply-bundle if registered (direct path,
//      no rehash). Fall back to workspace:apply(FileChange[]) for
//      backends that don't implement bundle apply.
//  10. fire workspace:applied with the resulting WorkspaceDelta.
//  11. Dispose the scratch repo.
//
// Response shape: same as today — {accepted: true, version, delta:null}
// or {accepted: false, reason}. Wire NEVER carries the delta payload
// (Invariant I5 — `WorkspaceDelta` carries lazy fetchers that don't
// survive JSON, and exposing the content set across the trust boundary
// widens the blast radius of a compromised sandbox).
//
// Error sanitization: bundler failures (verifier rejection, walk
// errors, prepareScratchRepo errors) get sanitized to 500. The
// underlying git stderr can echo a temp path or filename, neither of
// which the sandbox should see in an error envelope. Real diagnostic
// goes to the host log via `logInternalError`.
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
  // prereq is satisfied by construction. This replaces the earlier
  // deterministic-reconstruction approach (which only worked for
  // first apply — for subsequent applies the runner's baseline is
  // the actual prior-turn commit OID, which has real timestamps and
  // doesn't reproduce deterministically).
  //
  // FALLBACK PATH (workspace:export-baseline-bundle not registered):
  // we fall back to the workspace:list/read reconstruction approach.
  // That only handles first apply correctly; subsequent applies will
  // fail with a baseline-drift error. Non-bundle backends should
  // implement export-baseline-bundle alongside apply-bundle to
  // participate fully.
  let baselineBundleBytes: string;
  try {
    if (bus.hasService('workspace:export-baseline-bundle')) {
      const out = await bus.call<
        WorkspaceExportBaselineBundleInput,
        WorkspaceExportBaselineBundleOutput
      >('workspace:export-baseline-bundle', ctx, { version: parent });
      baselineBundleBytes = out.bundleBytes;
    } else {
      // Fallback: synthesize a baseline bundle from list+read using
      // the deterministic helper (only correct for first apply).
      const listInput: WorkspaceListInput =
        parent !== null ? { version: parent } : {};
      const listed = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        ctx,
        listInput,
      );
      const baselineFiles: Array<{ path: string; bytes: Buffer }> = [];
      for (const path of listed.paths) {
        const readInput: WorkspaceReadInput =
          parent !== null ? { path, version: parent } : { path };
        const r = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
          'workspace:read',
          ctx,
          readInput,
        );
        if (r.found) {
          baselineFiles.push({ path, bytes: Buffer.from(r.bytes) });
        }
      }
      // Lazy-import to avoid a circular import at module load — the
      // materialize handler imports prepareScratchRepo from the same
      // bundler module via a different path. Build the deterministic
      // bundle inline.
      const { buildBaselineBundle } = await import('./workspace-materialize.js');
      baselineBundleBytes = await buildBaselineBundle({
        paths: baselineFiles.map((f) => f.path),
        read: async (p) => {
          const f = baselineFiles.find((x) => x.path === p);
          return f === undefined ? null : f.bytes;
        },
      });
    }
  } catch (err) {
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

    // Filter to .ax/** for the pre-apply hook. Subscribers (skill
    // validator, future identity validator) only see agent-managed
    // memory; user-code changes are not policy-checked.
    const axChanges = filterToAx(allChanges);

    // ---- pre-apply: subscribers can transform or veto ----
    const pre = await bus.fire<{
      changes: FileChange[];
      parent: WorkspaceVersion | null;
      reason: string;
    }>(
      'workspace:pre-apply',
      ctx,
      { changes: axChanges, parent, reason },
    );
    if (pre.rejected) {
      const body = { accepted: false as const, reason: pre.reason };
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

    // ---- apply: prefer apply-bundle (direct path, no rehash) ----
    let applied: WorkspaceApplyOutput;
    try {
      if (bus.hasService('workspace:apply-bundle')) {
        // Bundle-aware backend (workspace-git-server). Pass the bundle
        // bytes + the prereq OID directly; the backend git-fetches
        // into its mirror cache + pushes to the storage tier. Bare
        // repo OID chain == runner's chain.
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
      } else {
        // Fallback: backends that don't implement apply-bundle (e.g.,
        // a future GCS-backed plugin) get the FileChange[] path. Same
        // changes the bundler walked, just routed through the legacy
        // hash-and-commit pipeline.
        applied = await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply',
          ctx,
          {
            changes: allChanges,
            parent,
            reason,
          },
        );
      }
    } catch (err) {
      if (err instanceof PluginError && err.code === 'parent-mismatch') {
        const body = {
          accepted: false as const,
          reason: `parent-mismatch: ${err.message}`,
        };
        const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
        if (!checked.success) {
          logInternalError(
            ctx.logger,
            'workspace.commit-notify',
            new Error(
              `response shape drift (parent-mismatch): ${checked.error.message}`,
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
      // misuse and 500 (sanitized). Log the reason for debugging.
      logInternalError(
        ctx.logger,
        'workspace.commit-notify',
        new Error(
          `workspace:applied subscriber rejected post-fact: ${post.reason}`,
        ),
      );
      return internalError();
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
