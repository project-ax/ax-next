import {
  WorkspaceCommitNotifyRequestSchema,
  WorkspaceCommitNotifyResponseSchema,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /workspace.commit-notify
//
// Phase 3 wire change LANDED, real implementation PENDING.
//
// HALF-WIRED WINDOW STATUS:
//   This commit (Slice 5) flips the wire schema from `{commitRef, message,
//   changes}` to `{parentVersion, reason, bundleBytes}`. The runner is
//   not yet shipping bundles (that's Slice 7), and the host bundler that
//   unpacks them isn't built yet (that's Slice 6). This handler returns
//   `{accepted: false, reason: 'bundle-wire-not-implemented'}` to make the
//   gap explicit — no silent successes, no silent storage corruption.
//
//   The window CLOSES when Slice 6 ships the real bundler (replacing this
//   stub) and Slice 7 ships the runner sender. Both are required before
//   this PR can land.
//
// TODO(phase-3-S6): replace with the real bundler-driven handler.
// ---------------------------------------------------------------------------

export const workspaceCommitNotifyHandler: ActionHandler = async (
  rawPayload,
  ctx,
  _bus,
) => {
  const parsed = WorkspaceCommitNotifyRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`workspace.commit-notify: ${parsed.error.message}`);
  }

  // Loud diagnostic so a runtime that hits this stub during the half-
  // wired window leaves a fingerprint in host logs. Disappears with
  // Slice 6.
  ctx.logger.error('workspace_commit_notify_stub', {
    msg: 'bundle wire not yet implemented (Phase 3 half-wired window — Slice 5 → Slice 6)',
    parentVersion: parsed.data.parentVersion,
    reason: parsed.data.reason,
    bundleBytesLength: parsed.data.bundleBytes.length,
  });

  const body = {
    accepted: false as const,
    reason: 'bundle-wire-not-implemented',
  };
  const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'workspace.commit-notify',
      new Error(`response shape drift (stub): ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
